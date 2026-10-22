import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Keyring from "./Keyring.ts";

/**
 * AES-256-GCM sealing for secrets stored at rest: the inbox's envelope encryption (PLAN.md
 * §20.22.2, `@alias/inbox` `Envelope`) and webhook signing secrets (§20.30, `@alias/webhooks`
 * `Secrets`). Each use derives its key-encryption key from a keyring entry with HKDF-SHA-256
 * under its own label, so the stored secret never touches AES directly and one keyring could
 * never open another use's blobs.
 *
 * Every seal binds where the blob belongs as additional authenticated data (AAD): a blob moved to
 * another record, or passed off as another part, fails to open.
 *
 * Sealed blob: `format (1 byte) || iv (12 bytes) || ciphertext || GCM tag (16 bytes)`.
 *
 * WebCrypto (`crypto.subtle`, in Node 24 and Lambda) does the AES and HKDF: the `Crypto` service
 * only gives random bytes. IVs are random (96 bits), so one key may seal at most 2^32 times (NIST
 * SP 800-38D); rotate keyrings well before that (SR-27).
 */

const FORMAT = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A blob that doesn't open: tampered, moved, or sealed with another key. Never carries content. */
export class SealError extends Schema.TaggedError<SealError>()("SealError", {
  reason: Schema.String,
}) {}

const subtle = () => globalThis.crypto.subtle;

/** WebCrypto takes buffers it owns: a copy on a plain ArrayBuffer. */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const failWith = (reason: string) => () => new SealError({ reason });

const text = (value: string) => new TextEncoder().encode(value);

/** An AES-256-GCM key from 32 raw bytes. */
export const importKey = (raw: Uint8Array) =>
  Effect.tryPromise({
    try: () => subtle().importKey("raw", own(raw), "AES-GCM", false, ["encrypt", "decrypt"]),
    catch: failWith("bad AES key"),
  });

/** An AES-GCM key held by WebCrypto (named without the DOM types, which infra doesn't load). */
export type Key = Effect.Success<ReturnType<typeof importKey>>;

/** The key-encryption key a keyring entry gives under `label` (HKDF-SHA-256, empty salt). */
export const deriveKey = (entry: Keyring.Key, label: string) =>
  Effect.tryPromise({
    try: async () => {
      const material = await subtle().importKey(
        "raw",
        own(Redacted.value(entry.secret)),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return subtle().deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: text(label) },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    },
    catch: failWith("bad key-encryption key"),
  });

/** Seals `plaintext` under `key`, bound to `aad`. */
export const seal = Effect.fn("Seal.seal")(function* (
  key: Key,
  aad: string,
  plaintext: Uint8Array,
) {
  const iv = yield* (yield* Crypto.Crypto).randomBytes(IV_BYTES);
  const ciphertext = yield* Effect.tryPromise({
    try: () =>
      subtle().encrypt(
        { name: "AES-GCM", iv: own(iv), additionalData: text(aad) },
        key,
        own(plaintext),
      ),
    catch: failWith("encryption failed"),
  });
  const sealed = new Uint8Array(1 + IV_BYTES + ciphertext.byteLength);
  sealed[0] = FORMAT;
  sealed.set(iv, 1);
  sealed.set(new Uint8Array(ciphertext), 1 + IV_BYTES);
  return sealed;
});

/** Opens a blob {@link seal} made under `key` and `aad`; `what` names it in the error. */
export const open = Effect.fn("Seal.open")(function* (
  key: Key,
  aad: string,
  sealed: Uint8Array,
  what: string,
) {
  if (sealed[0] !== FORMAT || sealed.length < 1 + IV_BYTES + TAG_BYTES) {
    return yield* new SealError({ reason: `not a sealed ${what}` });
  }
  const plaintext = yield* Effect.tryPromise({
    try: () =>
      subtle().decrypt(
        { name: "AES-GCM", iv: own(sealed.subarray(1, 1 + IV_BYTES)), additionalData: text(aad) },
        key,
        own(sealed.subarray(1 + IV_BYTES)),
      ),
    catch: failWith(`${what} does not authenticate`),
  });
  return new Uint8Array(plaintext);
});
