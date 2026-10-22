import * as Str from "effect/String";
import sanitizeHtml from "sanitize-html";

/**
 * Stored HTML made safe to show (PLAN.md §20.22.2): an allowlist of formatting tags and
 * attributes, nothing that runs, submits, frames or loads anything. Remote content stays out by
 * default: images keep only `data:` and `cid:` sources (a remote `src` is dropped and counted),
 * styles lose every `url(…)`, and `<style>` elements, `background` attributes and `srcset` go
 * entirely. Links keep http(s), mailto and tel, open in a new tab and send no referrer. The web
 * app still renders the result in a sandboxed frame with a CSP that allows no remote loads, so a
 * gap here is not a hole there.
 *
 * sanitize-html (htmlparser2) parses like a browser's tokenizer for these purposes and drops
 * whatever isn't allowed, text kept.
 */

const LAYOUT_ATTRIBUTES = [
  "align",
  "valign",
  "width",
  "height",
  "bgcolor",
  "color",
  "border",
  "cellpadding",
  "cellspacing",
  "colspan",
  "rowspan",
  "dir",
  "lang",
  "title",
  "style",
  "face",
  "size",
];

const TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  "img",
  "font",
  "center",
  "span",
  "u",
  "s",
  "small",
  "big",
  "sub",
  "sup",
];

/** CSS that would load something, or run something in old engines. */
const LOADING_CSS = /url\s*\(|expression\s*\(|@import|behavior\s*:|-moz-binding/i;

/** Declarations that load nothing, kept in order. */
const safeStyle = (style: string) =>
  style
    .split(";")
    .filter((declaration) => Str.isNonEmpty(declaration.trim()) && !LOADING_CSS.test(declaration))
    .join(";");

const withSafeStyle = (attribs: sanitizeHtml.Attributes): sanitizeHtml.Attributes =>
  attribs.style === undefined ? attribs : { ...attribs, style: safeStyle(attribs.style) };

export interface Sanitized {
  readonly html: string;
  /** Remote images removed: what "load images" would bring back. */
  readonly blockedImageCount: number;
}

export const sanitize = (html: string): Sanitized => {
  const blocked = { count: 0 };
  const out = sanitizeHtml(html, {
    allowedTags: TAGS,
    allowedAttributes: {
      "*": LAYOUT_ATTRIBUTES,
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt"],
      td: ["abbr", "scope"],
      th: ["abbr", "scope"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["data", "cid"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "title", "head"],
    transformTags: {
      img: (tagName, attribs) => {
        const src = (attribs.src ?? "").trim();
        if (Str.isNonEmpty(src) && !/^(?:data|cid):/i.test(src)) blocked.count += 1;
        return { tagName, attribs: withSafeStyle(attribs) };
      },
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...withSafeStyle(attribs),
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      }),
      "*": (tagName, attribs) => ({ tagName, attribs: withSafeStyle(attribs) }),
    },
  });
  return { html: out, blockedImageCount: blocked.count };
};
