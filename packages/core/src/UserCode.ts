import type * as Option from "effect/Option";
import * as Consonants from "./internal/consonants.ts";

/**
 * The code a person types to approve a device login (RFC 8628 §6.1): 8 characters from 20
 * consonants, shown as `BCDF-GHJK`. No vowels, so no words; no digits, so nothing to confuse with
 * letters. About 34.6 bits, guessed only by a signed-in user, a few times an hour, during the
 * code's 10 minutes.
 */
export const ALPHABET = Consonants.ALPHABET;
const LENGTH = 8;

/**
 * A code from random bytes, by rejection sampling. None when too many bytes were rejected; 16
 * bytes fall short with a probability below 10⁻⁹, and the caller then draws again.
 */
export const fromBytes = (bytes: Uint8Array): Option.Option<string> =>
  Consonants.sample(bytes, LENGTH);

/**
 * What a person typed, as stored: case and separators (spaces, dashes) don't matter (RFC 8628
 * §6.1). None when it can't be a code, which saves a lookup.
 */
export const normalize = (input: string): Option.Option<string> =>
  Consonants.normalize(input, LENGTH);

/** As shown: `BCDF-GHJK`. */
export const format = Consonants.format;
