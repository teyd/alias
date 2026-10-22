import * as Arr from "effect/Array";
import { Base64 } from "effect/encoding";
import type { LineEnding } from "./headers.ts";
import { utf8 } from "./bytes.ts";

/** RFC 5322 §2.1.1: lines SHOULD stay within 78 characters. */
const MAX_LINE = 78;
/**
 * 42 bytes are 56 base64 characters, a 68-character encoded-word: under RFC 2047's 75, and short
 * enough that `Reply-To: ` plus one word still fits a 78-character line.
 */
const WORD_BYTES = 42;
const MAX_NAME_CODE_POINTS = 128;

/**
 * Control characters could break the header or inject lines; bidi controls could reorder
 * what the reader sees, making `(sender@x)` look like part of someone else's name.
 */
const UNSAFE = /[\p{Cc}\p{Bidi_Control}]/gu;

/** Makes untrusted text safe to show as a display name: one line, no reordering, bounded. */
export const sanitize = (text: string): string => {
  const cleaned = text.replace(UNSAFE, " ").replace(/\s+/gu, " ").trim();
  const codePoints = Array.from(cleaned);
  return codePoints.length > MAX_NAME_CODE_POINTS
    ? `${codePoints.slice(0, MAX_NAME_CODE_POINTS - 1).join("")}…`
    : cleaned;
};

/** Printable ASCII that a client cannot mistake for an encoded-word. */
const isPlainAscii = (text: string) => /^[\x20-\x7e]*$/.test(text) && !text.includes("=?");

const quote = (text: string) => `"${text.replace(/[\\"]/g, "\\$&")}"`;

/**
 * RFC 2047 B-encoded words, split between code points so no word ends inside a UTF-8
 * sequence (§5 rule 3).
 */
const encodedWords = (text: string): ReadonlyArray<string> =>
  Arr.map(
    Arr.reduce(Array.from(text), Arr.empty<string>(), (chunks, char) =>
      Arr.matchRight(chunks, {
        onEmpty: () => [char],
        onNonEmpty: (init, last) =>
          utf8(last + char).length <= WORD_BYTES ? [...init, last + char] : [...chunks, char],
      }),
    ),
    (chunk) => `=?UTF-8?B?${Base64.encode(utf8(chunk))}?=`,
  );

/**
 * A complete `name: display <address>` field, folded at whitespace to stay within 78
 * characters where it can. The display name is quoted when it is short printable ASCII and
 * encoded-words otherwise.
 */
export const mailboxField = (
  name: string,
  display: string,
  address: string,
  lineEnding: LineEnding,
): string => {
  const quoted = quote(display);
  const phrase =
    isPlainAscii(display) && name.length + 2 + quoted.length <= MAX_LINE
      ? [quoted]
      : encodedWords(display);
  return Arr.reduce(
    [...phrase, `<${address}>`],
    { text: `${name}:`, column: name.length + 1, isLineStart: true },
    (line, token) =>
      !line.isLineStart && line.column + 1 + token.length > MAX_LINE
        ? {
            text: `${line.text}${lineEnding} ${token}`,
            column: 1 + token.length,
            isLineStart: false,
          }
        : {
            text: `${line.text} ${token}`,
            column: line.column + 1 + token.length,
            isLineStart: false,
          },
  ).text;
};
