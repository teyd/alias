import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import * as Option from "effect/Option";
import * as Str from "effect/String";

/**
 * Rules of the OAuth 2.1 authorization server (PLAN.md §20.24) that need no I/O: which redirect
 * URIs a client may use and how they match, PKCE, and the `scope` parameter.
 */

const parse = (uri: string): Option.Option<URL> =>
  URL.canParse(uri) ? Option.some(new URL(uri)) : Option.none();

/** The loopback names RFC 8252 §7.3 means, as the URL parser writes them. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const isLoopback = (url: URL) =>
  url.protocol === "http:" && Arr.contains(LOOPBACK_HOSTS, url.hostname);

/**
 * A redirect URI a client may register: absolute, without a fragment (RFC 6749 §3.1.2) or
 * credentials, and `https:` or `http:` on a loopback host (MCP authorization spec, "Communication
 * Security"). Custom schemes are refused: MCP allows only those two.
 */
export const isAllowedRedirectUri = (uri: string): boolean =>
  Option.exists(
    parse(uri),
    (url) =>
      !Str.includes("#")(uri) &&
      Str.isEmpty(url.username) &&
      Str.isEmpty(url.password) &&
      (url.protocol === "https:" || isLoopback(url)),
  );

/** True when the client can only be reached on the user's own machine. */
export const isLocalRedirectUri = (uri: string): boolean => Option.exists(parse(uri), isLoopback);

/**
 * Whether `presented` (from an authorization request) is the `registered` redirect URI. Exact
 * string comparison (OAuth 2.1 §4.1.1), except that a loopback redirect may name any port, since a
 * native app gets one from the OS when it starts listening (RFC 8252 §7.3).
 */
export const redirectMatches = (registered: string, presented: string): boolean => {
  if (registered === presented) return true;
  return Option.match(Option.all([parse(registered), parse(presented)]), {
    onNone: () => false,
    onSome: ([expected, actual]) =>
      isLoopback(expected) &&
      isLoopback(actual) &&
      !Str.includes("#")(presented) &&
      expected.hostname === actual.hostname &&
      expected.pathname === actual.pathname &&
      expected.search === actual.search,
  });
};

/** RFC 7636 §4.2: the base64url SHA-256 of a verifier is always 43 characters. */
export const isS256Challenge = (challenge: string): boolean =>
  /^[A-Za-z0-9_-]{43}$/.test(challenge);

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const isVerifier = (verifier: string): boolean => /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);

/** RFC 7636 §4.6: `BASE64URL(SHA256(verifier)) == challenge`. */
export const verifyS256 = Effect.fn("OAuth.verifyS256")(function* (
  verifier: string,
  challenge: string,
) {
  if (!isVerifier(verifier)) return false;
  const crypto = yield* Crypto.Crypto;
  const digest = yield* Effect.orDie(crypto.digest("SHA-256", new TextEncoder().encode(verifier)));
  return Base64Url.encode(digest) === challenge;
});

/** The `scope` parameter's space-separated tokens (RFC 6749 §3.3), without duplicates. */
export const scopeTokens = (scope: string): ReadonlyArray<string> =>
  Arr.dedupe(Arr.filter(scope.split(" "), Str.isNonEmpty));
