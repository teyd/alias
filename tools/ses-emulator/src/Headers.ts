import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { SesEvent } from "@alias/aws";

export interface Header {
  readonly name: string;
  readonly value: string;
}

/** Splits a raw RFC 5322 message into its unfolded header fields (original names and order). */
export const parseHeaders = (raw: string): ReadonlyArray<Header> => {
  const end = raw.search(/\r?\n\r?\n/);
  const block = end === -1 ? raw : raw.slice(0, end);
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  return Arr.flatMap(unfolded.split(/\r?\n/), (line) => {
    const colon = line.indexOf(":");
    return colon <= 0
      ? []
      : [{ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() }];
  });
};

/** Splits an address list on commas that are not inside a quoted display name. */
const splitAddresses = (value: string): ReadonlyArray<string> =>
  Arr.filter(
    Arr.map(value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/), (part) => part.trim()),
    Str.isNonEmpty,
  );

const first = (headers: ReadonlyArray<Header>, name: string): Option.Option<string> =>
  Option.map(
    Arr.findFirst(headers, (header) => header.name.toLowerCase() === name.toLowerCase()),
    (header) => header.value,
  );

/** The `commonHeaders` object SES derives from the message headers. */
export const commonHeaders = (
  headers: ReadonlyArray<Header>,
  returnPath: string,
): SesEvent.SesMail["commonHeaders"] => {
  const optional = <A>(key: string, value: Option.Option<A>) =>
    Option.match(value, { onNone: () => ({}), onSome: (present) => ({ [key]: present }) });
  return {
    returnPath,
    ...optional("from", Option.map(first(headers, "From"), splitAddresses)),
    ...optional("to", Option.map(first(headers, "To"), splitAddresses)),
    ...optional("date", first(headers, "Date")),
    ...optional("messageId", first(headers, "Message-ID")),
    ...optional("subject", first(headers, "Subject")),
  };
};
