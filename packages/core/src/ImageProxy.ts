import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { concat, constantTimeEqual, isEmptyBytes, utf8 } from "./internal/bytes.ts";
import { hmacSha256 } from "./internal/hmac.ts";
import * as Keyring from "./Keyring.ts";

/**
 * Signed URLs for the image proxy (PLAN.md §20.19, §20.29). Forwarding rewrites a remote image
 * `https://img.shop.example/hero.jpg` in mail to one alias to
 *
 * ```
 * <base>/img/<key version>/<tag>/<owner>/<mac>/<base64url(original URL)>
 * ```
 *
 * - `<tag>` (12 characters) names the alias without revealing it: 72 bits of HMAC over its id.
 * - `<owner>` is the alias owner's user id, XORed with an HMAC-derived pad for that tag. The proxy
 *   recovers it and charges the owner's fetch budget, so whoever holds a proxy URL can only spend
 *   the budget of the user whose mail it came from. The pad differs per alias, so URLs from two
 *   aliases of one owner (quoted in replies, say) don't show that they belong together; within an
 *   alias the same image gets the same URL, which CloudFront caches once.
 * - `<mac>` is HMAC-SHA-256 over a domain separator, tag, owner and URL, truncated to 128 bits.
 *
 * The proxy fetches only what verifies, so it is no open relay: a URL has to come out of our own
 * forwarding, and its owner can't be swapped. URLs don't expire (mail is kept for years); removing
 * a key from the keyring revokes every URL it signed.
 */

/** Where the proxy is served and the keys that sign for it. */
export interface Signer {
  /** The proxy's origin, `https://img.alias.example` (no trailing slash). */
  readonly base: string;
  readonly keys: Keyring.Keyring;
}

/** Whose mail an image came in: the alias, and the user whose budget its fetches spend. */
export interface Owner {
  readonly aliasId: string;
  readonly userId: string;
}

/** Signs for the mail of one alias. */
export interface AliasSigner extends Signer {
  readonly owner: Owner;
}

/** A proxy path that verified: the URL to fetch and whose budget fetching it spends. */
export interface Verified {
  readonly url: URL;
  readonly userId: string;
}

const PREFIX = "/img/";
const MAC_BYTES = 16;
const TAG_BYTES = 9;
/** Longer user ids are refused; ours are 30 bytes (`usr_<ULID>`). */
const MAX_OWNER_BYTES = 64;
const HMAC_BYTES = 32;
const MAC_SEPARATOR = utf8("alias/image-proxy/v2/mac\u0000");
const TAG_SEPARATOR = utf8("alias/image-proxy/v2/tag\u0000");
const PAD_SEPARATOR = utf8("alias/image-proxy/v2/pad\u0000");

class InvalidProxyUrl extends Schema.TaggedError<InvalidProxyUrl>()("InvalidProxyUrl", {
  reason: Schema.Literals(["malformed", "unknown-key", "bad-signature"]),
}) {}

const hmac = (key: Keyring.Key, separator: Uint8Array, message: Uint8Array) =>
  hmacSha256(Redacted.value(key.secret), concat([separator, message]));

const mac = (key: Keyring.Key, tag: string, owner: string, url: string) =>
  hmac(key, MAC_SEPARATOR, utf8(`${tag}/${owner}/${url}`)).pipe(
    Effect.map((digest) => digest.subarray(0, MAC_BYTES)),
  );

/** `length` bytes of pad for `tag`: HMAC blocks over the tag and a block counter. */
const pad = (key: Keyring.Key, tag: string, length: number) =>
  Effect.map(
    Effect.forEach(
      Arr.range(0, Math.ceil(length / HMAC_BYTES) - 1),
      (block) => hmac(key, PAD_SEPARATOR, concat([utf8(tag), Uint8Array.of(block)])),
      { concurrency: 1 },
    ),
    (blocks) => concat(blocks).subarray(0, length),
  );

const xor = (bytes: Uint8Array, mask: Uint8Array) => bytes.map((byte, i) => byte ^ (mask[i] ?? 0));

/**
 * The proxy URL for `url` (an absolute http(s) URL, as `URL.href` writes it) in mail to the
 * signer's alias.
 */
export const sign = Effect.fn("ImageProxy.sign")(function* (signer: AliasSigner, url: string) {
  const key = signer.keys.current;
  const userId = utf8(signer.owner.userId);
  if (isEmptyBytes(userId) || userId.length > MAX_OWNER_BYTES) {
    return yield* Effect.die(`a user id of ${userId.length} bytes can't be signed`);
  }
  const tag = Base64Url.encode(
    (yield* hmac(key, TAG_SEPARATOR, utf8(signer.owner.aliasId))).subarray(0, TAG_BYTES),
  );
  const owner = Base64Url.encode(xor(userId, yield* pad(key, tag, userId.length)));
  const signature = Base64Url.encode(yield* mac(key, tag, owner, url));
  return `${signer.base}${PREFIX}${key.version}/${tag}/${owner}/${signature}/${Base64Url.encode(utf8(url))}`;
});

/** Already a URL of this proxy: forwarding a forwarded copy leaves it alone. */
export const isProxied = (signer: Signer, url: string) => url.startsWith(`${signer.base}${PREFIX}`);

const PATH =
  /^\/img\/(\d{1,3})\/([A-Za-z0-9_-]{12})\/([A-Za-z0-9_-]{2,86})\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]+)$/;

const decoded = (text: string) =>
  Result.getSuccess(Base64Url.decode(text)).pipe(Option.filter((bytes) => !isEmptyBytes(bytes)));

/**
 * The original URL a proxy path (`/img/…`, without the origin) was signed for, and the owner
 * whose budget it spends. Checks the MAC in constant time, with the current or a retired key.
 */
export const verify = Effect.fn("ImageProxy.verify")(function* (
  keys: Keyring.Keyring,
  path: string,
) {
  const match = PATH.exec(path);
  if (match === null) return yield* new InvalidProxyUrl({ reason: "malformed" });
  const [, version, tag = "", owner = "", signature = "", payload = ""] = match;
  const parts = Option.all([decoded(owner), decoded(signature), decoded(payload)]);
  if (Option.isNone(parts)) return yield* new InvalidProxyUrl({ reason: "malformed" });
  const [sealed, given, target] = parts.value;
  const key = Keyring.find(keys, Number(version));
  if (Option.isNone(key)) return yield* new InvalidProxyUrl({ reason: "unknown-key" });
  const url = new TextDecoder().decode(target);
  const expected = yield* mac(key.value, tag, owner, url);
  if (!constantTimeEqual(expected, given)) {
    return yield* new InvalidProxyUrl({ reason: "bad-signature" });
  }
  // Signed URLs are absolute http(s) URLs; anything else was never signed by `sign`.
  const parsed = Option.filter(
    Option.liftThrowable((href: string) => new URL(href))(url),
    (found) => Arr.contains(["http:", "https:"], found.protocol),
  );
  if (Option.isNone(parsed)) return yield* new InvalidProxyUrl({ reason: "malformed" });
  const userId = new TextDecoder().decode(xor(sealed, yield* pad(key.value, tag, sealed.length)));
  return { url: parsed.value, userId } satisfies Verified;
});
