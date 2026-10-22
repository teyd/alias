import * as Arr from "effect/Array";
import { Base64 } from "effect/encoding";
import * as Result from "effect/Result";
import * as Str from "effect/String";

/** Test-side reader for what the rewrite produces: an independent, deliberately simple parser. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const bytes = (text: string): Uint8Array => encoder.encode(text);

/** One char per byte, so any byte sequence can be inspected as text. */
export const binary = (data: Uint8Array): string =>
  Array.from(data, (byte) => String.fromCharCode(byte)).join("");

export interface Field {
  readonly name: string;
  readonly value: string;
}

/** The header block (unfolded) and the bytes after it (blank line included). */
export const split = (data: Uint8Array) => {
  const text = binary(data);
  const match = /\r?\n\r?\n/.exec(text);
  const end = match === null ? text.length : match.index + (match[0].startsWith("\r") ? 2 : 1);
  const fields = Arr.map(
    text
      .slice(0, end)
      .replace(/\r?\n[ \t]/g, " ")
      .split(/\r?\n/)
      .filter(Str.isNonEmpty),
    (line): Field => {
      const colon = line.indexOf(":");
      return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
    },
  );
  return { fields, rest: data.subarray(end), headerText: text.slice(0, end) };
};

export const values = (data: Uint8Array, name: string): ReadonlyArray<string> =>
  Arr.map(
    Arr.filter(split(data).fields, (field) => field.name.toLowerCase() === name.toLowerCase()),
    (field) => field.value,
  );

/** Decodes `display <address>`, where display is a quoted-string or RFC 2047 B-words. */
export const mailbox = (value: string) => {
  const match = /^(.*)\s<([^>]*)>$/.exec(value);
  if (match === null) throw new Error(`not a mailbox: ${value}`);
  const phrase = match[1] ?? "";
  const display = phrase.startsWith('"')
    ? phrase.slice(1, -1).replace(/\\(.)/g, "$1")
    : decoder.decode(
        new Uint8Array(
          phrase.split(/\s+/).flatMap((word) => {
            const encoded = /^=\?UTF-8\?B\?([^?]*)\?=$/.exec(word);
            if (encoded === null) throw new Error(`not an encoded-word: ${word}`);
            return Result.match(Base64.decode(encoded[1] ?? ""), {
              onFailure: (error) => {
                throw error;
              },
              onSuccess: (decoded) => Array.from(decoded),
            });
          }),
        ),
      );
  return { display, address: match[2] ?? "" };
};
