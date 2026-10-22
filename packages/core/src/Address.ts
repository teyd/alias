import * as Arr from "effect/Array";
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

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/;
/** RFC 5321 §4.5.3.1.1. */
const MAX_LOCAL_LENGTH = 64;
/** RFC 5321 path limit (256) minus the angle brackets. */
const MAX_ADDRESS_LENGTH = 254;
const REVERSE_MARKER = "+r.";

/**
 * Reverse aliases may run past 64 octets because their token carries the sender's address,
 * the way SRS addresses do. RFC 5321 §4.5.3.1 asks for no length limits where possible, and
 * only the alias part in front of the token has to fit the usual local-part limit.
 */
const isLocalLengthOk = (local: string): boolean => {
  const marker = local.indexOf(REVERSE_MARKER);
  return local.length <= MAX_LOCAL_LENGTH || (marker > 0 && marker <= MAX_LOCAL_LENGTH);
};

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const parse = Effect.fn("Address.parse")(function* (input: string) {
  const normalized = input.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) {
    return yield* new InvalidAddress({ input, reason: "missing local part or domain" });
  }
  if (normalized.length > MAX_ADDRESS_LENGTH) {
    return yield* new InvalidAddress({ input, reason: "address too long" });
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!isLocalLengthOk(local) || !LOCAL_PART.test(local)) {
    return yield* new InvalidAddress({ input, reason: "invalid local part" });
  }
  const labels = domain.split(".");
  if (labels.length < 2 || !Arr.every(labels, (label) => DOMAIN_LABEL.test(label))) {
    return yield* new InvalidAddress({ input, reason: "invalid domain" });
  }
  const address: MailAddress = { local, domain };
  return address;
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

export const format = (address: MailAddress): string => `${address.local}@${address.domain}`;

/** The reverse alias for `token`, on the alias's own domain: `alias+r.<token>@domain`. */
export const reverseAddress = (alias: MailAddress, token: string): MailAddress => ({
  local: `${alias.local}${REVERSE_MARKER}${token}`,
  domain: alias.domain,
});

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
