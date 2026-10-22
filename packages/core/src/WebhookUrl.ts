import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { MAPPED_V4, ipv4, ipv6, within } from "./internal/ip.ts";

/**
 * Where webhooks may be sent. A user-chosen URL is a server-side request forgery risk: a Lambda
 * outside a VPC can still reach its own runtime API on 127.0.0.1, and anything on a private or
 * link-local address the network routes. So a webhook URL must be `https:`, carry no
 * credentials, name a dotted public host and, if it names an IP literal, a public one. Names are
 * checked again after DNS resolution, at connect time (`@alias/webhooks` Egress), because a
 * name can point anywhere and change between checks.
 *
 * `isLoopbackAllowed` (tests and `pnpm dev` only, never production) additionally admits
 * `http:` and `https:` to `localhost` and loopback literals, so a receiver on port 0 works.
 */

export type Refusal =
  | "invalid-url"
  | "not-https"
  | "has-credentials"
  | "not-public-host"
  | "too-long";

export interface Options {
  readonly isLoopbackAllowed: boolean;
}

const MAX_LENGTH = 2_048;

/** IANA special-purpose IPv4 blocks that aren't globally reachable, plus multicast and reserved. */
const NON_PUBLIC_V4: ReadonlyArray<readonly [ReadonlyArray<number>, number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

/** IPv6 blocks that aren't globally reachable, or tunnel to addresses we can't see. */
const NON_PUBLIC_V6: ReadonlyArray<readonly [ReadonlyArray<number>, number]> = [
  [[], 96], // ::/96: unspecified, loopback, deprecated IPv4-compatible
  [[0x01, 0x00], 64], // 100::/64 discard
  [[0x20, 0x01, 0x00, 0x00], 23], // 2001::/23 IETF protocols (Teredo, ORCHID, …)
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x20, 0x02], 16], // 6to4
  [[0x3f, 0xff, 0x00], 20], // 3fff::/20 documentation (RFC 9637)
  [[0x5f, 0x00], 16], // 5f00::/16 SRv6 SIDs (RFC 9602)
  [[0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48], // local-use NAT64
  [[0xfc], 7], // unique local
  [[0xfe, 0x80], 10], // link-local
  [[0xfe, 0xc0], 10], // site-local (deprecated)
  [[0xff], 8], // multicast
];

const NAT64 = [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];

const isPublicV4 = (bytes: ReadonlyArray<number>) =>
  !Arr.some(NON_PUBLIC_V4, ([prefix, bits]) => within(bytes, prefix, bits));

const isPublicV6 = (bytes: ReadonlyArray<number>): boolean => {
  // IPv4-mapped and well-known NAT64 addresses reach the IPv4 address in their last 4 bytes.
  if (within(bytes, MAPPED_V4, 96) || within(bytes, NAT64, 96)) {
    return isPublicV4(bytes.slice(12));
  }
  return !Arr.some(NON_PUBLIC_V6, ([prefix, bits]) => within(bytes, prefix, bits));
};

const isLoopbackV4 = (bytes: ReadonlyArray<number>) => bytes[0] === 127;
const isLoopbackV6 = (bytes: ReadonlyArray<number>) => within(bytes, [], 120) && bytes[15] === 1;

/**
 * Whether connecting to `address` (an IP as DNS returns it, IPv6 without brackets) is allowed:
 * a globally reachable address, or loopback when `isLoopbackAllowed`. Anything unparsable is not.
 */
export const isAllowedAddress = (address: string, options: Options): boolean =>
  Option.match(ipv4(address), {
    onSome: (bytes) => isPublicV4(bytes) || (options.isLoopbackAllowed && isLoopbackV4(bytes)),
    onNone: () =>
      Option.match(ipv6(address.replace(/%.*$/, "")), {
        onSome: (bytes) => isPublicV6(bytes) || (options.isLoopbackAllowed && isLoopbackV6(bytes)),
        onNone: () => false,
      }),
  });

/** `localhost`, its subdomains, and either with the root's trailing dot (`localhost.`). */
const isLocalName = (host: string) => {
  const name = Str.endsWith(".")(host) ? host.slice(0, -1) : host;
  return name === "localhost" || Str.endsWith(".localhost")(name);
};

/** The URL to post to, or why it may not be one. */
export const check = (input: string, options: Options): Result.Result<URL, Refusal> => {
  if (input.length > MAX_LENGTH) return Result.fail("too-long");
  const parsed = URL.canParse(input) ? Option.some(new URL(input)) : Option.none<URL>();
  if (Option.isNone(parsed)) return Result.fail("invalid-url");
  const url = parsed.value;
  if (url.protocol !== "https:" && url.protocol !== "http:") return Result.fail("invalid-url");
  if (!Str.isEmpty(url.username) || !Str.isEmpty(url.password)) {
    return Result.fail("has-credentials");
  }
  // The URL parser has already normalised IPv4 forms like `0x7f.1` to dotted decimal.
  const host = url.hostname.toLowerCase();
  const literal = Str.startsWith("[")(host) ? host.slice(1, -1) : host;
  const isLiteral = Option.isSome(ipv4(literal)) || Option.isSome(ipv6(literal));
  const isLoopback =
    isLocalName(host) ||
    Option.exists(ipv4(literal), isLoopbackV4) ||
    Option.exists(ipv6(literal), isLoopbackV6);
  if (options.isLoopbackAllowed && isLoopback) return Result.succeed(url);
  if (url.protocol !== "https:") return Result.fail("not-https");
  if (isLiteral) {
    return isAllowedAddress(literal, { isLoopbackAllowed: false })
      ? Result.succeed(url)
      : Result.fail("not-public-host");
  }
  // A single label (`intranet`, `intranet.`) resolves through search domains or names a TLD;
  // `localhost` never leaves.
  if (!Str.includes(".")(host.replace(/\.$/, "")) || isLocalName(host)) {
    return Result.fail("not-public-host");
  }
  return Result.succeed(url);
};
