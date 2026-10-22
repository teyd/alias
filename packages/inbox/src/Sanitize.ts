import * as Arr from "effect/Array";
import * as R from "effect/Record";
import * as Str from "effect/String";
import sanitizeHtml from "sanitize-html";

/**
 * Stored HTML made safe to show (PLAN.md §20.22.2, §20.30): an allowlist of formatting tags and
 * attributes, nothing that runs, submits, frames or loads anything. Remote content stays out by
 * default: images keep only `data:` and `cid:` sources (a remote `src` is dropped and counted),
 * `<style>` elements, `background` attributes and `srcset` go entirely, and inline styles keep
 * only allowlisted declarations (below). Links keep http(s), mailto and tel, open in a new tab
 * and send no referrer. The API, SDK, CLI and MCP hand this HTML out as sanitized, so it must
 * hold on its own; the web app's sandboxed frame and CSP are a second wall, not the first.
 *
 * sanitize-html (htmlparser2) parses like a browser's tokenizer for these purposes and drops
 * whatever isn't allowed, text kept. Entities in attributes are decoded before any check.
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

/**
 * Inline styles go through PostCSS (sanitize-html's `allowedStyles`), so a declaration is checked
 * as the parsed property and value, not as text. Only these properties survive, under their
 * exact names: an escaped name (`b\61ckground`) is another name and is dropped.
 */
const STYLE_PROPERTIES = [
  "color",
  "background-color",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-transform",
  "white-space",
  "vertical-align",
  "direction",
  "display",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-collapse",
  "border-spacing",
  "border-radius",
  "table-layout",
  "list-style-type",
];

/**
 * Every way CSS loads something (`url()`, `image-set()`, `image()`, `cross-fade()`, `element()`,
 * `var()`, which could hold one, old engines' `expression()`) is a function, and every way to
 * disguise one goes through a backslash escape or a comment. So a value may hold words, numbers,
 * units, `#` colors, quotes, commas and slashes, and no parenthesis, backslash, `@` or `*`.
 * Linear: one character class.
 */
const PLAIN_VALUE = /^[-+#%.,\s'"/\p{L}\p{N}_]*$/u;

/** The color functions, alone as the whole value (`color: rgb(0 0 0 / 50%)`). */
const COLOR_FUNCTION = /^(?:rgba?|hsla?)\([-+\d.,%\s/]*\)$/i;

const ALLOWED_STYLES = {
  "*": R.fromIterableWith(STYLE_PROPERTIES, (property) => [
    property,
    Arr.contains(["color", "background-color", "border-color"], property)
      ? [PLAIN_VALUE, COLOR_FUNCTION]
      : [PLAIN_VALUE],
  ]),
};

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
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["data", "cid"] },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "title", "head"],
    transformTags: {
      img: (tagName, attribs) => {
        const src = (attribs.src ?? "").trim();
        if (Str.isNonEmpty(src) && !/^(?:data|cid):/i.test(src)) blocked.count += 1;
        return { tagName, attribs };
      },
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      }),
    },
  });
  return { html: out, blockedImageCount: blocked.count };
};
