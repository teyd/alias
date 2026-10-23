import type * as Option from "effect/Option";
import * as Consonants from "./internal/consonants.ts";

/**
 * An invite code for sign-up during the private beta (PLAN.md §20.36): 20 characters from the
 * same 20 consonants as device-login codes (`UserCode`), shown as `BCDF-GHJK-LMNP-QRST-VWXZ`.
 * About 86 bits: far beyond guessing online, and the table stores only its SHA-256, which a dump
 * can't turn back into a code.
 */
const LENGTH = 20;

/** Random bytes to draw for one code: 40 fall short of 20 usable ones with a probability < 10⁻¹³. */
export const RANDOM_BYTES = 40;

/** A code from random bytes, by rejection sampling. None when too many bytes were rejected. */
export const fromBytes = (bytes: Uint8Array): Option.Option<string> =>
  Consonants.sample(bytes, LENGTH);

/**
 * What a person typed or pasted, as hashed: case, dashes and spaces don't matter. None when it
 * can't be a code, which saves a lookup.
 */
export const normalize = (input: string): Option.Option<string> =>
  Consonants.normalize(input, LENGTH);

/** As handed out: groups of four, `BCDF-GHJK-LMNP-QRST-VWXZ`. */
export const format = Consonants.format;
