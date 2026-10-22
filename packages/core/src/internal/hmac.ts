import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { concat } from "./bytes.ts";

const BLOCK_BYTES = 64;

/**
 * HMAC-SHA-256 (RFC 2104) on top of the `Crypto` service's digest. The service has no keyed
 * MAC, and building it here keeps core free of platform globals: the same code runs on Node,
 * Lambda and in the browser, and tests provide the digest like any other service.
 */
export const hmacSha256 = Effect.fn("hmacSha256")(function* (key: Uint8Array, message: Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  const block = new Uint8Array(BLOCK_BYTES);
  block.set(key.length > BLOCK_BYTES ? yield* crypto.digest("SHA-256", key) : key);
  const inner = yield* crypto.digest(
    "SHA-256",
    concat([block.map((byte) => byte ^ 0x36), message]),
  );
  return yield* crypto.digest("SHA-256", concat([block.map((byte) => byte ^ 0x5c), inner]));
});
