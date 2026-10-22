import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Option from "effect/Option";
import * as R from "effect/Record";
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
export type Rewrite = (part: TextPart) => Option.Option<string>;

interface ContentType {
  readonly type: string;
  readonly subtype: string;
  readonly parameters: R.ReadonlyRecord<string, string>;
}

/** `type/subtype; name=value; name="quoted value"`, names lowercased. */
const parseContentType = (value: string): ContentType => {
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

const DEFAULT_TYPE: ContentType = { type: "text", subtype: "plain", parameters: {} };

const first = (message: Headers.Message, name: string): Option.Option<string> =>
  Arr.head(Headers.values(message, name));

// Transfer encodings (RFC 2045 §6). Content is handled as byte strings throughout.

const decodeQuotedPrintable = (text: string): string =>
  text
    .replace(/[ \t]+(?=\r?\n|$)/g, "")
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

interface Codec {
  readonly decode: (body: string) => Option.Option<string>;
  readonly encode: (content: string, eol: string) => string;
}

const identity: Codec = { decode: Option.some, encode: (content) => content };

const codecs: R.ReadonlyRecord<string, Codec> = {
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

const rewriteLeaf = (
  message: Headers.Message,
  type: ContentType,
  rewrite: Rewrite,
): Option.Option<Uint8Array> => {
  const isAttachment = Option.exists(first(message, "content-disposition"), (value) =>
    /^\s*attachment\b/i.test(value),
  );
  if (
    type.type !== "text" ||
    (type.subtype !== "plain" && type.subtype !== "html") ||
    isAttachment
  ) {
    return Option.none();
  }
  const encoding = Option.getOrElse(first(message, "content-transfer-encoding"), () => "7bit")
    .trim()
    .toLowerCase();
  const codec = R.get(codecs, encoding);
  const rest = toBinary(message.rest);
  // `rest` starts with the blank line that ends the header block (absent when there is no body).
  const blank = /^\r?\n/.exec(rest)?.[0] ?? "";
  const body = rest.slice(blank.length);
  const eol = message.lineEnding;
  return Option.flatMap(codec, (found) =>
    found.decode(body).pipe(
      Option.flatMap((content) =>
        rewrite({
          subtype: type.subtype === "html" ? "html" : "plain",
          charset: Option.getOrElse(
            R.get(type.parameters, "charset"),
            () => "us-ascii",
          ).toLowerCase(),
          content,
        }).pipe(Option.filter((changed) => changed !== content)),
      ),
      Option.map((changed) => {
        const trailing = encoding === "base64" ? (TRAILING_BREAKS.exec(body)?.[0] ?? "") : "";
        return fromBinary(blank + found.encode(changed, eol) + trailing);
      }),
    ),
  );
};

/**
 * Splits a multipart body at its boundary (RFC 2046 §5.1.1). The line break before each
 * delimiter belongs to the delimiter, so a part's bytes run from after one delimiter line to
 * before the next delimiter's line break. Returns the pieces in order: what is not a part
 * (preamble, delimiter lines, epilogue) is kept as it was.
 */
const splitMultipart = (
  body: Uint8Array,
  boundary: string,
): ReadonlyArray<{ readonly isPart: boolean; readonly bytes: Uint8Array }> => {
  const text = toBinary(body);
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, "g");
  const matches = Arr.fromIterable(text.matchAll(delimiter));
  const pieces = Arr.reduce(
    matches,
    {
      offset: 0,
      isOpen: false,
      pieces: Arr.empty<{ readonly isPart: boolean; readonly bytes: Uint8Array }>(),
    },
    (state, match) => {
      if (!state.isOpen && state.offset > 0) return state;
      const start = match.index;
      const end = start + match[0].length;
      return {
        offset: end,
        isOpen: match[1] === undefined,
        pieces: [
          ...state.pieces,
          { isPart: state.isOpen, bytes: body.subarray(state.offset, start) },
          { isPart: false, bytes: body.subarray(start, end) },
        ],
      };
    },
  );
  return [...pieces.pieces, { isPart: false, bytes: body.subarray(pieces.offset) }];
};

/** A part with no header fields at all starts with its blank line (RFC 2046 §5.1.1). */
const parseEntity = (raw: Uint8Array): Effect.Effect<Headers.Message> =>
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
const rewriteEntity = (
  message: Headers.Message,
  rewrite: Rewrite,
): Effect.Effect<Option.Option<Uint8Array>> => {
  const type = Option.match(first(message, "content-type"), {
    // A message without Content-Type is text/plain, and so is a part (RFC 2045 §5.2).
    onNone: () => DEFAULT_TYPE,
    onSome: parseContentType,
  });
  const boundary = R.get(type.parameters, "boundary");
  // Attached messages (message/rfc822) are not text parts, so they pass unchanged.
  if (type.type !== "multipart" || Option.isNone(boundary)) {
    return Effect.succeed(rewriteLeaf(message, type, rewrite));
  }
  const pieces = splitMultipart(message.rest, boundary.value);
  return Effect.forEach(
    pieces,
    (piece) =>
      piece.isPart
        ? Effect.flatMap(parseEntity(piece.bytes), (part) =>
            Effect.map(rewriteEntity(part, rewrite), (changed) =>
              Option.map(changed, (rest) =>
                concat([...Arr.map(part.fields, (field) => field.bytes), rest]),
              ),
            ),
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
export const rewriteText = (
  message: Headers.Message,
  rewrite: Rewrite,
): Effect.Effect<Headers.Message> =>
  Effect.map(rewriteEntity(message, rewrite), (changed) =>
    Option.match(changed, { onNone: () => message, onSome: (rest) => ({ ...message, rest }) }),
  );
