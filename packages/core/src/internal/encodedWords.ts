import { Base64 } from "effect/encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

/**
 * RFC 2047 encoded-words (`=?charset?B|Q?text?=`) in a display name, decoded for display. A word
 * in an unknown charset or with broken encoding stays as written, so nothing is lost or invented.
 */
const ENCODED_WORD = /=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi;
/** §6.2: whitespace between two adjacent encoded-words is not displayed. */
const BETWEEN_WORDS = /(\?=)\s+(?==\?)/g;

const qBytes = (text: string): Option.Option<Uint8Array> => {
  const unescaped = text.replaceAll("_", " ");
  if (/=(?![0-9a-f]{2})/i.test(unescaped)) return Option.none();
  return Option.some(
    Uint8Array.from(unescaped.match(/=[0-9a-f]{2}|[^=]/gi) ?? [], (token) =>
      token.length === 3 ? Number.parseInt(token.slice(1), 16) : token.charCodeAt(0),
    ),
  );
};

const bBytes = (text: string): Option.Option<Uint8Array> =>
  Result.match(Base64.decode(text), {
    onFailure: () => Option.none(),
    onSuccess: (bytes) => Option.some(Uint8Array.from(bytes)),
  });

/** RFC 2231 allows a language suffix (`utf-8*en`); TextDecoder only knows the charset. */
const decoder = (charset: string) =>
  Option.liftThrowable(() => new TextDecoder(charset.split("*")[0] ?? charset, { fatal: true }))();

const decodeWord = (word: string, charset: string, encoding: string, text: string): string =>
  Option.all({
    decoder: decoder(charset),
    bytes: encoding.toLowerCase() === "q" ? qBytes(text) : bBytes(text),
  }).pipe(
    Option.flatMap(({ decoder, bytes }) => Option.liftThrowable(() => decoder.decode(bytes))()),
    Option.getOrElse(() => word),
  );

export const decode = (text: string): string =>
  text.replace(BETWEEN_WORDS, "$1").replace(ENCODED_WORD, decodeWord);
