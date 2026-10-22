import { NodeCrypto, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as openpgp from "openpgp";
import { Address, Mail, Pgp, PgpKey } from "../src/index.ts";
import { newsletter } from "./support/fixtures.ts";
import { signer } from "./support/imageProxy.ts";
import { binary, bytes, split, values } from "./support/mime.ts";

const now = DateTime.makeUnsafe("2026-10-22T08:00:00Z");
const before = (duration: Duration.Input) =>
  DateTime.toDate(DateTime.subtractDuration(now, duration));

interface KeyOptions {
  readonly type?: "curve25519" | "rsa";
  readonly rsaBits?: number;
  readonly keyExpirationTime?: number;
  readonly subkeys?: Array<{ readonly sign?: boolean }>;
}

const generate = (options: KeyOptions = {}) =>
  Effect.promise(() =>
    openpgp.generateKey({
      userIDs: [{ name: "Ada Lovelace", email: "ada@mailbox.example" }],
      type: "curve25519",
      date: before(Duration.days(30)),
      ...options,
      format: "object",
    }),
  );

const ada = generate();

/**
 * Test-side reading of a PGP/MIME message: an independent check of RFC 3156 §4's structure,
 * then decryption with the private key. Returns the decrypted payload.
 */
const decrypt = (out: Uint8Array, privateKey: openpgp.PrivateKey) =>
  Effect.promise(async () => {
    const { rest } = split(out);
    const [contentType] = values(out, "Content-Type");
    expect(contentType).toBe(
      'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="=_alias_pgp_mime"',
    );
    expect(values(out, "MIME-Version")).toEqual(["1.0"]);
    const parts = binary(rest).split(/\r?\n--=_alias_pgp_mime(?:--)?\r?\n/);
    // Preamble, the two parts, the empty epilogue.
    expect(parts).toHaveLength(4);
    const [, control = "", data = ""] = parts;
    expect(control).toMatch(/^Content-Type: application\/pgp-encrypted\r?\n/);
    expect(control).toMatch(/\r?\n\r?\nVersion: 1\r?\n$/);
    expect(data).toMatch(/^Content-Type: application\/octet-stream/);
    const armored = /-----BEGIN PGP MESSAGE-----[\s\S]*-----END PGP MESSAGE-----/.exec(data)?.[0];
    const message = await openpgp.readMessage({ armoredMessage: armored ?? "" });
    const { data: plain } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
      format: "binary",
      date: DateTime.toDate(now),
    });
    return new Uint8Array(plain);
  });

/**
 * Independently of the production code: the `Content-*` fields of a message's header block, as
 * raw bytes (folding included), followed by everything from the blank line on.
 */
const mimeEntity = (raw: Uint8Array): string => {
  const text = binary(raw);
  const blank = /\r?\n\r?\n/.exec(text);
  const headerEnd = (blank?.index ?? 0) + (blank?.[0].startsWith("\r") ? 2 : 1);
  const fields = text.slice(0, headerEnd).split(/(?<=\n)(?=[^ \t])/);
  return fields.filter((field) => /^content-/i.test(field)).join("") + text.slice(headerEnd);
};

const encrypt = (raw: Uint8Array, key: string, isSubjectHidden = false) =>
  Pgp.encrypt(raw, { key, isSubjectHidden, now });

const alias: Address.MailAddress = { local: "k7m2qx9p", domain: "alias.test" };

/**
 * The newsletter fixture after `Mail.forward` with the default tracker protection: what the
 * pipeline hands to `Pgp.encrypt`.
 */
const forwarded = (eol: string) =>
  Mail.forward(newsletter(eol), {
    alias,
    sender: { name: Option.some("Café Müller"), address: "news@cafe.example" },
    token: "ceaqyyzlmfuwyqdcfzswqylnobwgkc5o6ccdy2xqc",
    protection: { images: "block-trackers", isLinkCleaningEnabled: true },
    imageProxy: signer,
  }).pipe(Effect.provide(NodeCrypto.layer));

const headerNames = (data: Uint8Array) => split(data).fields.map((field) => field.name);

describe("Pgp.readKey", () => {
  it.effect("accepts a public key that can encrypt and describes it", () =>
    Effect.gen(function* () {
      const { publicKey } = yield* ada;
      const key = yield* Pgp.readKey(publicKey.armor(), now);
      expect(key.fingerprint).toBe(publicKey.getFingerprint().toUpperCase());
      expect(key.fingerprint).toMatch(/^[0-9A-F]{40,64}$/);
      expect(key.userIds).toEqual(["Ada Lovelace <ada@mailbox.example>"]);
      expect(key.expiresAt).toEqual(Option.none());
      expect(key.armored).toMatch(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/);
    }),
  );

  it.effect("reports the earlier of the key's and the encryption subkey's expiry", () =>
    Effect.gen(function* () {
      const { publicKey } = yield* generate({ keyExpirationTime: 365 * 24 * 3600 });
      const key = yield* Pgp.readKey(publicKey.armor(), now);
      expect(Option.map(key.expiresAt, DateTime.formatIso)).toEqual(
        Option.some(
          DateTime.formatIso(
            DateTime.addDuration(
              DateTime.makeUnsafe(before(Duration.days(30))),
              Duration.days(365),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("ignores text around the armor, and keeps only the key", () =>
    Effect.gen(function* () {
      const { publicKey } = yield* ada;
      const pasted = `Here is my key:\n\n${publicKey.armor()}\nThanks!\n`;
      const key = yield* Pgp.readKey(pasted, now);
      expect(key.armored).toBe(publicKey.armor());
    }),
  );

  const refused = (armored: string) => Effect.flip(Pgp.readKey(armored, now));

  it.effect("refuses what isn't a key, or is too large", () =>
    Effect.gen(function* () {
      expect((yield* refused("not a key")).reason).toBe("malformed");
      expect((yield* refused("")).reason).toBe("malformed");
      const { publicKey } = yield* ada;
      const garbled = publicKey.armor().replace(/\n[A-Za-z0-9+/]{20}/, "\n!!!!");
      expect((yield* refused(garbled)).reason).toBe("malformed");
      expect((yield* refused("x".repeat(PgpKey.MAX_KEY_BYTES + 1))).reason).toBe("too-large");
    }),
  );

  it.effect("refuses a private key without keeping any of it", () =>
    Effect.gen(function* () {
      const { privateKey } = yield* ada;
      const error = yield* refused(privateKey.armor());
      expect(error.reason).toBe("private-key");
      expect(JSON.stringify(error)).not.toContain("PRIVATE");
    }),
  );

  it.effect("refuses two keys in one block", () =>
    Effect.gen(function* () {
      const first = yield* ada;
      const second = yield* generate();
      const both = openpgp.armor(
        openpgp.enums.armor.publicKey,
        Uint8Array.from([...first.publicKey.write(), ...second.publicKey.write()]),
      );
      expect((yield* refused(both)).reason).toBe("multiple-keys");
    }),
  );

  it.effect("refuses an expired key, a revoked key and a key without an encryption subkey", () =>
    Effect.gen(function* () {
      const expired = yield* generate({ keyExpirationTime: 24 * 3600 });
      expect((yield* refused(expired.publicKey.armor())).reason).toBe("expired");

      const { privateKey } = yield* ada;
      const { publicKey: revoked } = yield* Effect.promise(() =>
        openpgp.revokeKey({ key: privateKey, date: before(Duration.days(1)), format: "object" }),
      );
      expect((yield* refused(revoked.armor())).reason).toBe("revoked");

      const signOnly = yield* generate({ subkeys: [{ sign: true }] });
      expect((yield* refused(signOnly.publicKey.armor())).reason).toBe("no-encryption-key");
    }),
  );

  it.effect("judges a key at the time it is asked about", () =>
    Effect.gen(function* () {
      const { publicKey } = yield* generate({ keyExpirationTime: 60 * 24 * 3600 });
      yield* Pgp.readKey(publicKey.armor(), now);
      const later = DateTime.addDuration(now, Duration.days(31));
      const error = yield* Effect.flip(Pgp.readKey(publicKey.armor(), later));
      expect(error.reason).toBe("expired");
    }),
  );
});

describe("Pgp.encrypt", () => {
  describe.each([
    ["CRLF", "\r\n"],
    ["LF", "\n"],
  ])("with %s line endings", (_, eol) => {
    it.effect("wraps the forwarded message as PGP/MIME that decrypts to its MIME entity", () =>
      Effect.gen(function* () {
        const { publicKey, privateKey } = yield* ada;
        const input = yield* forwarded(eol);
        const out = yield* encrypt(input, publicKey.armor());
        const payload = yield* decrypt(out, privateKey);
        // Byte for byte: the Content-* fields, the blank line, the body (8-bit and binary parts too).
        expect(binary(payload)).toBe(mimeEntity(input));
        // Outside the ciphertext, every line ends the way the message's lines do.
        expect(/\r(?!\n)|(?<!\r)\n/.test(binary(out))).toBe(eol === "\n");
        expect(binary(out).includes("\r")).toBe(eol === "\r\n");
      }),
    );

    it.effect("keeps every routing header outside, as the rewrite produced it", () =>
      Effect.gen(function* () {
        const { publicKey } = yield* ada;
        const input = yield* forwarded(eol);
        const out = yield* encrypt(input, publicKey.armor());
        const outside = (data: Uint8Array) =>
          split(data).fields.filter((field) => !/^(content-|mime-version$)/i.test(field.name));
        expect(outside(out)).toEqual(outside(input));
        expect(values(out, "Subject")).toEqual(values(input, "Subject"));
        expect(values(out, "X-Alias-Forwarded")).toEqual(["k7m2qx9p@alias.test"]);
        expect(headerNames(out).slice(0, 2)).toEqual(["MIME-Version", "Content-Type"]);
        // Nothing of the content is readable outside the armor.
        expect(binary(out)).not.toContain("Küche");
        expect(binary(out)).not.toContain("menu.bin");
      }),
    );
  });

  it.effect("protects the subject when asked: [...] outside, the real fields inside", () =>
    Effect.gen(function* () {
      const { publicKey, privateKey } = yield* ada;
      const input = yield* forwarded("\r\n");
      const out = yield* encrypt(input, publicKey.armor(), true);
      expect(values(out, "Subject")).toEqual(["[...]"]);
      expect(values(out, "From")).toEqual(values(input, "From"));
      const payload = yield* decrypt(out, privateKey);
      const inner = split(payload);
      expect(values(payload, "Subject")).toEqual(values(input, "Subject"));
      expect(values(payload, "From")).toEqual(values(input, "From"));
      expect(values(payload, "Message-ID")).toEqual(values(input, "Message-ID"));
      expect(values(payload, "HP-Outer")).toContain("Subject: [...]");
      expect(values(payload, "Content-Type")[0]).toMatch(
        /^multipart\/mixed; boundary="=_outer_9c1"; protected-headers="v1"; hp="cipher"$/,
      );
      // The body is untouched.
      expect(binary(inner.rest)).toBe(binary(split(input).rest));
    }),
  );

  it.effect("decrypts with a key that has several encryption subkeys, RSA included", () =>
    Effect.gen(function* () {
      const { publicKey, privateKey } = yield* generate({ type: "rsa", rsaBits: 3072 });
      const input = yield* forwarded("\r\n");
      const payload = yield* decrypt(yield* encrypt(input, publicKey.armor()), privateKey);
      expect(binary(payload)).toBe(mimeEntity(input));
    }),
  );

  it.effect("fails with the reason, never in the clear, once the stored key can't encrypt", () =>
    Effect.gen(function* () {
      const { publicKey } = yield* generate({ keyExpirationTime: 24 * 3600 });
      const error = yield* Effect.flip(encrypt(yield* forwarded("\r\n"), publicKey.armor()));
      expect(error).toMatchObject({ _tag: "InvalidKey", reason: "expired" });
    }),
  );

  it.effect("fails on a message without a header block", () =>
    Effect.gen(function* () {
      const { publicKey } = yield* ada;
      const error = yield* Effect.flip(encrypt(bytes("\r\nbody only"), publicKey.armor()));
      expect(error._tag).toBe("MalformedMessage");
    }),
  );
});

describe("Pgp.encrypt on the golden corpus", () => {
  const read = (file: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.readFile(new URL(`./corpus/pgp/${file}`, import.meta.url).pathname),
    ).pipe(
      Effect.map((data) => new Uint8Array(data)),
      Effect.provide(NodeServices.layer),
    );

  /** The ciphertext differs on every run; the expected files hold this line in its place. */
  const masked = (out: Uint8Array) =>
    binary(out).replace(
      /-----BEGIN PGP MESSAGE-----[\s\S]*-----END PGP MESSAGE-----/,
      "<armored OpenPGP message>",
    );

  const encrypted = [
    { name: "signed", isSubjectHidden: false },
    { name: "no-content-type", isSubjectHidden: false },
    { name: "smime-signed-data", isSubjectHidden: false },
    { name: "subject-hidden", isSubjectHidden: true },
  ];

  it.effect.each(encrypted)(
    "$name: matches the reviewed output and decrypts to the reviewed payload",
    ({ name, isSubjectHidden }) =>
      Effect.gen(function* () {
        const { publicKey, privateKey } = yield* ada;
        const input = yield* read(`${name}.eml`);
        const out = yield* encrypt(input, publicKey.armor(), isSubjectHidden);
        expect(masked(out)).toBe(binary(yield* read(`${name}.expected.eml`)));
        const payload = yield* decrypt(out, privateKey);
        expect(binary(payload)).toBe(binary(yield* read(`${name}.payload.eml`)));
      }),
  );

  it.effect.each(Arr.filter(encrypted, ({ isSubjectHidden }) => !isSubjectHidden))(
    "$name: the reviewed payload is the input's MIME entity, byte for byte",
    ({ name }) =>
      Effect.gen(function* () {
        const payload = yield* read(`${name}.payload.eml`);
        expect(binary(payload)).toBe(mimeEntity(yield* read(`${name}.eml`)));
      }),
  );

  it.effect.each(["pgp-mime", "smime-enveloped"])(
    "%s: already encrypted, passes through unchanged",
    (name) =>
      Effect.gen(function* () {
        const { publicKey } = yield* ada;
        const input = yield* read(`${name}.eml`);
        expect(binary(yield* encrypt(input, publicKey.armor(), true))).toBe(binary(input));
      }),
  );

  it.effect("a multipart/signed message still has its exact signed bytes after decryption", () =>
    Effect.gen(function* () {
      const { publicKey, privateKey } = yield* ada;
      const input = yield* read("signed.eml");
      const payload = binary(yield* decrypt(yield* encrypt(input, publicKey.armor()), privateKey));
      // RFC 3156 §5: the signed part is the first body part, canonical CRLF, unchanged.
      const signedPart = /--sig_b1\r\n([\s\S]*?)\r\n--sig_b1\r\n/.exec(binary(input))?.[1];
      expect(signedPart).toBeDefined();
      expect(payload).toContain(`--sig_b1\r\n${signedPart}\r\n--sig_b1\r\n`);
    }),
  );
});
