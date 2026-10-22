import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Str from "effect/String";

/**
 * HTML read as text, for the verification extractor. Not a parser and not a sanitizer: it keeps
 * what a reader would see, in reading order, and drops everything else. Never render its output
 * as HTML.
 */

const NAMED: R.ReadonlyRecord<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  agrave: "à",
  egrave: "è",
  igrave: "ì",
  ograve: "ò",
  ugrave: "ù",
  acirc: "â",
  ecirc: "ê",
  icirc: "î",
  ocirc: "ô",
  ucirc: "û",
  ccedil: "ç",
  ntilde: "ñ",
  atilde: "ã",
  otilde: "õ",
  aring: "å",
  oslash: "ø",
  aelig: "æ",
  Eacute: "É",
};

const fromCodePoint = (code: number) =>
  Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";

/** Numeric references and the common named ones; unknown names stay as written. */
const decodeEntities = (text: string): string =>
  text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, name: string) =>
    name.startsWith("#x") || name.startsWith("#X")
      ? fromCodePoint(Number.parseInt(name.slice(2), 16))
      : name.startsWith("#")
        ? fromCodePoint(Number.parseInt(name.slice(1), 10))
        : Option.getOrElse(R.get(NAMED, name), () => whole),
  );

const INVISIBLE = /<(head|style|script|title|template|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const BLOCK =
  /<\/?(?:p|div|br|tr|table|tbody|thead|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|section|article|header|footer|center|hr|pre|address)\b[^>]*>/gi;
const CELL = /<\/?(?:td|th)\b[^>]*>/gi;
const TAG = /<[^>]*>/g;
/** Zero-width and formatting characters templates use to pad preheaders. */
const ZERO_WIDTH = /\u00ad|\u034f|[\u200b-\u200d\u2060\ufeff]/g;

/** Collapses whitespace on each line and drops empty lines. */
export const tidy = (text: string): string =>
  Arr.filter(
    Arr.map(text.replace(ZERO_WIDTH, "").split(/\r?\n/), (line) =>
      line.replace(/[ \t\u00a0\u2000-\u200a\u202f\u3000]+/g, " ").trim(),
    ),
    Str.isNonEmpty,
  ).join("\n");

/**
 * The text a reader sees. Block elements end a line; table cells become spaces, so a code
 * written one digit per cell reads `4 8 2 9 1 3`; inline elements join, so one digit per span
 * reads `482913`.
 */
export const toText = (html: string): string =>
  tidy(
    decodeEntities(
      html
        .replace(COMMENT, "")
        .replace(INVISIBLE, "")
        .replace(BLOCK, "\n")
        .replace(CELL, " ")
        .replace(TAG, ""),
    ),
  );

export interface Anchor {
  readonly href: string;
  /** What the link says, as text; empty for an image-only link. */
  readonly text: string;
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/** Every `<a href>` with its text, in document order. */
export const anchors = (html: string): ReadonlyArray<Anchor> =>
  Arr.getSomes(
    Arr.map(Arr.fromIterable(html.replace(COMMENT, "").matchAll(ANCHOR)), (match) =>
      Option.fromNullOr(HREF.exec(match[1] ?? "")).pipe(
        Option.map((href): Anchor => ({
          href: decodeEntities((href[1] ?? href[2] ?? href[3] ?? "").trim()),
          text: toText(match[2] ?? "").replace(/\n/g, " "),
        })),
      ),
    ),
  );
