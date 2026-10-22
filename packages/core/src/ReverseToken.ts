import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Address from "./Address.ts";
import * as Base32 from "./internal/base32.ts";
import * as Keyring from "./Keyring.ts";
import { concat, constantTimeEqual, isEmptyBytes, utf8 } from "./internal/bytes.ts";
import { hmacSha256 } from "./internal/hmac.ts";

/**
 * The `<token>` in a reverse alias `alias+r.<token>@domain`: the contact a reply goes to, signed
 * so that nobody but us can mint one.
 *
 * Wire format (bytes, then lowercase unpadded base32):
 *
 * ```
 * header      1 byte   high nibble: format version (2); low nibble: reserved, zero
 * key version 1 byte   which keyring secret signed the token (0–255)
 * contact id  1–64     UTF-8, runs to the MAC
 * mac         10 bytes HMAC-SHA-256 over a domain separator, the alias address and every
 *                      byte above, truncated to 80 bits
 * ```
 *
 * - The alias is identified by the address the token sits in, so it is not repeated inside.
 *   The MAC covers it, so a token cannot be moved to another alias or domain.
 * - Verifying needs only the keyring: no table lookup decides whether a token is genuine. Whether
 *   the contact still exists, and on this alias, is the caller's lookup, so deleting a contact
 *   (or its alias) revokes the token.
 * - Version 1 could also carry the sender's address; it was never deployed, and its tokens are
 *   rejected like any unknown format, as are reserved bits, so a layout is never misread.
 */
const FORMAT_VERSION = 2;
const MAC_BYTES = 10;
const MAX_CONTACT_BYTES = 64;
const DOMAIN_SEPARATOR = utf8("alias/reverse-token/v1\u0000");

class UnencodableContact extends Schema.TaggedError<UnencodableContact>()("UnencodableContact", {
  reason: Schema.String,
}) {}

class InvalidReverseToken extends Schema.TaggedError<InvalidReverseToken>()("InvalidReverseToken", {
  reason: Schema.Literals(["malformed", "unknown-key", "bad-signature"]),
}) {}

/** What a genuine token says: the contact a reply goes to, and the key that signed it. */
export interface Claims {
  readonly contactId: string;
  readonly keyVersion: number;
}

const sign = (key: Keyring.Key, alias: Address.MailAddress, unsigned: Uint8Array) =>
  hmacSha256(
    Redacted.value(key.secret),
    concat([DOMAIN_SEPARATOR, utf8(Address.format(alias)), new Uint8Array([0]), unsigned]),
  ).pipe(Effect.map((mac) => mac.subarray(0, MAC_BYTES)));

/**
 * A fresh contact id for {@link mint}: 80 random bits as 16 lowercase base32 characters. Short,
 * so a reverse alias stays short however long the contact's own address is, and unguessable, so
 * a deleted contact's id is never handed out again.
 */
export const newContactId = Effect.fn("ReverseToken.newContactId")(function* () {
  return Base32.encode(yield* (yield* Crypto.Crypto).randomBytes(10));
});

const hasLoneSurrogate = (text: string) => /\p{Surrogate}/u.test(text);

/**
 * The token for replies through `alias` to the contact `contactId` (see {@link newContactId}).
 * Fails when the id isn't 1 to 64 bytes of well-formed Unicode, or the reverse address would be
 * longer than inbound mail accepts.
 */
export const mint = Effect.fn("ReverseToken.mint")(function* (
  keys: Keyring.Keyring,
  alias: Address.MailAddress,
  contactId: string,
) {
  if (hasLoneSurrogate(contactId)) {
    // UTF-8 would turn it into U+FFFD, and the token would name a different contact.
    return yield* new UnencodableContact({ reason: "not well-formed Unicode" });
  }
  const contact = utf8(contactId);
  if (isEmptyBytes(contact) || contact.length > MAX_CONTACT_BYTES) {
    return yield* new UnencodableContact({ reason: "contact id must be 1 to 64 bytes" });
  }
  const unsigned = concat([new Uint8Array([FORMAT_VERSION << 4, keys.current.version]), contact]);
  const token = Base32.encode(concat([unsigned, yield* sign(keys.current, alias, unsigned)]));
  yield* Address.parse(Address.format(Address.reverseAddress(alias, token))).pipe(
    Effect.mapError(() => new UnencodableContact({ reason: "reverse address too long" })),
  );
  return token;
});

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const decodeText = (bytes: Uint8Array): Option.Option<string> =>
  Option.liftThrowable(() => strictUtf8.decode(bytes))();

/**
 * Checks `token` from a reverse alias on `alias` and returns the contact the reply is for. The MAC
 * is compared in constant time and before the contact id is trusted.
 */
export const verify = Effect.fn("ReverseToken.verify")(function* (
  keys: Keyring.Keyring,
  alias: Address.MailAddress,
  token: string,
) {
  const bytes = yield* Option.match(Base32.decode(token), {
    onNone: () => Effect.fail(new InvalidReverseToken({ reason: "malformed" })),
    onSome: Effect.succeed,
  });
  if (bytes.length < 3 + MAC_BYTES || bytes[0] !== FORMAT_VERSION << 4) {
    return yield* new InvalidReverseToken({ reason: "malformed" });
  }
  const keyVersion = bytes[1] ?? 0;
  const key = yield* Option.match(Keyring.find(keys, keyVersion), {
    onNone: () => Effect.fail(new InvalidReverseToken({ reason: "unknown-key" })),
    onSome: Effect.succeed,
  });
  const unsigned = bytes.subarray(0, bytes.length - MAC_BYTES);
  const expected = yield* sign(key, alias, unsigned);
  if (!constantTimeEqual(expected, bytes.subarray(bytes.length - MAC_BYTES))) {
    return yield* new InvalidReverseToken({ reason: "bad-signature" });
  }
  return yield* Option.match(decodeText(unsigned.subarray(2)), {
    onNone: () => Effect.fail(new InvalidReverseToken({ reason: "malformed" })),
    onSome: (contactId): Effect.Effect<Claims> => Effect.succeed({ contactId, keyVersion }),
  });
});
