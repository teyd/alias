import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import { Hex } from "effect/encoding";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Address, Keyring, ReverseToken } from "../src/index.ts";
import * as Base32 from "../src/internal/base32.ts";
import { hmacSha256 } from "../src/internal/hmac.ts";
import { bytes } from "./support/mime.ts";

const key = (version: number, fill: number): Keyring.Key => ({
  version,
  secret: Redacted.make(new Uint8Array(32).fill(fill)),
});

const sender = (address: string): ReverseToken.Subject => ({
  sender: Option.some(address),
  contactId: Option.none(),
});

const alias: Address.MailAddress = { local: "k7m2qx9p", domain: "alias.test" };

/** The tagged error's reason (or tag); fails the test if the effect succeeds. */
const failureReason = <A, E extends { readonly _tag: string }, R>(self: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(self), (error) =>
    P.hasProperty(error, "reason") && P.isString(error.reason) ? error.reason : error._tag,
  );

describe("base32", () => {
  // RFC 4648 §10, lowercased and unpadded.
  it.each([
    ["", ""],
    ["f", "my"],
    ["fo", "mzxq"],
    ["foo", "mzxw6"],
    ["foob", "mzxw6yq"],
    ["fooba", "mzxw6ytb"],
    ["foobar", "mzxw6ytboi"],
  ])("encodes %j as %j", (input, expected) => {
    expect(Base32.encode(bytes(input))).toBe(expected);
    expect(Base32.decode(expected.toUpperCase())).toEqual(Option.some(bytes(input)));
  });

  it("rejects non-canonical spellings and foreign characters", () => {
    expect(Option.isNone(Base32.decode("mz"))).toBe(true); // trailing bits set
    expect(Option.isNone(Base32.decode("mya"))).toBe(true); // spare character
    expect(Option.isNone(Base32.decode("my0"))).toBe(true); // not in the alphabet
  });

  it.prop("round-trips any bytes", [Arbitrary.schema(Schema.Uint8Array)], ([data]) => {
    const text = Base32.encode(data);
    expect(text).toMatch(/^[a-z2-7]*$/);
    expect(Base32.decode(text)).toEqual(Option.some(data));
  });
});

layer(NodeCrypto.layer)((it) => {
  describe("newContactId", () => {
    it.effect("is 16 base32 characters of fresh randomness that a token carries", () =>
      Effect.gen(function* () {
        const ids = yield* Effect.all(
          Array.from({ length: 50 }, () => ReverseToken.newContactId()),
          { concurrency: 1 },
        );
        expect(ids.every((id) => /^[a-z2-7]{16}$/.test(id))).toBe(true);
        expect(HashSet.size(HashSet.fromIterable(ids))).toBe(50);

        const keys = yield* Keyring.make({
          current: { version: 1, secret: Redacted.make(new Uint8Array(32).fill(5)) },
          retired: [],
        });
        const alias = { local: "shop", domain: "alias.test" };
        const contactId = ids[0] ?? "";
        const token = yield* ReverseToken.mint(keys, alias, {
          sender: Option.none(),
          contactId: Option.some(contactId),
        });
        expect(token).toHaveLength(47);
        expect(yield* ReverseToken.verify(keys, alias, token)).toEqual({
          sender: Option.none(),
          contactId: Option.some(contactId),
          keyVersion: 1,
        });
      }),
    );
  });

  describe("hmacSha256", () => {
    // RFC 4231 test cases 1, 2 and 6 (a key longer than the block size).
    it.effect.each([
      {
        name: "case 1",
        key: new Uint8Array(20).fill(0x0b),
        data: "Hi There",
        mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
      },
      {
        name: "case 2",
        key: bytes("Jefe"),
        data: "what do ya want for nothing?",
        mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
      },
      {
        name: "case 6",
        key: new Uint8Array(131).fill(0xaa),
        data: "Test Using Larger Than Block-Size Key - Hash Key First",
        mac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
      },
    ])("matches RFC 4231 $name", ({ key, data, mac }) =>
      Effect.map(hmacSha256(key, bytes(data)), (computed) => {
        expect(Hex.encode(computed)).toBe(mac);
      }),
    );
  });

  describe("ReverseToken", () => {
    it.effect("round-trips a sender and fits the inbound address rules", () =>
      Effect.gen(function* () {
        const keys = yield* Keyring.make({ current: key(1, 7), retired: [] });
        const token = yield* ReverseToken.mint(keys, alias, sender("Billing@Shop.example"));
        expect(token).toMatch(/^[a-z2-7]+$/);

        const inbound = yield* Address.parse(
          Address.format(Address.reverseAddress(alias, token)).toUpperCase(),
        );
        const split = yield* Effect.fromOption(Address.reverseToken(inbound));
        const claims = yield* ReverseToken.verify(
          keys,
          { local: split.aliasLocal, domain: inbound.domain },
          split.token,
        );
        expect(claims).toEqual({
          keyVersion: 1,
          sender: Option.some("Billing@Shop.example"),
          contactId: Option.none(),
        });
      }),
    );

    it.effect("carries a contact id instead of, or next to, the sender", () =>
      Effect.gen(function* () {
        const keys = yield* Keyring.make({ current: key(1, 7), retired: [] });
        const contactOnly = { sender: Option.none(), contactId: Option.some("ct_01jb7") };
        const both = { sender: Option.some("a@b.example"), contactId: Option.some("ct_01jb7") };
        const short = yield* ReverseToken.mint(keys, alias, contactOnly);
        expect(yield* ReverseToken.verify(keys, alias, short)).toEqual({
          ...contactOnly,
          keyVersion: 1,
        });
        const long = yield* ReverseToken.mint(keys, alias, both);
        expect(yield* ReverseToken.verify(keys, alias, long)).toEqual({ ...both, keyVersion: 1 });
        // 1 header + 1 key version + 1 length + 8 id + 10 MAC = 21 bytes = 34 base32 characters.
        expect(short).toHaveLength(34);
      }),
    );

    it.effect("is bound to the alias it was minted for", () =>
      Effect.gen(function* () {
        const keys = yield* Keyring.make({ current: key(1, 7), retired: [] });
        const token = yield* ReverseToken.mint(keys, alias, sender("a@b.example"));
        const otherLocal = yield* failureReason(
          ReverseToken.verify(keys, { ...alias, local: "other" }, token),
        );
        const otherDomain = yield* failureReason(
          ReverseToken.verify(keys, { ...alias, domain: "user1.alias.test" }, token),
        );
        expect(otherLocal).toBe("bad-signature");
        expect(otherDomain).toBe("bad-signature");
      }),
    );

    it.effect("keeps verifying retired keys after rotation and rejects removed ones", () =>
      Effect.gen(function* () {
        const before = yield* Keyring.make({ current: key(1, 7), retired: [] });
        const token = yield* ReverseToken.mint(before, alias, sender("a@b.example"));
        const rotated = yield* Keyring.make({ current: key(2, 9), retired: [key(1, 7)] });
        expect((yield* ReverseToken.verify(rotated, alias, token)).keyVersion).toBe(1);
        expect(
          (yield* ReverseToken.verify(
            rotated,
            alias,
            yield* ReverseToken.mint(rotated, alias, sender("a@b.example")),
          )).keyVersion,
        ).toBe(2);
        const dropped = yield* Keyring.make({ current: key(2, 9), retired: [] });
        expect(yield* failureReason(ReverseToken.verify(dropped, alias, token))).toBe(
          "unknown-key",
        );
        // Same version, different secret: a leaked-key rotation that reused the number.
        const replaced = yield* Keyring.make({ current: key(1, 8), retired: [] });
        expect(yield* failureReason(ReverseToken.verify(replaced, alias, token))).toBe(
          "bad-signature",
        );
      }),
    );

    it.effect("rejects garbage, truncation and unknown formats", () =>
      Effect.gen(function* () {
        const keys = yield* Keyring.make({ current: key(1, 7), retired: [] });
        const token = yield* ReverseToken.mint(keys, alias, sender("a@b.example"));
        const reason = (candidate: string) =>
          failureReason(ReverseToken.verify(keys, alias, candidate));
        const decoded = yield* Effect.fromOption(Base32.decode(token));
        expect(yield* reason("not base32!")).toBe("malformed");
        expect(yield* reason("")).toBe("malformed");
        expect(yield* reason(token.slice(0, 16))).toBe("malformed");
        // Format version 2, same everything else.
        const bumped = Base32.encode(
          Uint8Array.from(decoded, (byte, i) => (i === 0 ? (2 << 4) | (byte & 0x0f) : byte)),
        );
        expect(yield* reason(bumped)).toBe("malformed");
        // A field bit nobody defined yet.
        const extraBit = Base32.encode(
          Uint8Array.from(decoded, (byte, i) => (i === 0 ? byte | 0b0100 : byte)),
        );
        expect(yield* reason(extraBit)).toBe("malformed");
      }),
    );

    it.effect.prop(
      "any changed character invalidates the token",
      [Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })))],
      ([seed]) =>
        Effect.gen(function* () {
          const keys = yield* Keyring.make({ current: key(3, 1), retired: [] });
          const token = yield* ReverseToken.mint(keys, alias, sender("news@letters.example"));
          const position = seed % token.length;
          const original = token.charAt(position);
          const replacement = "abcdefghijklmnopqrstuvwxyz234567".charAt(
            ("abcdefghijklmnopqrstuvwxyz234567".indexOf(original) + 1 + (seed % 31)) % 32,
          );
          const tampered = token.slice(0, position) + replacement + token.slice(position + 1);
          expect(yield* failureReason(ReverseToken.verify(keys, alias, tampered))).toMatch(
            /malformed|unknown-key|bad-signature/,
          );
        }),
    );

    it.effect.prop(
      "round-trips any short sender address, including non-ASCII",
      [
        Arbitrary.schema(
          Schema.String.check(
            Schema.isMinLength(1),
            Schema.isMaxLength(40),
            Schema.isPattern(/^[^\p{Surrogate}]*$/u),
          ),
        ),
      ],
      ([text]) =>
        Effect.gen(function* () {
          const keys = yield* Keyring.make({ current: key(0, 5), retired: [] });
          const address = `${text}@x.example`;
          const token = yield* ReverseToken.mint(keys, alias, sender(address));
          const claims = yield* ReverseToken.verify(keys, alias, token);
          expect(claims.sender).toEqual(Option.some(address.trim()));
        }),
    );

    it.effect("refuses subjects it cannot encode", () =>
      Effect.gen(function* () {
        const keys = yield* Keyring.make({ current: key(1, 7), retired: [] });
        const reason = (subject: ReverseToken.Subject) =>
          failureReason(ReverseToken.mint(keys, alias, subject));
        expect(yield* reason({ sender: Option.none(), contactId: Option.none() })).toMatch(/needs/);
        expect(yield* reason(sender("   "))).toMatch(/empty/);
        expect(yield* reason(sender("a\ud800@b.example"))).toMatch(/Unicode/);
        expect(
          yield* reason({ sender: Option.none(), contactId: Option.some("x".repeat(65)) }),
        ).toMatch(/contact id/);
        // The reverse address would pass the 254-character address limit.
        expect(yield* reason(sender(`${"v".repeat(130)}@bounces.example`))).toMatch(/too long/);
      }),
    );

    it.effect("validates the keyring", () =>
      Effect.gen(function* () {
        const reason = (keys: { current: Keyring.Key; retired: ReadonlyArray<Keyring.Key> }) =>
          failureReason(Keyring.make(keys));
        expect(yield* reason({ current: key(256, 1), retired: [] })).toMatch(/0 to 255/);
        expect(yield* reason({ current: key(1, 1), retired: [key(1, 2)] })).toMatch(/distinct/);
        const weak = { version: 1, secret: Redacted.make(new Uint8Array(16)) };
        expect(yield* reason({ current: weak, retired: [] })).toMatch(/32 bytes/);
      }),
    );
  });
});
