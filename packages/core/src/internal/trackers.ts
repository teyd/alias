import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Str from "effect/String";
import type { TextPart } from "./mime.ts";
import { isTrackerUrl, isTrackingParameter as isTrackingParameterNamed } from "./filters.ts";

/**
 * Tracker protection for forwarded mail (PLAN.md §20.19). Works on a text part's content as a
 * byte string (one char per byte): tags, attribute names and URLs are ASCII, so any
 * ASCII-compatible charset works and nothing is transcoded. UTF-16 and UTF-32 parts are left as
 * they are.
 *
 * In HTML:
 *
 * - `<img>` tags that load a remote tracking image are removed: a pixel (every given width and
 *   height at most 2 px, addy.io's rule), a hidden image (`hidden`, `display:none`,
 *   `visibility:hidden`, `opacity:0`, a zero width or height), or one from a known tracker
 *   (`filters.ts`).
 * - CSS `url(…)` in `style` attributes and `<style>` elements, and legacy `background`
 *   attributes, that point at a known tracker become `none` or are dropped.
 * - With link cleaning on, click-tracking query parameters are removed from `href`s.
 *
 * In plain text, only link cleaning applies.
 */

/** What to do with remote images. */
type ImageProtection = "off" | "block-trackers";

export interface Protection {
  readonly images: ImageProtection;
  /** Strip click-tracking query parameters (`utm_*`, `fbclid`, …) from links. */
  readonly isLinkCleaningEnabled: boolean;
}

/** What one part's protection changed. */
export interface Changes {
  /** Tracking images removed, and tracker URLs neutralised in CSS and attributes. */
  readonly trackers: number;
  /** Links that lost tracking parameters. */
  readonly links: number;
}

export const noChanges: Changes = { trackers: 0, links: 0 };

export const addChanges = (a: Changes, b: Changes): Changes => ({
  trackers: a.trackers + b.trackers,
  links: a.links + b.links,
});

const isChanged = (changes: Changes) => changes.trackers > 0 || changes.links > 0;

// URLs

const NAMED_ENTITIES: R.ReadonlyRecord<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
};

const fromCodePoint = (code: number, match: string) =>
  code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;

/** The character references a URL in an attribute may use (HTML §13.1.4); others stay. */
const decodeEntities = (text: string) =>
  text
    .replace(/&#(\d{1,7});?/g, (match, digits: string) =>
      fromCodePoint(Number.parseInt(digits, 10), match),
    )
    .replace(/&#x([0-9a-f]{1,6});?/gi, (match, digits: string) =>
      fromCodePoint(Number.parseInt(digits, 16), match),
    )
    .replace(/&(amp|quot|apos|lt|gt);?/gi, (match, name: string) =>
      Option.getOrElse(R.get(NAMED_ENTITIES, name.toLowerCase()), () => match),
    );

/**
 * The URL an attribute value or CSS `url()` loads, when it's remote (http, https or
 * scheme-relative). `cid:` (inline attachments), `data:` and relative URLs are not. Bytes outside
 * ASCII are percent-encoded as they are, like a browser does for a UTF-8 document.
 */
const parseUrl = Option.liftThrowable((href: string) => new URL(href));

const remoteUrl = (raw: string): Option.Option<URL> => {
  const text = decodeEntities(raw)
    .replace(/[\t\n\r]/g, "")
    .trim()
    .replace(
      /[^\x21-\x7e]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    );
  const absolute = text.startsWith("//") ? `https:${text}` : text;
  return /^https?:\/\//i.test(absolute) ? parseUrl(absolute) : Option.none();
};

// HTML attributes

interface Attribute {
  /** Whitespace before the name. */
  readonly lead: string;
  readonly rawName: string;
  /** Lowercased. */
  readonly name: string;
  /** `=` with its whitespace, empty for a bare attribute. */
  readonly equals: string;
  /** The value as written, quotes included. */
  readonly raw: string;
  /** The value without quotes; character references still in it. */
  readonly value: string;
}

const ATTRIBUTE = /(\s+)([^\s"'>/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

const parseAttributes = (text: string): ReadonlyArray<Attribute> =>
  Arr.map(Arr.fromIterable(text.matchAll(ATTRIBUTE)), (match) => {
    const raw = match[4] ?? "";
    const isQuoted = raw.startsWith('"') || raw.startsWith("'");
    return {
      lead: match[1] ?? "",
      rawName: match[2] ?? "",
      name: (match[2] ?? "").toLowerCase(),
      equals: match[3] ?? "",
      raw,
      value: isQuoted ? raw.slice(1, -1) : raw,
    };
  });

const formatAttribute = (attribute: Attribute) =>
  `${attribute.lead}${attribute.rawName}${attribute.equals}${attribute.raw}`;

/** The attribute with a new value in its own quotes. Callers only remove text, so no quote appears. */
const withValue = (attribute: Attribute, value: string): Attribute => {
  const quote =
    attribute.raw.startsWith('"') || attribute.raw.startsWith("'") ? attribute.raw[0] : "";
  return { ...attribute, raw: `${quote}${value}${quote}`, value };
};

const attributeValue = (attributes: ReadonlyArray<Attribute>, name: string) =>
  Option.map(
    Arr.findFirst(attributes, (attribute) => attribute.name === name),
    (attribute) => attribute.value,
  );

// CSS

/** `property: value` pairs of a declaration list, properties lowercased, values trimmed. */
const declarations = (css: string): ReadonlyArray<readonly [string, string]> =>
  Arr.flatMap(decodeEntities(css).split(";"), (declaration) => {
    const colon = declaration.indexOf(":");
    return colon <= 0
      ? []
      : [
          [
            declaration.slice(0, colon).trim().toLowerCase(),
            declaration
              .slice(colon + 1)
              .replace(/!\s*important\s*$/i, "")
              .trim()
              .toLowerCase(),
          ] as const,
        ];
  });

/** A CSS `url()`, its target quoted, unquoted, or `&quot;`-quoted inside an attribute. */
const CSS_URL = /url\([^)]*\)/gi;

const isTrackerCssUrl = (token: string) =>
  Option.exists(
    remoteUrl(
      token
        .slice("url(".length, -1)
        .trim()
        .replace(/^(?:"|'|&quot;)|(?:"|'|&quot;)$/gi, ""),
    ),
    isTrackerUrl,
  );

/** CSS with tracker `url()`s replaced by `none`, and how many there were. */
const protectCss = (css: string): readonly [string, number] => {
  const trackers = Arr.filter(css.match(CSS_URL) ?? [], isTrackerCssUrl).length;
  return trackers === 0
    ? [css, 0]
    : [css.replace(CSS_URL, (token) => (isTrackerCssUrl(token) ? "none" : token)), trackers];
};

// Images

/** `1`, `1px`, `0.5`; none for `auto`, percentages and anything else. */
const pixels = (value: string): Option.Option<number> => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(decodeEntities(value));
  return match === null ? Option.none() : Option.some(Number(match[1]));
};

/** No image this small is meant to be seen. */
const MAX_PIXEL = 2;

/** Too small or hidden to be meant for the reader: a tracking pixel, whatever its URL. */
const isInvisible = (attributes: ReadonlyArray<Attribute>) => {
  const style = Option.match(attributeValue(attributes, "style"), {
    onNone: () => [],
    onSome: declarations,
  });
  const css = (property: string) =>
    Arr.flatMap(style, ([name, value]) => (name === property ? [value] : []));
  const sizes = Arr.getSomes([
    Option.flatMap(attributeValue(attributes, "width"), pixels),
    Option.flatMap(attributeValue(attributes, "height"), pixels),
    ...Arr.map([...css("width"), ...css("height")], pixels),
  ]);
  const limits = Arr.getSomes(Arr.map([...css("max-width"), ...css("max-height")], pixels));
  return (
    Arr.some(attributes, (attribute) => attribute.name === "hidden") ||
    Arr.contains(css("display"), "none") ||
    Arr.contains(css("visibility"), "hidden") ||
    Arr.some(css("opacity"), (value) => Option.exists(pixels(value), (opacity) => opacity === 0)) ||
    Arr.some([...sizes, ...limits], (size) => size === 0) ||
    (Arr.isArrayNonEmpty(sizes) && Arr.every(sizes, (size) => size <= MAX_PIXEL))
  );
};

const isTrackingImage = (attributes: ReadonlyArray<Attribute>) =>
  Option.exists(
    Option.flatMap(attributeValue(attributes, "src"), remoteUrl),
    (url) => isTrackerUrl(url) || isInvisible(attributes),
  );

// Links

const isTrackingParameter = (hostname: string) => (parameter: string) =>
  isTrackingParameterNamed(hostname, decodeEntities(parameter.split("=")[0] ?? "").toLowerCase());

/** `&`, or `&amp;` and friends inside HTML attributes. */
const SEPARATOR = /(&amp;|&#0*38;|&#x0*26;|&)/i;

/**
 * The link without tracking parameters, written as it was otherwise (same separators, same
 * order, fragment kept); none when it has none. Only http(s) links are touched.
 */
const cleanLink = (link: string): Option.Option<string> => {
  const url = remoteUrl(link);
  if (Option.isNone(url)) return Option.none();
  const isTracking = isTrackingParameter(url.value.hostname);
  const hash = link.indexOf("#");
  const beforeHash = hash === -1 ? link : link.slice(0, hash);
  const fragment = hash === -1 ? "" : link.slice(hash);
  const question = beforeHash.indexOf("?");
  if (question === -1) return Option.none();
  // Odd indexes are the separators between parameters.
  const pieces = beforeHash.slice(question + 1).split(SEPARATOR);
  const parameters = Arr.filter(pieces, (_, index) => index % 2 === 0);
  if (!Arr.some(parameters, isTracking)) return Option.none();
  const kept = Arr.flatMap(parameters, (parameter, index) =>
    isTracking(parameter) || Str.isEmpty(parameter)
      ? []
      : [{ parameter, separator: pieces[index * 2 - 1] ?? "&" }],
  );
  const query = Arr.map(kept, ({ parameter, separator }, index) =>
    index === 0 ? parameter : `${separator}${parameter}`,
  ).join("");
  return Option.some(
    `${beforeHash.slice(0, question)}${Str.isEmpty(query) ? "" : `?${query}`}${fragment}`,
  );
};

// Tags

/** A start tag with its attributes; quoted values may hold `>`. */
const TAG =
  /<([A-Za-z][A-Za-z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)(\s*\/?)>/g;

const LINK_TAGS = HashSet.make("a", "area");

interface Rewritten {
  readonly text: string;
  readonly changes: Changes;
}

const protectTag = (
  name: string,
  attributeText: string,
  close: string,
  protection: Protection,
): Option.Option<Rewritten> => {
  const tag = name.toLowerCase();
  const attributes = parseAttributes(attributeText);
  const isBlocking = protection.images === "block-trackers";
  if (isBlocking && tag === "img" && isTrackingImage(attributes)) {
    return Option.some({ text: "", changes: { trackers: 1, links: 0 } });
  }
  const rewritten = Arr.map(
    attributes,
    (attribute): readonly [Option.Option<Attribute>, Changes] => {
      if (isBlocking && attribute.name === "style") {
        const [css, trackers] = protectCss(attribute.value);
        return trackers > 0
          ? [Option.some(withValue(attribute, css)), { trackers, links: 0 }]
          : [Option.some(attribute), noChanges];
      }
      if (
        isBlocking &&
        attribute.name === "background" &&
        Option.exists(remoteUrl(attribute.value), isTrackerUrl)
      ) {
        return [Option.none(), { trackers: 1, links: 0 }];
      }
      if (
        protection.isLinkCleaningEnabled &&
        attribute.name === "href" &&
        HashSet.has(LINK_TAGS, tag)
      ) {
        return Option.match(cleanLink(attribute.value), {
          onNone: () => [Option.some(attribute), noChanges],
          onSome: (link) => [Option.some(withValue(attribute, link)), { trackers: 0, links: 1 }],
        });
      }
      return [Option.some(attribute), noChanges];
    },
  );
  const changes = Arr.reduce(rewritten, noChanges, (total, [, change]) =>
    addChanges(total, change),
  );
  if (!isChanged(changes)) return Option.none();
  const kept = Arr.getSomes(Arr.map(rewritten, ([attribute]) => attribute));
  return Option.some({
    text: `<${name}${Arr.map(kept, formatAttribute).join("")}${close}>`,
    changes,
  });
};

const STYLE_ELEMENT = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;

const protectHtml = (html: string, protection: Protection): Rewritten => {
  const isBlocking = protection.images === "block-trackers";
  const styleTrackers = isBlocking
    ? Arr.reduce(
        Arr.fromIterable(html.matchAll(STYLE_ELEMENT)),
        0,
        (total, match) => total + protectCss(match[2] ?? "")[1],
      )
    : 0;
  const styled = {
    text:
      styleTrackers === 0
        ? html
        : html.replace(
            STYLE_ELEMENT,
            (_, open: string, css: string, close: string) => `${open}${protectCss(css)[0]}${close}`,
          ),
    changes: { trackers: styleTrackers, links: 0 },
  };
  const tags = Arr.map(Arr.fromIterable(styled.text.matchAll(TAG)), (match) => ({
    match,
    rewritten: protectTag(match[1] ?? "", match[2] ?? "", match[3] ?? "", protection),
  }));
  const result = Arr.reduce(
    tags,
    { text: "", changes: styled.changes, offset: 0 },
    (state, { match, rewritten }) =>
      Option.match(rewritten, {
        onNone: () => state,
        onSome: ({ text, changes }) => ({
          text: state.text + styled.text.slice(state.offset, match.index) + text,
          changes: addChanges(state.changes, changes),
          offset: match.index + match[0].length,
        }),
      }),
  );
  return { text: result.text + styled.text.slice(result.offset), changes: result.changes };
};

/** Bare links in plain text, without a closing bracket, quote or punctuation right after one. */
const PLAIN_LINK = /https?:\/\/[^\s<>"'()[\]{}]*[^\s<>"'()[\]{}.,;:!?]/gi;

const protectPlain = (text: string, protection: Protection): Rewritten => {
  if (!protection.isLinkCleaningEnabled) return { text, changes: noChanges };
  const links = Arr.filter(Arr.fromIterable(text.matchAll(PLAIN_LINK)), (match) =>
    Option.isSome(cleanLink(match[0])),
  );
  return {
    text: text.replace(PLAIN_LINK, (link) => Option.getOrElse(cleanLink(link), () => link)),
    changes: { trackers: 0, links: links.length },
  };
};

const UNICODE = /^utf-?(16|32)/;

/** The part with trackers removed, and what changed; none when nothing did. */
export const protect = (protection: Protection, part: TextPart): Option.Option<Rewritten> => {
  if (UNICODE.test(part.charset)) return Option.none();
  const rewritten =
    part.subtype === "html"
      ? protectHtml(part.content, protection)
      : protectPlain(part.content, protection);
  return isChanged(rewritten.changes) ? Option.some(rewritten) : Option.none();
};
