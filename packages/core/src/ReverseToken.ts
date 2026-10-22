import * as Arr from "effect/Array";
import * as Brand from "effect/Brand";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Address from "./Address.ts";
import * as Base32 from "./internal/base32.ts";
import { concat, constantTimeEqual, isEmptyBytes, utf8 } from "./internal/bytes.ts";
import { hmacSha256 } from "./internal/hmac.ts";

/**
 * The `<token>` in a reverse alias `alias+r.<token>@domain`: what a reply needs, signed so that
 * nobody but us can mint one.
 *
 * Wire format (bytes, then lowercase unpadded base32):
 *
 * ```
 * header      1 byte   high nibble: format version (1); low nibble: which fields follow
 *                      (bit 0: sender, bit 1: contact id)
 * key version 1 byte   which keyring secret signed the token (0–255)
 * contact id  1 + n    length-prefixed UTF-8, present when bit 1 is set
 * sender      n        UTF-8 address, present when bit 0 is set; runs to the MAC
 * mac         10 bytes HMAC-SHA-256 over a domain separator, the alias address and every
 *                      byte above, truncated to 80 bits
 * ```
 *
 * - The alias is identified by the address the token sits in, so it is not repeated inside.
 *   The MAC covers it, so a token cannot be moved to another alias or domain.
 * - Verifying needs only the keyring: no table lookup decides whether a token is genuine.
 * - Phase 4's contacts table adds the contact id field. Tokens may carry the sender, the contact,
 *   or both; tokens minted before contacts existed keep verifying unchanged.
 * - Unknown format versions and field bits are rejected, so a future layout is never misread.
 */
const FORMAT_VERSION = 1;
const HAS_SENDER = 0b0001;
const HAS_CONTACT = 0b0010;
const FIELD_BITS = 0b1111;
const MAC_BYTES = 10;
const MIN_SECRET_BYTES = 32;
const MAX_CONTACT_BYTES = 64;
const MAX_KEY_VERSION = 255;
const DOMAIN_SEPARATOR = utf8("alias/reverse-token/v1\u0000");

class InvalidKeyring extends Schema.TaggedError<InvalidKeyring>()("InvalidKeyring", {
  reason: Schema.String,
}) {}

class UnencodableSubject extends Schema.TaggedError<UnencodableSubject>()("UnencodableSubject", {
  reason: Schema.String,
}) {}

class InvalidReverseToken extends Schema.TaggedError<InvalidReverseToken>()("InvalidReverseToken", {
  reason: Schema.Literals(["malformed", "unknown-key", "bad-signature"]),
}) {}

export interface Key {
  readonly version: number;
  readonly secret: Redacted.Redacted<Uint8Array>;
}

/** Mints with `current`; verifies with `current` or any `retired` key. Build with {@link keyring}. */
export type Keyring = Brand.Branded<
  { readonly current: Key; readonly retired: ReadonlyArray<Key> },
  "ReverseTokenKeyring"
>;
const Keyring = Brand.nominal<Keyring>();

/** Who a reply goes to. At least one field is set. */
export interface Subject {
  readonly sender: Option.Option<string>;
  readonly contactId: Option.Option<string>;
}

export interface Claims extends Subject {
  readonly keyVersion: number;
}

/**
 * Validates the keys once, at startup: versions are distinct bytes and every secret has at
 * least 256 bits. Rotate by minting with a new `current` and keeping the old key in `retired`
 * for as long as replies to old mail should work.
 */
export const keyring = Effect.fn("ReverseToken.keyring")(function* (keys: {
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

const sign = (key: Key, alias: Address.MailAddress, unsigned: Uint8Array) =>
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
 * The token for replies through `alias` to `subject`. Fails when the subject is empty or when
 * the reverse address would be longer than inbound mail accepts (a sender address of roughly
 * 120 characters or more); a contact id keeps the token short.
 */
export const mint = Effect.fn("ReverseToken.mint")(function* (
  keys: Keyring,
  alias: Address.MailAddress,
  subject: Subject,
) {
  if (Option.isNone(subject.contactId) && Option.isNone(subject.sender)) {
    return yield* new UnencodableSubject({ reason: "needs a sender or a contact id" });
  }
  const sender = Option.map(subject.sender, Str.trim);
  if (Option.exists(sender, Str.isEmpty)) {
    return yield* new UnencodableSubject({ reason: "empty sender" });
  }
  if (
    Arr.some([...Option.toArray(sender), ...Option.toArray(subject.contactId)], hasLoneSurrogate)
  ) {
    // UTF-8 would turn it into U+FFFD, and the reply would go to a different address.
    return yield* new UnencodableSubject({ reason: "not well-formed Unicode" });
  }
  const contact = Option.map(subject.contactId, utf8);
  if (Option.exists(contact, (bytes) => isEmptyBytes(bytes) || bytes.length > MAX_CONTACT_BYTES)) {
    return yield* new UnencodableSubject({ reason: "contact id must be 1 to 64 bytes" });
  }
  const header =
    (FORMAT_VERSION << 4) |
    (Option.isSome(sender) ? HAS_SENDER : 0) |
    (Option.isSome(contact) ? HAS_CONTACT : 0);
  const unsigned = concat([
    new Uint8Array([header, keys.current.version]),
    ...Option.match(contact, {
      onNone: () => [],
      onSome: (bytes) => [new Uint8Array([bytes.length]), bytes],
    }),
    ...Option.toArray(Option.map(sender, utf8)),
  ]);
  const token = Base32.encode(concat([unsigned, yield* sign(keys.current, alias, unsigned)]));
  yield* Address.parse(Address.format(Address.reverseAddress(alias, token))).pipe(
    Effect.mapError(
      () => new UnencodableSubject({ reason: "reverse address too long; use a contact id" }),
    ),
  );
  return token;
});

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const decodeText = (bytes: Uint8Array): Option.Option<string> =>
  Option.liftThrowable(() => strictUtf8.decode(bytes))();

/** A field must be present exactly when its header bit says so, and be valid UTF-8. */
const field = (isPresent: boolean, bytes: Uint8Array): Option.Option<Option.Option<string>> =>
  isPresent
    ? isEmptyBytes(bytes)
      ? Option.none()
      : Option.map(decodeText(bytes), Option.some)
    : isEmptyBytes(bytes)
      ? Option.some(Option.none())
      : Option.none();

/** Reads the fields of a token whose MAC already checked out. */
const readFields = (header: number, body: Uint8Array): Option.Option<Subject> => {
  const hasContact = (header & HAS_CONTACT) !== 0;
  const contactEnd = hasContact ? 1 + (body[0] ?? 0) : 0;
  return contactEnd > body.length
    ? Option.none()
    : Option.all({
        contactId: field(hasContact, body.subarray(hasContact ? 1 : 0, contactEnd)),
        sender: field((header & HAS_SENDER) !== 0, body.subarray(contactEnd)),
      });
};

/**
 * Checks `token` from a reverse alias on `alias` and returns who the reply is for. The MAC is
 * compared in constant time and before any field is trusted.
 */
export const verify = Effect.fn("ReverseToken.verify")(function* (
  keys: Keyring,
  alias: Address.MailAddress,
  token: string,
) {
  const bytes = yield* Option.match(Base32.decode(token), {
    onNone: () => Effect.fail(new InvalidReverseToken({ reason: "malformed" })),
    onSome: Effect.succeed,
  });
  const header = bytes[0] ?? 0;
  const fieldBits = header & FIELD_BITS;
  if (
    bytes.length < 2 + MAC_BYTES ||
    header >> 4 !== FORMAT_VERSION ||
    fieldBits === 0 ||
    (fieldBits & ~(HAS_SENDER | HAS_CONTACT)) !== 0
  ) {
    return yield* new InvalidReverseToken({ reason: "malformed" });
  }
  const keyVersion = bytes[1] ?? 0;
  const key = yield* Option.match(
    Arr.findFirst(Arr.prepend(keys.retired, keys.current), (key) => key.version === keyVersion),
    {
      onNone: () => Effect.fail(new InvalidReverseToken({ reason: "unknown-key" })),
      onSome: Effect.succeed,
    },
  );
  const unsigned = bytes.subarray(0, bytes.length - MAC_BYTES);
  const expected = yield* sign(key, alias, unsigned);
  if (!constantTimeEqual(expected, bytes.subarray(bytes.length - MAC_BYTES))) {
    return yield* new InvalidReverseToken({ reason: "bad-signature" });
  }
  return yield* Option.match(readFields(header, unsigned.subarray(2)), {
    onNone: () => Effect.fail(new InvalidReverseToken({ reason: "malformed" })),
    onSome: (subject): Effect.Effect<Claims> => Effect.succeed({ ...subject, keyVersion }),
  });
});
