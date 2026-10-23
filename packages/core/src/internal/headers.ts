import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { concat, utf8 } from "./bytes.ts";

/**
 * Header-level access to a raw RFC 5322 message, without decoding it.
 *
 * Fields are kept as byte ranges of the original message, folding and all. Rewriting drops
 * some of them and prepends new ones; everything else, including the blank line and the body,
 * is copied byte for byte. Nothing goes through a text decoder, so 8-bit headers (RFC 6532),
 * odd charsets and binary MIME parts survive unchanged.
 */

class MalformedMessage extends Schema.TaggedError<MalformedMessage>()("MalformedMessage", {
  reason: Schema.String,
}) {}

export type LineEnding = "\r\n" | "\n";

export interface Field {
  /** Lowercased field name, for matching. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface Message {
  readonly fields: ReadonlyArray<Field>;
  /** Everything after the header fields: the blank line and the body, untouched. */
  readonly rest: Uint8Array;
  /** Taken from the first line, so new fields match the message's own style. */
  readonly lineEnding: LineEnding;
}

const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const HT = 0x09;
const COLON = 0x3a;
/** RFC 5322 §2.1.1 line limit; a field name is looked for only this far into a line. */
const MAX_LINE = 998;
/** RFC 5322 ftext: printable US-ASCII except the colon. */
const FIELD_NAME = /^[!-9;-~]+$/;

interface Line {
  readonly start: number;
  readonly end: number;
}

const isBlankLine = (raw: Uint8Array, start: number) =>
  raw[start] === LF || (raw[start] === CR && raw[start + 1] === LF);

/** The header lines, up to (not including) the blank line or the end of the message. */
const headerLines = (raw: Uint8Array): ReadonlyArray<Line> =>
  Arr.unfold(0, (start) => {
    if (start >= raw.length || isBlankLine(raw, start)) return Option.none();
    const lf = raw.indexOf(LF, start);
    const end = lf === -1 ? raw.length : lf + 1;
    return Option.some([{ start, end }, end] as const);
  });

const isContinuation = (raw: Uint8Array, line: Line) =>
  raw[line.start] === SP || raw[line.start] === HT;

/** The field name, or none when the line is neither a field nor a continuation. */
const fieldName = (raw: Uint8Array, line: Line): Option.Option<string> => {
  const colon = raw.subarray(line.start, Math.min(line.end, line.start + MAX_LINE)).indexOf(COLON);
  if (colon <= 0) return Option.none();
  // obs-optional (RFC 5322 §4.5.3) allows whitespace between the name and the colon.
  const name = String.fromCharCode(...raw.subarray(line.start, line.start + colon)).replace(
    /[ \t]+$/,
    "",
  );
  return FIELD_NAME.test(name) ? Option.some(name.toLowerCase()) : Option.none();
};

export const parse = Effect.fn("Headers.parse")(function* (raw: Uint8Array) {
  const lines = headerLines(raw);
  const headerEnd = Option.match(Arr.last(lines), { onNone: () => 0, onSome: (line) => line.end });
  const starts = Arr.filter(
    Arr.map(lines, (line, index) => ({ line, index })),
    ({ line }) => !isContinuation(raw, line),
  ).map(({ line, index }) => ({ index, name: fieldName(raw, line) }));
  if (!Arr.head(starts).pipe(Option.exists((start) => start.index === 0))) {
    return yield* new MalformedMessage({ reason: "no header fields" });
  }
  if (Arr.some(starts, (start) => Option.isNone(start.name))) {
    return yield* new MalformedMessage({ reason: "header line without a field name" });
  }
  const fields = Arr.map(starts, (start, i): Field => {
    const begin = lines[start.index]?.start ?? 0;
    const end = Option.match(Arr.get(starts, i + 1), {
      onNone: () => headerEnd,
      onSome: (next) => lines[next.index]?.start ?? headerEnd,
    });
    return { name: Option.getOrElse(start.name, () => ""), bytes: raw.subarray(begin, end) };
  });
  const firstLf = raw.indexOf(LF);
  const lineEnding: LineEnding = firstLf > 0 && raw[firstLf - 1] !== CR ? "\n" : "\r\n";
  const message: Message = { fields, rest: raw.subarray(headerEnd), lineEnding };
  return message;
});

const latin1 = new TextDecoder("latin1");

/**
 * A field's value: the text after the colon, unfolded and trimmed. Bytes are read one char
 * each, which is exact for the ASCII tokens callers compare against.
 */
export const value = (field: Field): string => {
  const text = latin1.decode(field.bytes);
  return text
    .slice(text.indexOf(":") + 1)
    .replace(/\r?\n(?=[ \t])/g, "")
    .trim();
};

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A field's value as text: UTF-8 when it is valid UTF-8 (RFC 6532 allows raw UTF-8 headers),
 * otherwise one char per byte. Unfolded and trimmed; encoded-words are left to the caller.
 */
export const text = (field: Field): string => {
  const decoded = Option.getOrElse(
    Option.liftThrowable(() => strictUtf8.decode(field.bytes))(),
    () => latin1.decode(field.bytes),
  );
  return decoded
    .slice(decoded.indexOf(":") + 1)
    .replace(/\r?\n(?=[ \t])/g, "")
    .trim();
};

/** The values of every field called `name` (case-insensitive), in order. */
export const values = (message: Message, name: string): ReadonlyArray<string> =>
  Arr.map(
    Arr.filter(message.fields, (field) => field.name === name.toLowerCase()),
    value,
  );

/**
 * Drops the fields `isRemoved` matches, puts `prepend` (complete fields without their line
 * ending) in front, and keeps every other byte as it was.
 */
export const rewrite = (
  message: Message,
  isRemoved: (field: Field) => boolean,
  prepend: ReadonlyArray<string>,
): Uint8Array =>
  concat([
    ...Arr.map(prepend, (field) => utf8(`${field}${message.lineEnding}`)),
    ...Arr.filter(message.fields, (field) => !isRemoved(field)).map((field) => field.bytes),
    message.rest,
  ]);
