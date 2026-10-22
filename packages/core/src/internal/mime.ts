import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { concat, fromBinary, toBinary } from "./bytes.ts";
import * as Headers from "./headers.ts";

/**
 * A MIME walk (RFC 2045/2046) that rewrites the text of `text/plain` and `text/html` parts and
 * copies every other byte: headers, preambles, boundaries, attachments, and text parts the
 * rewrite leaves alone. A part that changes is re-encoded with its own transfer encoding, so its
 * headers stay valid.
 */

/** A text part's decoded content, as a byte string (`toBinary`), and how to read it. */
export interface TextPart {
  readonly subtype: "plain" | "html";
  /** Lowercased, `us-ascii` when absent (RFC 2046 §4.1.2). */
  readonly charset: string;
  /** The content after undoing the transfer encoding, one char per byte. */
  readonly content: string;
}

/** Returns the new content, or none to keep the part exactly as it was. */
export type Rewrite<E = never, R = never> = (
  part: TextPart,
) => Effect.Effect<Option.Option<string>, E, R>;

export interface ContentType {
  readonly type: string;
  readonly subtype: string;
  readonly parameters: R.ReadonlyRecord<string, string>;
}

/** `type/subtype; name=value; name="quoted value"`, names lowercased. */
export const parseContentType = (value: string): ContentType => {
  const [media = "", ...rest] = value.match(/(?:[^;"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
  const [type = "", subtype = ""] = media.trim().toLowerCase().split("/");
  const parameters = R.fromEntries(
    Arr.flatMap(rest, (parameter) => {
      const equals = parameter.indexOf("=");
      if (equals <= 0) return [];
      const raw = parameter.slice(equals + 1).trim();
      const unquoted =
        raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
          ? raw.slice(1, -1).replace(/\\(.)/g, "$1")
          : raw;
      return [[parameter.slice(0, equals).trim().toLowerCase(), unquoted] as const];
    }),
  );
  return { type: type.trim(), subtype: subtype.trim(), parameters };
};

export const DEFAULT_TYPE: ContentType = { type: "text", subtype: "plain", parameters: {} };

export const first = (message: Headers.Message, name: string): Option.Option<string> =>
  Arr.head(Headers.values(message, name));

// Transfer encodings (RFC 2045 §6). Content is handled as byte strings throughout.

// The lookbehind starts a match only where a run of whitespace starts, so a long run is scanned
// once, not once per character (quadratic on attacker-chosen mail, PLAN.md §20.25).
const decodeQuotedPrintable = (text: string): string =>
  text
    .replace(/(?<![ \t])[ \t]+(?=\r?\n|$)/g, "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );

/** RFC 2045 §6.7: at most 76 characters per line, `=` soft breaks, trailing whitespace encoded. */
const MAX_QP_LINE = 76;

const qpLine = (line: string, eol: string): string => {
  const tokens = Arr.map(Array.from(line), (char, index) => {
    const code = char.charCodeAt(0);
    const isTrailingSpace = (char === " " || char === "\t") && index === line.length - 1;
    return char === "=" || code > 126 || (code < 32 && char !== "\t") || isTrailingSpace
      ? `=${code.toString(16).toUpperCase().padStart(2, "0")}`
      : char;
  });
  const wrapped = Arr.reduce(tokens, { done: "", current: "" }, (state, token) =>
    state.current.length + token.length > MAX_QP_LINE - 1
      ? { done: `${state.done}${state.current}=${eol}`, current: token }
      : { done: state.done, current: state.current + token },
  );
  return wrapped.done + wrapped.current;
};

const encodeQuotedPrintable = (text: string, eol: string): string =>
  Arr.map(text.split(/\r?\n/), (line) => qpLine(line, eol)).join(eol);

const decodeBase64 = (text: string): Option.Option<string> =>
  Result.match(Base64.decode(text.replace(/[\s]+/g, "")), {
    onFailure: () => Option.none(),
    onSuccess: (bytes) => Option.some(toBinary(bytes)),
  });

const MAX_BASE64_LINE = 76;

const encodeBase64 = (text: string, eol: string): string =>
  (Base64.encode(fromBinary(text)).match(new RegExp(`.{1,${MAX_BASE64_LINE}}`, "g")) ?? []).join(
    eol,
  );

export interface Codec {
  readonly decode: (body: string) => Option.Option<string>;
  readonly encode: (content: string, eol: string) => string;
}

const identity: Codec = { decode: Option.some, encode: (content) => content };

export const codecs: R.ReadonlyRecord<string, Codec> = {
  "7bit": identity,
  "8bit": identity,
  binary: identity,
  "quoted-printable": {
    decode: (body) => Option.some(decodeQuotedPrintable(body)),
    encode: encodeQuotedPrintable,
  },
  base64: { decode: decodeBase64, encode: encodeBase64 },
};

/** Line breaks after the last base64 line, kept around the re-encoded text. */
const TRAILING_BREAKS = /(?:\r?\n)*$/;

const rewriteLeaf = <E, R>(
  message: Headers.Message,
  type: ContentType,
  rewrite: Rewrite<E, R>,
): Effect.Effect<Option.Option<Uint8Array>, E, R> => {
  const isAttachment = Option.exists(first(message, "content-disposition"), (value) =>
    /^\s*attachment\b/i.test(value),
  );
  if (
    type.type !== "text" ||
    (type.subtype !== "plain" && type.subtype !== "html") ||
    isAttachment
  ) {
    return Effect.succeedNone;
  }
  const encoding = Option.getOrElse(first(message, "content-transfer-encoding"), () => "7bit")
    .trim()
    .toLowerCase();
  const rest = toBinary(message.rest);
  // `rest` starts with the blank line that ends the header block (absent when there is no body).
  const blank = /^\r?\n/.exec(rest)?.[0] ?? "";
  const body = rest.slice(blank.length);
  const eol = message.lineEnding;
  const decoded = Option.flatMap(R.get(codecs, encoding), (codec) =>
    Option.map(codec.decode(body), (content) => ({ codec, content })),
  );
  if (Option.isNone(decoded)) return Effect.succeedNone;
  const { codec, content } = decoded.value;
  return rewrite({
    subtype: type.subtype === "html" ? "html" : "plain",
    charset: Option.getOrElse(R.get(type.parameters, "charset"), () => "us-ascii").toLowerCase(),
    content,
  }).pipe(
    Effect.map((rewritten) =>
      rewritten.pipe(
        Option.filter((changed) => changed !== content),
        Option.map((changed) => {
          const trailing = encoding === "base64" ? (TRAILING_BREAKS.exec(body)?.[0] ?? "") : "";
          return fromBinary(blank + codec.encode(changed, eol) + trailing);
        }),
      ),
    ),
  );
};

/**
 * Splits a multipart body at its boundary (RFC 2046 §5.1.1). The line break before each
 * delimiter belongs to the delimiter, so a part's bytes run from after one delimiter line to
 * before the next delimiter's line break. Returns the pieces in order: what is not a part
 * (preamble, delimiter lines, epilogue) is kept as it was.
 */
export const splitMultipart = (
  body: Uint8Array,
  boundary: string,
): ReadonlyArray<{ readonly isPart: boolean; readonly bytes: Uint8Array }> => {
  const text = toBinary(body);
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, "g");
  const matches = Arr.fromIterable(text.matchAll(delimiter));
  // Everything after the close delimiter is the epilogue.
  const close = Arr.findFirstIndex(matches, (match) => match[1] !== undefined);
  const delimiters = Option.match(close, {
    onNone: () => matches,
    onSome: (index) => matches.slice(0, index + 1),
  });
  const end = (index: number) =>
    Option.match(Arr.get(delimiters, index), {
      onNone: () => 0,
      onSome: (match) => match.index + match[0].length,
    });
  // One flatMap, not a reduce that copies its growing array per delimiter: a message may have
  // millions of them.
  return [
    ...Arr.flatMap(delimiters, (match, index) => [
      // Before the first delimiter is the preamble; between two delimiters, a part.
      { isPart: index > 0, bytes: body.subarray(end(index - 1), match.index) },
      { isPart: false, bytes: body.subarray(match.index, end(index)) },
    ]),
    { isPart: false, bytes: body.subarray(end(delimiters.length - 1)) },
  ];
};

/** A part with no header fields at all starts with its blank line (RFC 2046 §5.1.1). */
export const parseEntity = (raw: Uint8Array): Effect.Effect<Headers.Message> =>
  Headers.parse(raw).pipe(
    Effect.catchTag("MalformedMessage", () =>
      Effect.succeed<Headers.Message>({
        fields: [],
        rest: raw,
        lineEnding: raw.includes(13) ? "\r\n" : "\n",
      }),
    ),
  );

/** The entity's body after `rewrite`, or none when nothing in it changed. */
/**
 * How much of a message's MIME tree is walked (PLAN.md §20.25). Real mail nests three or four
 * levels and has a few dozen parts; attacker-chosen mail may nest thousands (each level re-reads
 * the rest of the message, so time grows with the square of its size) or hold a million parts
 * (each costs a parse). Parts past either limit are passed on unchanged, and not read.
 */
export const MAX_DEPTH = 16;
const MAX_PARTS = 1_000;

/** Where a walk is: how deep, and how many parts it may still visit (shared by the whole walk). */
export interface Walk {
  readonly depth: number;
  readonly parts: Ref.Ref<number>;
}

export const startWalk: Effect.Effect<Walk> = Effect.map(Ref.make(MAX_PARTS), (parts) => ({
  depth: 0,
  parts,
}));

/** Takes one part from the walk's allowance; false once it is spent. */
export const visitPart = (walk: Walk): Effect.Effect<boolean> =>
  Ref.modify(walk.parts, (left) => [left > 0, left - 1]);

const rewriteEntity = <E, R>(
  message: Headers.Message,
  rewrite: Rewrite<E, R>,
  walk: Walk,
): Effect.Effect<Option.Option<Uint8Array>, E, R> => {
  const type = Option.match(first(message, "content-type"), {
    // A message without Content-Type is text/plain, and so is a part (RFC 2045 §5.2).
    onNone: () => DEFAULT_TYPE,
    onSome: parseContentType,
  });
  const boundary = R.get(type.parameters, "boundary");
  // Attached messages (message/rfc822) are not text parts, so they pass unchanged.
  if (type.type !== "multipart" || Option.isNone(boundary)) {
    return rewriteLeaf(message, type, rewrite);
  }
  if (walk.depth >= MAX_DEPTH) return Effect.succeedNone;
  const pieces = splitMultipart(message.rest, boundary.value);
  const inner = { ...walk, depth: walk.depth + 1 };
  return Effect.forEach(
    pieces,
    (piece) =>
      piece.isPart
        ? Effect.flatMap(visitPart(walk), (isAllowed) =>
            isAllowed
              ? Effect.flatMap(parseEntity(piece.bytes), (part) =>
                  Effect.map(rewriteEntity(part, rewrite, inner), (changed) =>
                    Option.map(changed, (rest) =>
                      concat([...Arr.map(part.fields, (field) => field.bytes), rest]),
                    ),
                  ),
                )
              : Effect.succeedNone,
          )
        : Effect.succeedNone,
    { concurrency: 1 },
  ).pipe(
    Effect.map((rewritten) =>
      Arr.some(rewritten, Option.isSome)
        ? Option.some(
            concat(
              Arr.map(pieces, (piece, index) =>
                Option.getOrElse(rewritten[index] ?? Option.none(), () => piece.bytes),
              ),
            ),
          )
        : Option.none(),
    ),
  );
};

/** The message with `rewrite` applied to its text parts; byte for byte the same where it isn't. */
export const rewriteText = <E, R>(
  message: Headers.Message,
  rewrite: Rewrite<E, R>,
): Effect.Effect<Headers.Message, E, R> =>
  Effect.map(
    Effect.flatMap(startWalk, (walk) => rewriteEntity(message, rewrite, walk)),
    (changed) =>
      Option.match(changed, { onNone: () => message, onSome: (rest) => ({ ...message, rest }) }),
  );
