import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

/**
 * Codes people type (device-login user codes, invite codes): 20 consonants. No vowels, so no
 * words; no digits, so nothing to confuse with letters.
 */
export const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** The largest multiple of 20 below 256: bytes at or above it are skipped, so no modulo bias. */
const UNBIASED_BELOW = 240;

/**
 * `length` characters from random bytes, by rejection sampling. None when too many bytes were
 * rejected; the caller then draws again.
 */
export const sample = (bytes: Uint8Array, length: number): Option.Option<string> => {
  const picked = Arr.filter(Array.from(bytes), (byte) => byte < UNBIASED_BELOW);
  return picked.length < length
    ? Option.none()
    : Option.some(
        Arr.join(
          Arr.map(Arr.take(picked, length), (byte) => ALPHABET.charAt(byte % ALPHABET.length)),
          "",
        ),
      );
};

/**
 * What a person typed, as stored: case and separators (spaces, dashes) don't matter. None when it
 * can't be a code of `length` characters, which saves a lookup.
 */
export const normalize = (input: string, length: number): Option.Option<string> => {
  const code = Str.toUpperCase(input).replace(/[\s-]/g, "");
  return code.length === length && Arr.every(Array.from(code), (char) => ALPHABET.includes(char))
    ? Option.some(code)
    : Option.none();
};

/** Groups of four, joined by dashes: `BCDF-GHJK`. */
export const format = (code: string): string =>
  Arr.join(
    Arr.map(Arr.chunksOf(Array.from(code), 4), (group) => Arr.join(group, "")),
    "-",
  );
