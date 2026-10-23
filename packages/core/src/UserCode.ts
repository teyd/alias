import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

/**
 * The code a person types to approve a device login (RFC 8628 §6.1): 8 characters from 20
 * consonants, shown as `BCDF-GHJK`. No vowels, so no words; no digits, so nothing to confuse with
 * letters. About 34.6 bits, guessed only by a signed-in user, a few times an hour, during the
 * code's 10 minutes.
 */
export const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const LENGTH = 8;

/** The largest multiple of 20 below 256: bytes at or above it are skipped, so no modulo bias. */
const UNBIASED_BELOW = 240;

/**
 * A code from random bytes, by rejection sampling. None when too many bytes were rejected; 16
 * bytes fall short with a probability below 10⁻⁹, and the caller then draws again.
 */
export const fromBytes = (bytes: Uint8Array): Option.Option<string> => {
  const picked = Arr.filter(Array.from(bytes), (byte) => byte < UNBIASED_BELOW);
  return picked.length < LENGTH
    ? Option.none()
    : Option.some(
        Arr.join(
          Arr.map(Arr.take(picked, LENGTH), (byte) => ALPHABET.charAt(byte % ALPHABET.length)),
          "",
        ),
      );
};

/**
 * What a person typed, as stored: case and separators (spaces, dashes) don't matter (RFC 8628
 * §6.1). None when it can't be a code, which saves a lookup.
 */
export const normalize = (input: string): Option.Option<string> => {
  const code = Str.toUpperCase(input).replace(/[\s-]/g, "");
  return code.length === LENGTH && Arr.every(Array.from(code), (char) => ALPHABET.includes(char))
    ? Option.some(code)
    : Option.none();
};

/** As shown: `BCDF-GHJK`. */
export const format = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;
