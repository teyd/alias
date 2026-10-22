import { Keyring } from "@alias/core";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Envelope } from "../src/index.ts";
import { TEST_INBOX_KEYS } from "./support/index.ts";

const ROTATED = "cm90YXRlZC1pbmJveC1rZXktZm9yLXRlc3RzLW9ubHk";
const keyring = (value: string) => Keyring.parse(Redacted.make(value));
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

const context = { aliasId: "al_1", messageId: "msg_1" };
const parts = {
  body: bytes("Subject: hi\r\n\r\nYour code is 482913"),
  summary: bytes('{"preview":"x"}'),
};

const openBoth = (keys: Keyring.Keyring, sealed: Envelope.Sealed, at = context) =>
  Effect.gen(function* () {
    const dataKey = yield* Envelope.unwrap(keys, at, sealed);
    return {
      body: text(yield* Envelope.openPart(dataKey, at, "body", sealed.body)),
      summary: text(yield* Envelope.openPart(dataKey, at, "summary", sealed.summary)),
    };
  });

describe("Envelope", () => {
  it.effect("seals body and summary under a fresh data key and opens them again", () =>
    Effect.gen(function* () {
      const keys = yield* keyring(`1:${TEST_INBOX_KEYS.slice(2)}`);
      const sealed = yield* Envelope.sealMessage(keys, context, parts);
      expect(sealed.keyVersion).toBe(1);
      // Ciphertext only: the plaintext appears nowhere, and two seals of the same body differ.
      expect(Buffer.from(sealed.body).includes("482913")).toBe(false);
      expect(sealed.body.length).toBe(parts.body.length + 1 + 12 + 16);
      const again = yield* Envelope.sealMessage(keys, context, parts);
      expect(Buffer.from(again.body).equals(Buffer.from(sealed.body))).toBe(false);
      expect(yield* openBoth(keys, sealed)).toEqual({
        body: text(parts.body),
        summary: text(parts.summary),
      });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("opens nothing moved to another message, swapped between parts or tampered", () =>
    Effect.gen(function* () {
      const keys = yield* keyring(TEST_INBOX_KEYS);
      const sealed = yield* Envelope.sealMessage(keys, context, parts);
      const elsewhere = yield* Effect.flip(
        openBoth(keys, sealed, { ...context, messageId: "msg_2" }),
      );
      expect(elsewhere._tag).toBe("EnvelopeError");
      const dataKey = yield* Envelope.unwrap(keys, context, sealed);
      const swapped = yield* Effect.flip(
        Envelope.openPart(dataKey, context, "summary", sealed.body),
      );
      expect(swapped.reason).toBe("summary does not authenticate");
      const tampered = Uint8Array.from(sealed.body);
      tampered[20] = (tampered[20] ?? 0) ^ 1;
      expect(
        (yield* Effect.flip(Envelope.openPart(dataKey, context, "body", tampered))).reason,
      ).toBe("body does not authenticate");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("rotation: a new current key wraps, the retired one still opens older mail", () =>
    Effect.gen(function* () {
      const before = yield* keyring(TEST_INBOX_KEYS);
      const old = yield* Envelope.sealMessage(before, context, parts);
      // Step 1: the new key is added after the current one; step 2: it moves to the front.
      const during = yield* keyring(`${TEST_INBOX_KEYS},2:${ROTATED}`);
      const after = yield* keyring(`2:${ROTATED},${TEST_INBOX_KEYS}`);
      expect((yield* openBoth(during, old)).body).toBe(text(parts.body));
      const fresh = yield* Envelope.sealMessage(after, context, parts);
      expect(fresh.keyVersion).toBe(2);
      expect((yield* openBoth(after, old)).body).toBe(text(parts.body));
      expect((yield* openBoth(during, fresh)).body).toBe(text(parts.body));
      // Once mail older than the longest retention is gone, the old key can go too.
      const only = yield* keyring(`2:${ROTATED}`);
      expect((yield* Effect.flip(openBoth(only, old))).reason).toBe("no inbox key version 1");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
