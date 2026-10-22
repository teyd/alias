import { Keyring } from "@alias/core";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * Envelope encryption for stored mail (PLAN.md §14.2, §20.22.2). Every message gets its own
 * random 256-bit data key; the body and the summary are sealed with it (AES-256-GCM), and the
 * data key is sealed with the inbox key (the key-encryption key) of the keyring's current
 * version. Only the wrapped data key and the key version are stored, next to the summary in
 * DynamoDB; the body goes to S3.
 *
 * The key-encryption key is derived from the keyring secret with HKDF-SHA-256, so the stored
 * secret never touches AES directly and could serve another purpose under another label.
 *
 * Every seal binds where it belongs as additional authenticated data: the alias id, the message
 * id and the part (`key`, `body`, `summary`). A blob moved to another message, or a body passed
 * off as a summary, fails to open.
 *
 * Sealed blob: `version (1 byte) || iv (12 bytes) || ciphertext || GCM tag (16 bytes)`.
 *
 * WebCrypto (`crypto.subtle`, in Node 24 and Lambda) does the AES and HKDF: the `Crypto` service
 * only gives random bytes and digests. Random IVs come from the `Crypto` service; with a fresh
 * data key per message, IV reuse under one key can't happen.
 */

const FORMAT = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEK_INFO = new TextEncoder().encode("alias/inbox/kek/v1");

/** A blob that doesn't open: tampered, moved, or sealed with another key. Never carries content. */
export class EnvelopeError extends Schema.TaggedError<EnvelopeError>()("EnvelopeError", {
  reason: Schema.String,
}) {}

/** Where a blob belongs: checked when it is opened. */
export interface Context {
  readonly aliasId: string;
  readonly messageId: string;
}

type Part = "key" | "body" | "summary";

const aad = (context: Context, part: Part) =>
  new TextEncoder().encode(
    `alias/inbox/v1\u0000${context.aliasId}\u0000${context.messageId}\u0000${part}`,
  );

const subtle = () => globalThis.crypto.subtle;

/** WebCrypto takes buffers it owns: a copy on a plain ArrayBuffer. */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const failWith = (reason: string) => () => new EnvelopeError({ reason });

const importAes = (raw: Uint8Array) =>
  Effect.tryPromise({
    try: () => subtle().importKey("raw", own(raw), "AES-GCM", false, ["encrypt", "decrypt"]),
    catch: failWith("bad AES key"),
  });

/** An AES-GCM key held by WebCrypto (named without the DOM types, which infra doesn't load). */
type AesKey = Effect.Success<ReturnType<typeof importAes>>;

/** The key-encryption key for one keyring entry. */
const kek = (key: Keyring.Key) =>
  Effect.tryPromise({
    try: async () => {
      const material = await subtle().importKey(
        "raw",
        own(Redacted.value(key.secret)),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return subtle().deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: KEK_INFO },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    },
    catch: failWith("bad key-encryption key"),
  });

const seal = Effect.fn("Envelope.seal")(function* (
  key: AesKey,
  context: Context,
  part: Part,
  plaintext: Uint8Array,
) {
  const iv = yield* (yield* Crypto.Crypto).randomBytes(IV_BYTES);
  const ciphertext = yield* Effect.tryPromise({
    try: () =>
      subtle().encrypt(
        { name: "AES-GCM", iv: own(iv), additionalData: aad(context, part) },
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

const open = Effect.fn("Envelope.open")(function* (
  key: AesKey,
  context: Context,
  part: Part,
  sealed: Uint8Array,
) {
  if (sealed[0] !== FORMAT || sealed.length < 1 + IV_BYTES + 16) {
    return yield* new EnvelopeError({ reason: `not a sealed ${part}` });
  }
  const plaintext = yield* Effect.tryPromise({
    try: () =>
      subtle().decrypt(
        {
          name: "AES-GCM",
          iv: own(sealed.subarray(1, 1 + IV_BYTES)),
          additionalData: aad(context, part),
        },
        key,
        own(sealed.subarray(1 + IV_BYTES)),
      ),
    catch: failWith(`${part} does not authenticate`),
  });
  return new Uint8Array(plaintext);
});

/** What is stored for one message. */
export interface Sealed {
  readonly keyVersion: number;
  readonly wrappedKey: Uint8Array;
  readonly body: Uint8Array;
  readonly summary: Uint8Array;
}

/** Seals a message's body and summary under a fresh data key, wrapped with the current key. */
export const sealMessage = Effect.fn("Envelope.sealMessage")(function* (
  keys: Keyring.Keyring,
  context: Context,
  parts: { readonly body: Uint8Array; readonly summary: Uint8Array },
) {
  const raw = yield* (yield* Crypto.Crypto).randomBytes(KEY_BYTES);
  const dataKey = yield* importAes(raw);
  const sealed: Sealed = {
    keyVersion: keys.current.version,
    wrappedKey: yield* seal(yield* kek(keys.current), context, "key", raw),
    body: yield* seal(dataKey, context, "body", parts.body),
    summary: yield* seal(dataKey, context, "summary", parts.summary),
  };
  raw.fill(0);
  return sealed;
});

/** The message's data key, unwrapped with whichever keyring entry wrapped it. */
export const unwrap = Effect.fn("Envelope.unwrap")(function* (
  keys: Keyring.Keyring,
  context: Context,
  stored: { readonly keyVersion: number; readonly wrappedKey: Uint8Array },
) {
  const entry = yield* Option.match(Keyring.find(keys, stored.keyVersion), {
    onNone: () =>
      Effect.fail(new EnvelopeError({ reason: `no inbox key version ${stored.keyVersion}` })),
    onSome: Effect.succeed,
  });
  const raw = yield* open(yield* kek(entry), context, "key", stored.wrappedKey);
  const dataKey = yield* importAes(raw);
  raw.fill(0);
  return dataKey;
});

export const openPart = (
  dataKey: AesKey,
  context: Context,
  part: "body" | "summary",
  sealed: Uint8Array,
) => open(dataKey, context, part, sealed);
