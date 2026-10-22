import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as openpgp from "openpgp";
import { concat, fromBinary, toBinary, utf8 } from "./internal/bytes.ts";
import * as Headers from "./internal/headers.ts";
import { parseContentType } from "./internal/mime.ts";
import { KeyProblem, MAX_KEY_BYTES } from "./PgpKey.ts";

/**
 * OpenPGP encryption of forwarded mail (PLAN.md §20.21): reading a recipient's public key, and
 * wrapping a message as PGP/MIME (RFC 3156) for it. The message's routing header fields stay
 * outside; its MIME entity (the `Content-*` fields and the body, byte for byte) is what gets
 * encrypted. Optionally the subject is encrypted too, as RFC 9788 header protection.
 */

class InvalidKey extends Schema.TaggedError<InvalidKey>()("InvalidKey", {
  reason: KeyProblem,
}) {}

/** A public key that can encrypt now. */
interface Key {
  /** Re-armored by OpenPGP.js: one key, no comments or other blocks around it. */
  readonly armored: string;
  /** The primary key's fingerprint, uppercase hex. */
  readonly fingerprint: string;
  readonly userIds: ReadonlyArray<string>;
  /** When the key (or the subkey that encrypts) stops being usable; none if it never expires. */
  readonly expiresAt: Option.Option<DateTime.Utc>;
}

const invalid = (reason: KeyProblem) => new InvalidKey({ reason });

/** OpenPGP.js reports "never" as `Infinity` and "no valid self-signature" as `null`. */
type Expiration = Awaited<ReturnType<openpgp.Key["getExpirationTime"]>>;

const expiry = (time: Expiration): Option.Option<DateTime.Utc> =>
  P.isDate(time) ? Option.some(DateTime.makeUnsafe(time)) : Option.none();

const earliest = (times: ReadonlyArray<Option.Option<DateTime.Utc>>) =>
  Arr.head(Arr.sort(Arr.getSomes(times), DateTime.Order));

/** The parsed key and what callers see of it, if it can encrypt at `now`. */
const validate = Effect.fn("Pgp.validate")(function* (armored: string, now: DateTime.Utc) {
  if (utf8(armored).byteLength > MAX_KEY_BYTES) return yield* invalid("too-large");
  const keys = yield* Effect.tryPromise({
    try: () => openpgp.readKeys({ armoredKeys: armored }),
    catch: () => invalid("malformed"),
  });
  const [key] = keys;
  if (key === undefined) return yield* invalid("malformed");
  if (keys.length > 1) return yield* invalid("multiple-keys");
  // A pasted private key is refused, never stored, not even its public half.
  if (key.isPrivate()) return yield* invalid("private-key");
  const date = DateTime.toDate(now);
  const isRevoked = yield* Effect.tryPromise({
    try: () => key.isRevoked(undefined, undefined, date),
    catch: () => invalid("malformed"),
  });
  if (isRevoked) {
    return yield* invalid("revoked");
  }
  const primaryExpiry = expiry(
    yield* Effect.tryPromise({
      try: () => key.getExpirationTime(),
      catch: () => invalid("malformed"),
    }),
  );
  if (Option.exists(primaryExpiry, (at) => DateTime.isLessThanOrEqualTo(at, now))) {
    return yield* invalid("expired");
  }
  const encryptionKey = yield* Effect.tryPromise({
    try: () => key.getEncryptionKey(undefined, date),
    catch: () => invalid("no-encryption-key"),
  });
  const subkeyExpiry =
    encryptionKey instanceof openpgp.Subkey
      ? expiry(
          yield* Effect.tryPromise({
            try: () => encryptionKey.getExpirationTime(date),
            catch: () => invalid("no-encryption-key"),
          }),
        )
      : Option.none();
  const result: Key = {
    armored: key.armor(),
    fingerprint: key.getFingerprint().toUpperCase(),
    userIds: key.getUserIDs(),
    expiresAt: earliest([primaryExpiry, subkeyExpiry]),
  };
  return { key, result };
});

/**
 * Parses an armored public key and checks that it can encrypt at `now`: exactly one key, not a
 * private key, not revoked or expired, with a valid encryption-capable (sub)key that meets
 * OpenPGP.js's algorithm minimums (RSA ≥ 2047 bits, no deprecated curves).
 */
export const readKey = (armored: string, now: DateTime.Utc) =>
  Effect.map(validate(armored, now), ({ result }) => result);

/**
 * Mail that is already encrypted end to end, which forwarding leaves alone: PGP/MIME
 * (`multipart/encrypted`, RFC 1847/3156) and S/MIME enveloped data (`application/pkcs7-mime`
 * without `smime-type`, or with an enveloped one, RFC 8551 §3.2.2). S/MIME signed-data and
 * inline PGP are not: they get encrypted like any other message.
 */
const isEncrypted = (message: Headers.Message): boolean =>
  Option.exists(Arr.head(Headers.values(message, "content-type")), (value) => {
    const type = parseContentType(value);
    const media = `${type.type}/${type.subtype}`;
    if (media === "multipart/encrypted") return true;
    if (media !== "application/pkcs7-mime" && media !== "application/x-pkcs7-mime") return false;
    return Option.match(R.get(type.parameters, "smime-type"), {
      onNone: () => true,
      onSome: (smimeType) =>
        ["enveloped-data", "authenveloped-data"].includes(smimeType.toLowerCase()),
    });
  });

const isContentField = (field: Headers.Field) => field.name.startsWith("content-");

/**
 * The fields that header protection copies into the encrypted part: RFC 9788's user-facing
 * fields that we pass on, plus `Message-ID`, which clients use to thread.
 */
const PROTECTED = HashSet.make(
  "from",
  "to",
  "cc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "keywords",
  "comments",
);

/**
 * RFC 9788's `hcp_baseline`: outside, the subject becomes `[...]`, and `Keywords` and `Comments`
 * are removed. Every other protected field stays outside as it is (mail must still route).
 */
const OBSCURED_SUBJECT = "[...]";
const REMOVED_OUTSIDE = HashSet.make("keywords", "comments");

/**
 * Header protection parameters on the payload's root `Content-Type`: RFC 9788's `hp="cipher"`
 * and `protected-headers="v1"`, the earlier draft's marker that Thunderbird, Enigmail, Mailvelope
 * and K-9/Thunderbird for Android read.
 */
const PROTECTION_PARAMETERS = `protected-headers="v1"; hp="cipher"`;

/** The entity's `Content-*` fields, with the parameters on its (possibly implied) `Content-Type`. */
const markedContentFields = (message: Headers.Message): ReadonlyArray<Uint8Array> => {
  const eol = message.lineEnding;
  const content = Arr.filter(message.fields, isContentField);
  const marked = Arr.map(content, (field) => {
    if (field.name !== "content-type") return field.bytes;
    // One char per byte, so the field's bytes stay exactly as they were up to the new parameters.
    const head = toBinary(field.bytes).replace(/[\s;]+$/, "");
    return fromBinary(`${head};${eol} ${PROTECTION_PARAMETERS}${eol}`);
  });
  return Arr.some(content, (field) => field.name === "content-type")
    ? marked
    : [
        // RFC 2045 §5.2's default, spelled out so it can carry the parameters.
        utf8(`Content-Type: text/plain; charset=us-ascii; ${PROTECTION_PARAMETERS}${eol}`),
        ...marked,
      ];
};

/**
 * The cryptographic payload: the message's MIME entity, and with `isSubjectHidden` the protected
 * fields plus one `HP-Outer` field for each that stays visible outside (RFC 9788 §2.2), recording
 * what an outsider saw.
 */
const payload = (message: Headers.Message, isSubjectHidden: boolean): Uint8Array => {
  if (!isSubjectHidden) {
    return concat([
      ...Arr.map(Arr.filter(message.fields, isContentField), (field) => field.bytes),
      message.rest,
    ]);
  }
  const eol = message.lineEnding;
  const protectedFields = Arr.filter(message.fields, (field) => HashSet.has(PROTECTED, field.name));
  const outer = Arr.flatMap(protectedFields, (field) => {
    if (HashSet.has(REMOVED_OUTSIDE, field.name)) return [];
    if (field.name === "subject") return [utf8(`HP-Outer: Subject: ${OBSCURED_SUBJECT}${eol}`)];
    // The field as it is, folding included: continuation lines start with whitespace.
    return [concat([utf8("HP-Outer: "), field.bytes])];
  });
  return concat([
    ...Arr.map(protectedFields, (field) => field.bytes),
    ...outer,
    ...markedContentFields(message),
    message.rest,
  ]);
};

/**
 * A fixed boundary is safe: the only content is ASCII armor (base64 lines and `-----BEGIN/END`
 * lines), which can't contain `_`, and the encrypted message itself is not visible here.
 */
const BOUNDARY = "=_alias_pgp_mime";

const multipart = (armored: string, eol: string): string =>
  [
    "This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)",
    `--${BOUNDARY}`,
    "Content-Type: application/pgp-encrypted",
    "Content-Description: PGP/MIME version identification",
    "",
    "Version: 1",
    "",
    `--${BOUNDARY}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    "Content-Description: OpenPGP encrypted message",
    'Content-Disposition: inline; filename="encrypted.asc"',
    "",
    ...armored.replace(/\r?\n$/, "").split(/\r?\n/),
    `--${BOUNDARY}--`,
    "",
  ].join(eol);

const isOuterRemoved = (isSubjectHidden: boolean) => (field: Headers.Field) =>
  isContentField(field) ||
  field.name === "mime-version" ||
  (isSubjectHidden && (field.name === "subject" || HashSet.has(REMOVED_OUTSIDE, field.name)));

/**
 * Encrypts a message to `key` (armored, as {@link readKey} stored it) as PGP/MIME (RFC 3156 §4):
 * `multipart/encrypted; protocol="application/pgp-encrypted"` with the version part and the
 * armored OpenPGP message. Every header field but `Content-*` and `MIME-Version` stays outside
 * as it was, so routing, threading and our loop marker keep working. The encrypted part is the
 * message's `Content-*` fields and body, byte for byte, so a signed message (`multipart/signed`)
 * still verifies after decryption.
 *
 * With `isSubjectHidden`, the subject is replaced by `[...]` outside and protected inside (RFC
 * 9788 header protection, `hcp_baseline`). No legacy display part is added: it would change the
 * body, and clients that read neither marker show `[...]`, which the owner opted into.
 *
 * Already encrypted mail comes back unchanged. Fails with `InvalidKey` when the key can no
 * longer encrypt at `now` (it expired or was revoked since it was stored); mail is never sent
 * in the clear instead.
 */
export const encrypt = Effect.fn("Pgp.encrypt")(function* (
  raw: Uint8Array,
  options: {
    readonly key: string;
    readonly isSubjectHidden: boolean;
    readonly now: DateTime.Utc;
  },
) {
  const message = yield* Headers.parse(raw);
  if (isEncrypted(message)) return raw;
  // Checked first for a reason: OpenPGP.js's `encrypt` only says that no key was usable.
  const { key } = yield* validate(options.key, options.now);
  const date = DateTime.toDate(options.now);
  const armored = yield* Effect.tryPromise({
    try: () =>
      openpgp
        .createMessage({ binary: payload(message, options.isSubjectHidden), date })
        .then((literal) =>
          openpgp.encrypt({ message: literal, encryptionKeys: key, date, format: "armored" }),
        ),
    catch: () => invalid("no-encryption-key"),
  });
  const eol = message.lineEnding;
  const prepend = [
    ...(options.isSubjectHidden && Arr.some(message.fields, (field) => field.name === "subject")
      ? [`Subject: ${OBSCURED_SUBJECT}`]
      : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted";${eol} boundary="${BOUNDARY}"`,
  ];
  const outer = Headers.rewrite(message, isOuterRemoved(options.isSubjectHidden), prepend);
  // `rewrite` keeps the original blank line and body; replace them with the multipart body.
  const headerLength = outer.byteLength - message.rest.byteLength;
  return concat([outer.subarray(0, headerLength), utf8(`${eol}${multipart(armored, eol)}`)]);
});
