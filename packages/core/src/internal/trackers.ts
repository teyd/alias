import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
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
 * - With `proxy-images`, every other remote image URL (`src`, `srcset`, `poster`, `background`,
 *   CSS `url(…)`) is replaced with its signed image proxy URL (`ImageProxy`), so the sender sees
 *   the proxy instead of the reader's address, client and cookies.
 * - With link cleaning on, click-tracking query parameters are removed from `href`s.
 *
 * In plain text, only link cleaning applies.
 */

/** What to do with remote images. `proxy-images` blocks trackers too. */
type ImageProtection = "off" | "block-trackers" | "proxy-images";

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
  /** Remote image URLs replaced with proxy URLs. */
  readonly proxied: number;
}

export const noChanges: Changes = { trackers: 0, links: 0, proxied: 0 };

export const addChanges = (a: Changes, b: Changes): Changes => ({
  trackers: a.trackers + b.trackers,
  links: a.links + b.links,
  proxied: a.proxied + b.proxied,
});

const isChanged = (changes: Changes) =>
  changes.trackers > 0 || changes.links > 0 || changes.proxied > 0;

const tracker: Changes = { ...noChanges, trackers: 1 };
const link: Changes = { ...noChanges, links: 1 };
const proxiedOne: Changes = { ...noChanges, proxied: 1 };

/**
 * The proxy URL for a remote image URL (`URL.href`), if it is signed yet. Signing is an Effect,
 * so {@link protect} runs twice: once to learn which URLs need signing (`unsigned`), once with
 * them signed.
 */
export type ProxyUrls = (href: string) => Option.Option<string>;

/** What one rewrite step produced: its text, what it changed, and URLs it still needs signed. */
interface Step {
  readonly text: string;
  readonly changes: Changes;
  readonly unsigned: ReadonlyArray<string>;
}

const combine = (steps: ReadonlyArray<Step>, join = ""): Step => ({
  text: Arr.map(steps, (step) => step.text).join(join),
  changes: Arr.reduce(steps, noChanges, (total, step) => addChanges(total, step.changes)),
  unsigned: Arr.flatMap(steps, (step) => step.unsigned),
});

const unchanged = (text: string): Step => ({ text, changes: noChanges, unsigned: [] });

/** What happens to one remote image URL: removed as a tracker, proxied, or kept. */
interface Verdict {
  readonly kind: "tracker" | "proxy" | "keep";
  /** The URL as `URL.href` writes it, for `proxy`. */
  readonly href: string;
}

const keepIt: Verdict = { kind: "keep", href: "" };

interface Context {
  readonly protection: Protection;
  readonly proxy: ProxyUrls;
  /** Proxy URLs (ours) are never proxied again. */
  readonly isProxied: (href: string) => boolean;
}

const isBlocking = (context: Context) => context.protection.images !== "off";

const verdict = (context: Context, raw: string): Verdict =>
  Option.match(remoteUrl(raw), {
    onNone: () => keepIt,
    onSome: (url): Verdict =>
      isBlocking(context) && isTrackerUrl(url)
        ? { kind: "tracker", href: url.href }
        : context.protection.images === "proxy-images" && !context.isProxied(url.href)
          ? { kind: "proxy", href: url.href }
          : keepIt,
  });

/** A URL in a non-tracker position: its proxy URL, or itself until that is signed. */
const proxyStep = (context: Context, raw: string, href: string): Step =>
  Option.match(context.proxy(href), {
    onNone: () => ({ text: raw, changes: noChanges, unsigned: [href] }),
    onSome: (proxied) => ({ text: proxied, changes: proxiedOne, unsigned: [] }),
  });

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

const CSS_QUOTES = /^(?:"|'|&quot;)|(?:"|'|&quot;)$/gi;

/** One `url(…)`: `none` for a tracker, the proxy URL for another remote image. */
const cssUrl = (context: Context, token: string): Step => {
  const target = token.slice("url(".length, -1).trim().replace(CSS_QUOTES, "");
  const found = verdict(context, target);
  if (found.kind === "tracker") return { text: "none", changes: tracker, unsigned: [] };
  if (found.kind === "keep") return unchanged(token);
  const proxied = proxyStep(context, target, found.href);
  return isChanged(proxied.changes)
    ? { ...proxied, text: `url(${proxied.text})` }
    : { ...proxied, text: token };
};

/** CSS with every `url(…)` protected. */
const protectCss = (context: Context, css: string): Step => {
  const tokens = Arr.fromIterable(css.matchAll(CSS_URL));
  const steps = Arr.map(tokens, (match) => ({ match, step: cssUrl(context, match[0]) }));
  const rebuilt = Arr.reduce(
    steps,
    { parts: Arr.empty<Step>(), offset: 0 },
    (state, { match, step }) => ({
      parts: [...state.parts, unchanged(css.slice(state.offset, match.index)), step],
      offset: match.index + match[0].length,
    }),
  );
  return combine([...rebuilt.parts, unchanged(css.slice(rebuilt.offset))]);
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

/** `srcset` candidates: a URL, then optional width or density descriptors, comma-separated. */
const protectSrcset = (context: Context, srcset: string): Step =>
  combine(
    Arr.map(srcset.split(/,(?=\s)/), (candidate) => {
      const match = /^(\s*)(\S+)(.*)$/s.exec(candidate);
      if (match === null) return unchanged(candidate);
      const found = verdict(context, match[2] ?? "");
      if (found.kind !== "proxy") return unchanged(candidate);
      const step = proxyStep(context, match[2] ?? "", found.href);
      return { ...step, text: `${match[1] ?? ""}${step.text}${match[3] ?? ""}` };
    }),
    ",",
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

/** Attributes that load an image, by tag; `background` loads one on any tag. */
const IMAGE_ATTRIBUTES = HashSet.make("img src", "input src", "video poster", "img srcset");

const keep = (attribute: Attribute): readonly [Option.Option<Attribute>, Step] => [
  Option.some(attribute),
  unchanged(""),
];

const replaced = (attribute: Attribute, step: Step): readonly [Option.Option<Attribute>, Step] => [
  Option.some(isChanged(step.changes) ? withValue(attribute, step.text) : attribute),
  { ...step, text: "" },
];

const protectAttribute = (
  context: Context,
  tag: string,
  attribute: Attribute,
): readonly [Option.Option<Attribute>, Step] => {
  const { name, value } = attribute;
  if (name === "style" && isBlocking(context))
    return replaced(attribute, protectCss(context, value));
  if (name === "srcset" && tag === "img") return replaced(attribute, protectSrcset(context, value));
  if (name === "background" || HashSet.has(IMAGE_ATTRIBUTES, `${tag} ${name}`)) {
    const found = verdict(context, value);
    if (found.kind === "tracker") return [Option.none(), { ...unchanged(""), changes: tracker }];
    return found.kind === "proxy"
      ? replaced(attribute, proxyStep(context, value, found.href))
      : keep(attribute);
  }
  if (context.protection.isLinkCleaningEnabled && name === "href" && HashSet.has(LINK_TAGS, tag)) {
    return Option.match(cleanLink(value), {
      onNone: () => keep(attribute),
      onSome: (cleaned) => [
        Option.some(withValue(attribute, cleaned)),
        { ...unchanged(""), changes: link },
      ],
    });
  }
  return keep(attribute);
};

const protectTag = (
  context: Context,
  name: string,
  attributeText: string,
  close: string,
): Option.Option<Step> => {
  const tag = name.toLowerCase();
  const attributes = parseAttributes(attributeText);
  if (isBlocking(context) && tag === "img" && isTrackingImage(attributes)) {
    return Option.some({ text: "", changes: tracker, unsigned: [] });
  }
  const rewritten = Arr.map(attributes, (attribute) => protectAttribute(context, tag, attribute));
  const step = combine(Arr.map(rewritten, ([, change]) => change));
  if (!isChanged(step.changes))
    return Arr.isReadonlyArrayNonEmpty(step.unsigned)
      ? Option.some({ ...step, text: `<${name}${attributeText}${close}>` })
      : Option.none();
  const kept = Arr.getSomes(Arr.map(rewritten, ([attribute]) => attribute));
  return Option.some({
    ...step,
    text: `<${name}${Arr.map(kept, formatAttribute).join("")}${close}>`,
  });
};

const STYLE_ELEMENT = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;

const protectHtml = (context: Context, html: string): Step => {
  const styles = Arr.fromIterable(html.matchAll(STYLE_ELEMENT));
  const styled = isBlocking(context)
    ? Arr.reduce(styles, { parts: Arr.empty<Step>(), offset: 0 }, (state, match) => {
        const start = match.index + (match[1] ?? "").length;
        return {
          parts: [
            ...state.parts,
            unchanged(html.slice(state.offset, start)),
            protectCss(context, match[2] ?? ""),
          ],
          offset: start + (match[2] ?? "").length,
        };
      })
    : { parts: [], offset: 0 };
  const css = combine([...styled.parts, unchanged(html.slice(styled.offset))]);
  const tags = Arr.filterMap(Arr.fromIterable(css.text.matchAll(TAG)), (match) =>
    Result.fromOption(
      Option.map(protectTag(context, match[1] ?? "", match[2] ?? "", match[3] ?? ""), (step) => ({
        match,
        step,
      })),
      () => undefined,
    ),
  );
  const rebuilt = Arr.reduce(
    tags,
    { parts: Arr.empty<Step>(), offset: 0 },
    (state, { match, step }) => ({
      parts: [...state.parts, unchanged(css.text.slice(state.offset, match.index)), step],
      offset: match.index + match[0].length,
    }),
  );
  const body = combine([...rebuilt.parts, unchanged(css.text.slice(rebuilt.offset))]);
  return {
    text: body.text,
    changes: addChanges(css.changes, body.changes),
    unsigned: [...css.unsigned, ...body.unsigned],
  };
};

/** Bare links in plain text, without a closing bracket, quote or punctuation right after one. */
const PLAIN_LINK = /https?:\/\/[^\s<>"'()[\]{}]*[^\s<>"'()[\]{}.,;:!?]/gi;

const protectPlain = (context: Context, text: string): Step => {
  if (!context.protection.isLinkCleaningEnabled) return unchanged(text);
  const links = Arr.filter(Arr.fromIterable(text.matchAll(PLAIN_LINK)), (match) =>
    Option.isSome(cleanLink(match[0])),
  );
  return {
    text: text.replace(PLAIN_LINK, (found) => Option.getOrElse(cleanLink(found), () => found)),
    changes: { ...noChanges, links: links.length },
    unsigned: [],
  };
};

const UNICODE = /^utf-?(16|32)/;

/**
 * The part with trackers removed and, in `proxy-images` mode, image URLs that `proxy` knows
 * replaced. `unsigned` lists the remote image URLs `proxy` didn't know yet, deduplicated: sign
 * them and run again. None when nothing would change.
 */
export const protect = (
  protection: Protection,
  part: TextPart,
  proxy: ProxyUrls,
  isProxied: (href: string) => boolean,
): Option.Option<Step> => {
  if (UNICODE.test(part.charset)) return Option.none();
  const context: Context = { protection, proxy, isProxied };
  const step =
    part.subtype === "html"
      ? protectHtml(context, part.content)
      : protectPlain(context, part.content);
  return isChanged(step.changes) || Arr.isReadonlyArrayNonEmpty(step.unsigned)
    ? Option.some({ ...step, unsigned: Arr.dedupe(step.unsigned) })
    : Option.none();
};
