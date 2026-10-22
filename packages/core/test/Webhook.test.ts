import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Webhook } from "../src/index.ts";

/**
 * A published example signature for this scheme: Svix (the authors of Standard Webhooks, whose
 * `svix-*` headers are the same scheme) in "Verifying webhooks manually",
 * https://docs.svix.com/receiving/verifying-payloads/how-manual (read 2026-10-22).
 */
const reference = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

describe("Webhook (Standard Webhooks)", () => {
  it.effect("signs the reference example exactly", () =>
    Effect.gen(function* () {
      const key = Option.getOrElse(Webhook.secretKey(reference.secret), () => new Uint8Array());
      const signature = yield* Webhook.sign({
        secrets: [key],
        id: reference.id,
        timestamp: reference.timestamp,
        body: reference.body,
      });
      expect(signature).toBe(reference.signature);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("verifies within the tolerance, any listed signature, and nothing tampered", () =>
    Effect.gen(function* () {
      const verify = (overrides: Partial<Parameters<typeof Webhook.verify>[0]> = {}) =>
        Webhook.verify({ ...reference, nowSeconds: reference.timestamp + 10, ...overrides });
      expect(yield* verify()).toBe(true);
      expect(yield* verify({ signature: `v1,AAAA ${reference.signature}` })).toBe(true);
      expect(yield* verify({ body: '{"test": 2432232315}' })).toBe(false);
      expect(yield* verify({ id: "msg_other" })).toBe(false);
      expect(yield* verify({ signature: reference.signature.replace("v1", "v2") })).toBe(false);
      expect(yield* verify({ nowSeconds: reference.timestamp + 301 })).toBe(false);
      expect(yield* verify({ nowSeconds: reference.timestamp - 301 })).toBe(false);
      expect(yield* verify({ secret: "whsec_c2hvcnQ=" })).toBe(false);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("mints whsec_ secrets of 32 random bytes", () =>
    Effect.gen(function* () {
      const secret = yield* Webhook.newSecret();
      expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
      expect(Option.map(Webhook.secretKey(secret), (key) => key.length)).toEqual(Option.some(32));
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
