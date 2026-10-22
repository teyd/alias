import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

class InvalidAddress extends Schema.TaggedError<InvalidAddress>()("InvalidAddress", {
  input: Schema.String,
  reason: Schema.String,
}) {}

export interface MailAddress {
  readonly local: string;
  readonly domain: string;
}

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const parse = Effect.fn("Address.parse")(function* (input: string) {
  const normalized = input.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) {
    return yield* new InvalidAddress({ input, reason: "missing local part or domain" });
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!LOCAL_PART.test(local)) {
    return yield* new InvalidAddress({ input, reason: "invalid local part" });
  }
  const labels = domain.split(".");
  if (labels.length < 2 || !Arr.every(labels, (label) => DOMAIN_LABEL.test(label))) {
    return yield* new InvalidAddress({ input, reason: "invalid domain" });
  }
  const address: MailAddress = { local, domain };
  return address;
});

/** Lowercase letters and digits without the lookalikes `0`, `1`, `i`, `l` and `o`: 31 symbols. */
const RANDOM_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const RANDOM_LENGTH = 10;

/**
 * A fresh local part for a shared-domain alias, like `k7m2qx9pzr`. Ten symbols carry about 49
 * bits, so a collision with an existing alias is rare; callers still retry on one. Bytes at or
 * above 248 (8 × 31) are skipped so every symbol is equally likely.
 */
export const randomLocal = Effect.fn("Address.randomLocal")(function* () {
  const crypto = yield* Crypto.Crypto;
  const limit = RANDOM_ALPHABET.length * 8;
  const pick = Effect.map(crypto.randomBytes(RANDOM_LENGTH * 2), (bytes) =>
    Arr.map(
      Arr.filter(Array.from(bytes), (byte) => byte < limit),
      (byte) => RANDOM_ALPHABET.charAt(byte % RANDOM_ALPHABET.length),
    ),
  );
  const symbols = yield* pick.pipe(
    Effect.repeat({ until: (picked) => picked.length >= RANDOM_LENGTH }),
  );
  return Arr.join(Arr.take(symbols, RANDOM_LENGTH), "");
});

/**
 * Where an inbound recipient lives, relative to the domains we serve.
 * - SharedRandom: `x7k2p9@alias.example`
 * - UserSubdomain: `anything@user1.alias.example`
 * - Custom: `anything@user-owned.com` (resolved later against the domains table)
 */
export type Destination = Data.TaggedEnum<{
  SharedRandom: { readonly address: MailAddress; readonly sharedDomain: string };
  UserSubdomain: {
    readonly address: MailAddress;
    readonly sharedDomain: string;
    readonly username: string;
  };
  Custom: { readonly address: MailAddress };
}>;
export const Destination = Data.taggedEnum<Destination>();

const matchShared =
  (address: MailAddress) =>
  (shared: string): Option.Option<Destination> => {
    if (address.domain === shared) {
      return Option.some(Destination.SharedRandom({ address, sharedDomain: shared }));
    }
    const suffix = `.${shared}`;
    const username = address.domain.slice(0, -suffix.length);
    return address.domain.endsWith(suffix) && !username.includes(".")
      ? Option.some(Destination.UserSubdomain({ address, sharedDomain: shared, username }))
      : Option.none();
  };

export const classify = (address: MailAddress, sharedDomains: ReadonlyArray<string>): Destination =>
  Arr.findFirst(sharedDomains, matchShared(address)).pipe(
    Option.getOrElse(() => Destination.Custom({ address })),
  );

const REVERSE_MARKER = "+r.";

/** Splits `alias+r.<token>` into the alias local part and the reverse-alias token. */
export const reverseToken = (
  address: MailAddress,
): Option.Option<{ readonly aliasLocal: string; readonly token: string }> => {
  const index = address.local.indexOf(REVERSE_MARKER);
  if (index <= 0) return Option.none();
  const token = address.local.slice(index + REVERSE_MARKER.length);
  return Str.isEmpty(token)
    ? Option.none()
    : Option.some({ aliasLocal: address.local.slice(0, index), token });
};
