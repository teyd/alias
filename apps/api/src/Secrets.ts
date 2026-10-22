import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { Base64Url, Hex } from "effect/encoding";

/** 256 random bits, base64url: a bearer secret (session cookie, confirmation link). */
export const newToken = (crypto: Crypto.Crypto) =>
  Effect.map(crypto.randomBytes(32), Base64Url.encode);

/**
 * What the table stores instead of a token, so a table dump yields nothing usable. A plain hash is
 * enough because tokens carry 256 random bits.
 */
export const hashToken = (crypto: Crypto.Crypto, token: string) =>
  crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.map(Hex.encode));
