import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { constantTimeEqual, utf8 } from "./internal/bytes.ts";
import { hmacSha256 } from "./internal/hmac.ts";

/**
 * Standard Webhooks (https://www.standardwebhooks.com, spec read 2026-10-22): an endpoint's
 * symmetric secret, and the `webhook-signature` header computed from it.
 *
 * - The secret is 24 to 64 random bytes, base64 with a `whsec_` prefix. We mint 32.
 * - The signed content is `<webhook-id>.<webhook-timestamp>.<body>`, the body byte for byte.
 * - The header is a space-separated list of `v1,<base64 HMAC-SHA256>`, one per secret: during a
 *   rotation, the old and the new secret both sign.
 */

const PREFIX = "whsec_";
const SECRET_BYTES = 32;

/** A fresh endpoint secret, as shown to its owner once. */
export const newSecret = Effect.fn("Webhook.newSecret")(function* () {
  const crypto = yield* Crypto.Crypto;
  return `${PREFIX}${Base64.encode(yield* crypto.randomBytes(SECRET_BYTES))}`;
});

/** The key bytes of a `whsec_` secret; None unless it is base64 of 24 to 64 bytes. */
export const secretKey = (secret: string): Option.Option<Uint8Array> =>
  Option.filter(
    Result.getSuccess(Base64.decode(Str.startsWith(PREFIX)(secret) ? secret.slice(6) : secret)),
    (key) => key.length >= 24 && key.length <= 64,
  );

const signedContent = (id: string, timestamp: number, body: string) =>
  utf8(`${id}.${timestamp}.${body}`);

/** One `v1,<signature>` per secret, space-separated, for the `webhook-signature` header. */
export const sign = Effect.fn("Webhook.sign")(function* (message: {
  readonly secrets: ReadonlyArray<Uint8Array>;
  readonly id: string;
  /** Unix seconds; the same value goes in `webhook-timestamp`. */
  readonly timestamp: number;
  readonly body: string;
}) {
  const content = signedContent(message.id, message.timestamp, message.body);
  const signatures = yield* Effect.forEach(
    message.secrets,
    (key) => Effect.map(hmacSha256(key, content), (mac) => `v1,${Base64.encode(mac)}`),
    { concurrency: 1 },
  );
  return Arr.join(signatures, " ");
});

/**
 * What a receiver does, as the spec asks: the timestamp must be within `toleranceSeconds` of
 * `now` (replay protection), and one of the header's `v1` signatures must match `secret`
 * (compared in constant time).
 */
export const verify = Effect.fn("Webhook.verify")(function* (message: {
  readonly secret: string;
  readonly id: string;
  readonly timestamp: number;
  readonly signature: string;
  readonly body: string;
  readonly nowSeconds: number;
  readonly toleranceSeconds?: number;
}) {
  const key = secretKey(message.secret);
  if (Option.isNone(key)) return false;
  if (Math.abs(message.nowSeconds - message.timestamp) > (message.toleranceSeconds ?? 300)) {
    return false;
  }
  const expected = yield* hmacSha256(
    key.value,
    signedContent(message.id, message.timestamp, message.body),
  );
  return Arr.some(message.signature.split(" "), (entry) => {
    const [version, value = ""] = entry.split(",");
    return (
      version === "v1" &&
      Result.match(Base64.decode(value), {
        onFailure: () => false,
        onSuccess: (mac) => constantTimeEqual(mac, expected),
      })
    );
  });
});
