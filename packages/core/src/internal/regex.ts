import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/**
 * The part of `text` a global pattern of the shape `open [\s\S]*? close` can match in: up to the
 * end of the last `close` (a global regex). Past it nothing matches, but every `open` there would
 * scan to the end of the text first, which is quadratic on attacker-chosen mail (a million
 * unclosed `<style>` tags; PLAN.md §20.25). Before it, each `open` finds a `close`, at the latest
 * the last one, and the match consumes what it scanned.
 */
export const pairedPrefix = (text: string, close: RegExp): string =>
  text.slice(
    0,
    Option.match(Arr.last(Arr.fromIterable(text.matchAll(close))), {
      onNone: () => 0,
      onSome: (match) => match.index + match[0].length,
    }),
  );

/** `text.replace(pattern, replacement)` for a pattern ending in `close`, in linear time. */
export const replacePaired = (
  text: string,
  pattern: RegExp,
  close: RegExp,
  replacement: string,
): string => {
  const prefix = pairedPrefix(text, close);
  return prefix.replace(pattern, replacement) + text.slice(prefix.length);
};
