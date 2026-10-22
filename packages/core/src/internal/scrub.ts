import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { toBinary, utf8 } from "./bytes.ts";
import type { TextPart } from "./mime.ts";

/**
 * Takes the alias owner's real identity out of the text of their reply (PLAN.md §3.4):
 *
 * - each of their addresses, anywhere in the text, case-insensitively;
 * - their display name in quoted text and attribution lines, where mail clients repeat it
 *   (`On Tue, Ada Lovelace <ada@mailbox.example> wrote:`, Outlook's `From:` block). The name
 *   stays where the owner typed it themselves, such as their signature.
 *
 * Both become the alias address. Content is a byte string in the part's charset; matching works
 * on bytes, so it needs an ASCII-compatible charset (UTF-8, ISO-8859-*, windows-125x, …). UTF-16
 * and UTF-32 parts are left as they are.
 */

export interface Owner {
  readonly addresses: ReadonlyArray<string>;
  readonly name: Option.Option<string>;
  /** What each match becomes: the alias address. */
  readonly replacement: string;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ASCII letters match either case; every other byte only itself. */
const caseless = (text: string) =>
  Arr.map(Array.from(text), (char) =>
    /[a-z]/i.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : escapeRegExp(char),
  ).join("");

const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/** Not inside a longer address: `xada@mailbox.example` or `ada@mailbox.example.org`. */
const addressPattern = (address: string) =>
  new RegExp(`(?<![A-Za-z0-9._%+-])${caseless(address)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, "g");

/** Bytes of non-ASCII characters count as letters, so a name never matches inside a word. */
const namePattern = (name: string) =>
  new RegExp(`(?<![A-Za-z0-9\\x80-\\xff])${caseless(name)}(?![A-Za-z0-9\\x80-\\xff])`, "g");

const UNICODE = /^utf-?(16|32)/;

/** The name as bytes of the part's charset, or none where that charset can't hold it. */
const encodeName = (name: string, charset: string): Option.Option<string> => {
  if (charset === "utf-8" || charset === "utf8") return Option.some(toBinary(utf8(name)));
  return Arr.every(Array.from(name), (char) => (char.codePointAt(0) ?? 0x100) < 0x100)
    ? Option.some(name)
    : Option.none();
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** RFC 5322 phrases are short; two letters at least, so an initial alone never matches. */
const usableName = (name: Option.Option<string>) =>
  Option.filter(
    Option.map(name, (value) => value.trim()),
    (value) => (value.match(/\p{L}/gu) ?? []).length >= 2,
  );

/** Outlook and friends separate the quoted message with a rule instead of `>` prefixes. */
const QUOTE_SEPARATOR =
  /^[ \t]*(?:-{2,}[ \t]*(?:original message|urspr\S{1,2}ngliche nachricht|message d'origine|mensaje original)[ \t]*-{2,}|_{20,})[ \t]*\r?\n?$/i;

const isQuoted = (line: string) => /^[ \t]*>/.test(line);
const isBlank = (line: string) => /^[ \t]*\r?\n?$/.test(line);

/**
 * Lines of plain text where the owner's name is replaced: quoted lines, everything after an
 * Outlook-style separator, and the attribution in front of a quote, i.e. the one or two lines
 * right before it (a blank line may sit between) whose last one ends with a colon.
 */
const quotedLines = (lines: ReadonlyArray<string>): ReadonlyArray<boolean> => {
  const separator = Arr.findFirstIndex(lines, (line) => QUOTE_SEPARATOR.test(line));
  const attribution = Arr.flatMap(lines, (line, index) => {
    if (!isQuoted(line) || (index > 0 && isQuoted(lines[index - 1] ?? ""))) return [];
    const before = index > 0 && isBlank(lines[index - 1] ?? "") ? index - 2 : index - 1;
    const last = lines[before] ?? "";
    if (before < 0 || isBlank(last) || isQuoted(last) || !/:[ \t]*\r?\n?$/.test(last)) return [];
    const previous = lines[before - 1] ?? "";
    return before > 0 && !isBlank(previous) && !isQuoted(previous)
      ? [before - 1, before]
      : [before];
  });
  return Arr.map(
    lines,
    (line, index) =>
      isQuoted(line) ||
      Option.exists(separator, (start) => index >= start) ||
      Arr.contains(attribution, index),
  );
};

/** Where HTML quoting starts in the major clients; the rest of the part is quoted text. */
const HTML_QUOTE =
  /<blockquote\b|\bclass\s*=\s*["']?[^"'>]*\b(?:gmail_quote|gmail_attr|moz-cite-prefix)\b|\bid\s*=\s*["']?(?:divRplyFwdMsg|appendonsend)\b|-{2,}\s*Original Message/i;

const replaceAll = (text: string, patterns: ReadonlyArray<RegExp>, replacement: string) =>
  Arr.reduce(patterns, text, (current, pattern) => current.replace(pattern, replacement));

/** The part's content with the owner scrubbed, or none when it contains nothing of them. */
export const scrub =
  (owner: Owner) =>
  (part: TextPart): Option.Option<string> => {
    if (UNICODE.test(part.charset)) return Option.none();
    const addresses = Arr.map(Arr.filter(owner.addresses, isAscii), addressPattern);
    const names = Option.match(
      Option.flatMap(usableName(owner.name), (name) => encodeName(name, part.charset)),
      {
        onNone: () => [],
        onSome: (name) =>
          Arr.map(
            Arr.dedupe(part.subtype === "html" ? [name, escapeHtml(name)] : [name]),
            namePattern,
          ),
      },
    );
    const withoutAddresses = replaceAll(part.content, addresses, owner.replacement);
    if (part.subtype === "html") {
      const start = withoutAddresses.search(HTML_QUOTE);
      const scrubbed =
        start === -1
          ? withoutAddresses
          : withoutAddresses.slice(0, start) +
            replaceAll(withoutAddresses.slice(start), names, owner.replacement);
      return Option.some(scrubbed);
    }
    const lines = withoutAddresses.split(/(?<=\n)/);
    const quoted = quotedLines(lines);
    return Option.some(
      Arr.map(lines, (line, index) =>
        quoted[index] === true ? replaceAll(line, names, owner.replacement) : line,
      ).join(""),
    );
  };
