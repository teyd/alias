import * as Schema from "effect/Schema";

/**
 * What callers may know about OpenPGP keys without loading OpenPGP.js (PLAN.md §20.21): the API
 * contracts and the web app import this, and only `Pgp` pulls in the library.
 */

/** Armored keys above this are refused. Real keys are 1–15 KB; more is mostly third-party signatures. */
export const MAX_KEY_BYTES = 64 * 1024;

/** Why a key can't be used. `expired`/`revoked`/`no-encryption-key` are judged at a given time. */
export const KeyProblem = Schema.Literals([
  "too-large",
  "malformed",
  "multiple-keys",
  "private-key",
  "revoked",
  "expired",
  "no-encryption-key",
]);
export type KeyProblem = typeof KeyProblem.Type;
