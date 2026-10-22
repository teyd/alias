import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Str from "effect/String";
import { decode as decodeWords } from "./internal/encodedWords.ts";
import { fromBinary, toBinary } from "./internal/bytes.ts";
import * as Headers from "./internal/headers.ts";
import * as Html from "./internal/html.ts";
import * as Mime from "./internal/mime.ts";

/**
 * Reads a raw RFC 5322 message for display (inbox mode, PLAN.md §3.5): the header fields a
 * reader sees, the first `text/plain` and `text/html` bodies decoded to strings, and what else
 * it carries. Unlike `Mail`, which rewrites bytes and must keep every one, this decodes: transfer
 * encodings (RFC 2045), charsets and encoded-words (RFC 2047). Nothing here sanitizes; HTML comes
 * out exactly as the sender wrote it.
 */

/** A part that is neither the text nor the HTML body: a file, an inline image, a message. */
export interface Attachment {
  readonly filename: Option.Option<string>;
  readonly contentType: string;
  /** Decoded size in bytes. */
  readonly size: number;
}

export interface Content {
  readonly subject: Option.Option<string>;
  /** The `From` field as written, encoded-words decoded. */
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly date: Option.Option<string>;
  readonly text: Option.Option<string>;
  readonly html: Option.Option<string>;
  readonly attachments: ReadonlyArray<Attachment>;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const windows1252 = new TextDecoder("windows-1252");

/** RFC 2046 names that WHATWG's TextDecoder doesn't know by that label. */
const CHARSET_ALIASES: R.ReadonlyRecord<string, string> = { "us-ascii": "utf-8", ascii: "utf-8" };

const decoderFor = (charset: string) => {
  const label = Option.getOrElse(R.get(CHARSET_ALIASES, charset), () => charset);
  return Option.liftThrowable(() => new TextDecoder(label))();
};

/**
 * Bytes in the declared charset to a string. UTF-8 that doesn't decode, and unknown charsets,
 * fall back to windows-1252, which maps every byte, so nothing fails to display.
 */
const decodeText = (bytes: Uint8Array, charset: string): string =>
  Option.match(decoderFor(charset), {
    onNone: () => windows1252.decode(bytes),
    onSome: (decoder) =>
      decoder.encoding === "utf-8"
        ? Option.getOrElse(Option.liftThrowable(() => utf8Strict.decode(bytes))(), () =>
            windows1252.decode(bytes),
          )
        : decoder.decode(bytes),
  });

/**
 * A header value for display: unfolded, 8-bit UTF-8 (RFC 6532) read as UTF-8, encoded-words
 * decoded, runs of blanks shown as one.
 */
const headerText = (message: Headers.Message, name: string): Option.Option<string> =>
  Arr.findFirst(message.fields, (field) => field.name === name).pipe(
    Option.map((field) => {
      const raw = decodeText(field.bytes, "utf-8");
      const value = raw
        .slice(raw.indexOf(":") + 1)
        .replace(/\r?\n(?=[ \t])/g, "")
        .trim();
      return decodeWords(value)
        .replace(/[ \t]+/g, " ")
        .trim();
    }),
    Option.filter(Str.isNonEmpty),
  );

/** RFC 2231 `name*=charset'language'percent-encoded`, else the plain parameter. */
const parameter = (
  parameters: R.ReadonlyRecord<string, string>,
  name: string,
): Option.Option<string> =>
  Option.orElse(
    Option.flatMap(R.get(parameters, `${name}*`), (extended) => {
      const [charset = "utf-8", , encoded = ""] = extended.split("'");
      const bytes = fromBinary(
        encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
      );
      return Option.some(decodeText(bytes, charset.toLowerCase() || "utf-8"));
    }),
    () => Option.map(R.get(parameters, name), (value) => decodeWords(value)),
  );

interface Leaf {
  readonly type: Mime.ContentType;
  readonly isAttachment: boolean;
  readonly filename: Option.Option<string>;
  /** The decoded body, one char per byte. */
  readonly content: string;
}

const disposition = (message: Headers.Message) =>
  Option.map(Mime.first(message, "content-disposition"), Mime.parseContentType);

const leaf = (message: Headers.Message, type: Mime.ContentType): Leaf => {
  const encoding = Option.getOrElse(Mime.first(message, "content-transfer-encoding"), () => "7bit")
    .trim()
    .toLowerCase();
  const rest = toBinary(message.rest);
  const body = rest.slice(/^\r?\n/.exec(rest)?.[0].length ?? 0);
  const found = disposition(message);
  return {
    type,
    // `parseContentType` puts the disposition type in `type`: `attachment` or `inline`.
    isAttachment: Option.exists(found, (value) => value.type === "attachment"),
    filename: Option.orElse(
      Option.flatMap(found, (value) => parameter(value.parameters, "filename")),
      () => parameter(type.parameters, "name"),
    ),
    content: Option.getOrElse(
      Option.flatMap(R.get(Mime.codecs, encoding), (codec) => codec.decode(body)),
      () => body,
    ),
  };
};

/** Every leaf of the entity, depth first, in the order they appear. */
const leaves = (message: Headers.Message): Effect.Effect<ReadonlyArray<Leaf>> => {
  const type = Option.match(Mime.first(message, "content-type"), {
    onNone: () => Mime.DEFAULT_TYPE,
    onSome: Mime.parseContentType,
  });
  const boundary = R.get(type.parameters, "boundary");
  if (type.type !== "multipart" || Option.isNone(boundary)) {
    return Effect.succeed([leaf(message, type)]);
  }
  return Effect.forEach(
    Arr.filter(Mime.splitMultipart(message.rest, boundary.value), (piece) => piece.isPart),
    (piece) => Effect.flatMap(Mime.parseEntity(piece.bytes), leaves),
    { concurrency: 1 },
  ).pipe(Effect.map(Arr.flatten));
};

const isBody = (found: Leaf, subtype: "plain" | "html") =>
  found.type.type === "text" && found.type.subtype === subtype && !found.isAttachment;

const charsetOf = (found: Leaf) =>
  Option.getOrElse(R.get(found.type.parameters, "charset"), () => "us-ascii").toLowerCase();

const decodeLeaf = (found: Leaf) => decodeText(fromBinary(found.content), charsetOf(found));

/**
 * Reads `raw` for display. The first inline `text/plain` and `text/html` parts are the bodies;
 * every other leaf, including further text parts, is listed as an attachment.
 */
export const read = Effect.fn("Message.read")(function* (raw: Uint8Array) {
  const message = yield* Headers.parse(raw);
  const all = yield* leaves(message);
  const text = Arr.findFirst(all, (found) => isBody(found, "plain"));
  const html = Arr.findFirst(all, (found) => isBody(found, "html"));
  const isChosen = (found: Leaf) =>
    Option.exists(text, (chosen) => chosen === found) ||
    Option.exists(html, (chosen) => chosen === found);
  const content: Content = {
    subject: headerText(message, "subject"),
    from: headerText(message, "from"),
    to: headerText(message, "to"),
    date: headerText(message, "date"),
    text: Option.map(text, decodeLeaf),
    html: Option.map(html, decodeLeaf),
    attachments: Arr.map(
      Arr.filter(all, (found) => !isChosen(found)),
      (found): Attachment => ({
        filename: found.filename,
        contentType: `${found.type.type}/${found.type.subtype}`,
        size: found.content.length,
      }),
    ),
  };
  return content;
});

const PREVIEW_LENGTH = 160;

/** The start of what the message says, on one line: the text body, else the HTML as text. */
export const preview = (content: Content): string => {
  const text = Option.match(content.text, {
    onSome: Html.tidy,
    onNone: () => Option.match(content.html, { onSome: Html.toText, onNone: () => "" }),
  }).replace(/\s+/g, " ");
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : text;
};
