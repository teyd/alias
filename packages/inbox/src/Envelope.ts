import { Keyring, Seal } from "@alias/core";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Envelope encryption for stored mail (PLAN.md §14.2, §20.22.2). Every message gets its own
 * random 256-bit data key; the body and the summary are sealed with it (AES-256-GCM, `Seal` in
 * core), and the data key is sealed with the inbox key (the key-encryption key) of the keyring's
 * current version. Only the wrapped data key and the key version are stored, next to the summary
 * in DynamoDB; the body goes to S3.
 *
 * The key-encryption key is derived from the keyring secret with HKDF-SHA-256 under the label
 * `alias/inbox/kek/v1`, so the stored secret never touches AES directly.
 *
 * Every seal binds where it belongs as additional authenticated data: the alias id, the message
 * id and the part (`key`, `body`, `summary`). A blob moved to another message, or a body passed
 * off as a summary, fails to open. With a fresh data key per message, IV reuse under one data
 * key can't happen.
 */

const KEY_BYTES = 32;
const KEK_LABEL = "alias/inbox/kek/v1";

/** Where a blob belongs: checked when it is opened. */
export interface Context {
  readonly aliasId: string;
  readonly messageId: string;
}

type Part = "key" | "body" | "summary";

const aad = (context: Context, part: Part) =>
  `alias/inbox/v1\u0000${context.aliasId}\u0000${context.messageId}\u0000${part}`;

/** What is stored for one message. */
export interface Sealed {
  readonly keyVersion: number;
  readonly wrappedKey: Uint8Array;
  readonly body: Uint8Array;
  readonly summary: Uint8Array;
}

/**
 * A fresh random data key for one message, and that key wrapped with the keyring's current key.
 * Callers zero `raw` once they've sealed with `dataKey`.
 */
const freshKey = Effect.fn("Envelope.freshKey")(function* (
  keys: Keyring.Keyring,
  context: Context,
) {
  const raw = yield* (yield* Crypto.Crypto).randomBytes(KEY_BYTES);
  const kek = yield* Seal.deriveKey(keys.current, KEK_LABEL);
  return {
    raw,
    dataKey: yield* Seal.importKey(raw),
    keyVersion: keys.current.version,
    wrappedKey: yield* Seal.seal(kek, aad(context, "key"), raw),
  };
});

/** Seals a message's body and summary under a fresh data key, wrapped with the current key. */
export const sealMessage = Effect.fn("Envelope.sealMessage")(function* (
  keys: Keyring.Keyring,
  context: Context,
  parts: { readonly body: Uint8Array; readonly summary: Uint8Array },
) {
  const key = yield* freshKey(keys, context);
  const sealed: Sealed = {
    keyVersion: key.keyVersion,
    wrappedKey: key.wrappedKey,
    body: yield* Seal.seal(key.dataKey, aad(context, "body"), parts.body),
    summary: yield* Seal.seal(key.dataKey, aad(context, "summary"), parts.summary),
  };
  key.raw.fill(0);
  return sealed;
});

/**
 * Seals a body alone under a fresh data key: the kept copy of a failed delivery (PLAN.md §20.33),
 * whose metadata is in the clear. Opened like a stored message's body.
 */
export const sealBody = Effect.fn("Envelope.sealBody")(function* (
  keys: Keyring.Keyring,
  context: Context,
  body: Uint8Array,
) {
  const key = yield* freshKey(keys, context);
  const sealed: Omit<Sealed, "summary"> = {
    keyVersion: key.keyVersion,
    wrappedKey: key.wrappedKey,
    body: yield* Seal.seal(key.dataKey, aad(context, "body"), body),
  };
  key.raw.fill(0);
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
      Effect.fail(new Seal.SealError({ reason: `no inbox key version ${stored.keyVersion}` })),
    onSome: Effect.succeed,
  });
  const kek = yield* Seal.deriveKey(entry, KEK_LABEL);
  const raw = yield* Seal.open(kek, aad(context, "key"), stored.wrappedKey, "key");
  const dataKey = yield* Seal.importKey(raw);
  raw.fill(0);
  return dataKey;
});

export const openPart = (
  dataKey: Seal.Key,
  context: Context,
  part: "body" | "summary",
  sealed: Uint8Array,
) => Seal.open(dataKey, aad(context, part), sealed, part);
