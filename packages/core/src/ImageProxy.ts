import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { concat, constantTimeEqual, utf8 } from "./internal/bytes.ts";
import { hmacSha256 } from "./internal/hmac.ts";
import * as Keyring from "./Keyring.ts";

/**
 * Signed URLs for the image proxy (PLAN.md §20.19). Forwarding rewrites a remote image
 * `https://img.shop.example/hero.jpg` to
 *
 * ```
 * <base>/img/<key version>/<mac>/<base64url(original URL)>
 * ```
 *
 * where `<mac>` is HMAC-SHA-256 over a domain separator and the original URL, truncated to 128
 * bits. The proxy fetches only what verifies, so it is no open relay: a URL has to come out of
 * our own forwarding. URLs don't expire (mail is kept for years); removing a key from the keyring
 * revokes every URL it signed.
 */

/** Where the proxy is served and the keys that sign for it. */
export interface Signer {
  /** The proxy's origin, `https://img.alias.example` (no trailing slash). */
  readonly base: string;
  readonly keys: Keyring.Keyring;
}

const PREFIX = "/img/";
const MAC_BYTES = 16;
const DOMAIN_SEPARATOR = utf8("alias/image-proxy/v1\u0000");

class InvalidProxyUrl extends Schema.TaggedError<InvalidProxyUrl>()("InvalidProxyUrl", {
  reason: Schema.Literals(["malformed", "unknown-key", "bad-signature"]),
}) {}

const mac = (key: Keyring.Key, url: string) =>
  hmacSha256(Redacted.value(key.secret), concat([DOMAIN_SEPARATOR, utf8(url)])).pipe(
    Effect.map((digest) => digest.subarray(0, MAC_BYTES)),
  );

/** The proxy URL for `url` (an absolute http(s) URL, as `URL.href` writes it). */
export const sign = Effect.fn("ImageProxy.sign")(function* (signer: Signer, url: string) {
  const key = signer.keys.current;
  const signature = Base64Url.encode(yield* mac(key, url));
  return `${signer.base}${PREFIX}${key.version}/${signature}/${Base64Url.encode(utf8(url))}`;
});

/** Already a URL of this proxy: forwarding a forwarded copy leaves it alone. */
export const isProxied = (signer: Signer, url: string) => url.startsWith(`${signer.base}${PREFIX}`);

const PATH = /^\/img\/(\d{1,3})\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]+)$/;

/**
 * The original URL a proxy path (`/img/…`, without the origin) was signed for. Checks the MAC in
 * constant time, with the current or a retired key.
 */
export const verify = Effect.fn("ImageProxy.verify")(function* (
  keys: Keyring.Keyring,
  path: string,
) {
  const match = PATH.exec(path);
  const signature = Option.flatMap(Option.fromNullOr(match), (found) =>
    Result.getSuccess(Base64Url.decode(found[2] ?? "")),
  );
  const payload = Option.flatMap(Option.fromNullOr(match), (found) =>
    Result.getSuccess(Base64Url.decode(found[3] ?? "")),
  );
  if (match === null || Option.isNone(signature) || Option.isNone(payload)) {
    return yield* new InvalidProxyUrl({ reason: "malformed" });
  }
  const key = Keyring.find(keys, Number(match[1]));
  if (Option.isNone(key)) return yield* new InvalidProxyUrl({ reason: "unknown-key" });
  const url = new TextDecoder().decode(payload.value);
  const expected = yield* mac(key.value, url);
  if (!constantTimeEqual(expected, signature.value)) {
    return yield* new InvalidProxyUrl({ reason: "bad-signature" });
  }
  // Signed URLs are absolute http(s) URLs; anything else was never signed by `sign`.
  const parsed = Option.filter(
    Option.liftThrowable((href: string) => new URL(href))(url),
    (found) => Arr.contains(["http:", "https:"], found.protocol),
  );
  if (Option.isNone(parsed)) return yield* new InvalidProxyUrl({ reason: "malformed" });
  return parsed.value;
});
