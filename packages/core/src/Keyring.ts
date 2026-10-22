import * as Arr from "effect/Array";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * Versioned HMAC keys: the reverse-alias tokens (`ReverseToken`) and the image proxy's signed
 * URLs (`ImageProxy`) each have one, configured as `<version>:<base64url secret>` entries. The
 * first entry signs; the others only verify, so links in older mail keep working through a
 * rotation.
 */

const MIN_SECRET_BYTES = 32;
const MAX_KEY_VERSION = 255;

export interface Key {
  readonly version: number;
  readonly secret: Redacted.Redacted<Uint8Array>;
}

/** Signs with `current`; verifies with `current` or any `retired` key. Build with {@link make}. */
export type Keyring = Brand.Branded<
  { readonly current: Key; readonly retired: ReadonlyArray<Key> },
  "Keyring"
>;
const Keyring = Brand.nominal<Keyring>();

/** Says which entry is wrong, never what it holds. */
class InvalidKeyring extends Schema.TaggedError<InvalidKeyring>()("InvalidKeyring", {
  reason: Schema.String,
}) {}

/**
 * Validates the keys once, at startup: versions are distinct bytes and every secret has at
 * least 256 bits.
 */
export const make = Effect.fn("Keyring.make")(function* (keys: {
  readonly current: Key;
  readonly retired: ReadonlyArray<Key>;
}) {
  const all = Arr.prepend(keys.retired, keys.current);
  if (
    !Arr.every(
      all,
      (key) => Number.isInteger(key.version) && key.version >= 0 && key.version <= MAX_KEY_VERSION,
    )
  ) {
    return yield* new InvalidKeyring({ reason: "key versions must be integers from 0 to 255" });
  }
  if (Arr.dedupe(Arr.map(all, (key) => key.version)).length !== all.length) {
    return yield* new InvalidKeyring({ reason: "key versions must be distinct" });
  }
  if (!Arr.every(all, (key) => Redacted.value(key.secret).length >= MIN_SECRET_BYTES)) {
    return yield* new InvalidKeyring({ reason: "secrets need at least 32 bytes" });
  }
  return Keyring({ current: keys.current, retired: keys.retired });
});

/** The key that signed with `version`, current or retired. */
export const find = (keys: Keyring, version: number) =>
  Arr.findFirst(Arr.prepend(keys.retired, keys.current), (key) => key.version === version);

const ENTRY = /^(\d{1,3}):([A-Za-z0-9_-]+)$/;

const entry = Effect.fn("Keyring.entry")(function* (text: string, index: number) {
  const fail = (what: string) =>
    Effect.fail(new InvalidKeyring({ reason: `entry ${index + 1}: ${what}` }));
  const match = ENTRY.exec(text);
  if (match === null) return yield* fail("expected <version>:<base64url secret>");
  const secret = Base64Url.decode(match[2] ?? "");
  if (Result.isFailure(secret)) return yield* fail("secret is not base64url");
  const parsed: Key = { version: Number(match[1]), secret: Redacted.make(secret.success) };
  return parsed;
});

/**
 * Parses `<version>:<base64url secret>` entries, comma-separated, the first one signing.
 * Secrets need at least 32 bytes (`openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`).
 */
export const parse = Effect.fn("Keyring.parse")(function* (value: Redacted.Redacted<string>) {
  const entries = Arr.filter(
    Arr.map(Str.split(Redacted.value(value), ","), Str.trim),
    Str.isNonEmpty,
  );
  const keys = yield* Effect.forEach(entries, entry, { concurrency: 1 });
  if (!Arr.isArrayNonEmpty(keys)) {
    return yield* new InvalidKeyring({ reason: "no key given" });
  }
  const [current, ...retired] = keys;
  return yield* make({ current, retired });
});
