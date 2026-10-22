import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { ipv4, ipv6 } from "./internal/ip.ts";

const isMappedV4 = (bytes: ReadonlyArray<number>) =>
  Arr.every(Arr.take(bytes, 10), (byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;

const hex = (high: number, low: number) => ((high << 8) | low).toString(16);

const dotted = (bytes: ReadonlyArray<number>) => Arr.join(Arr.map(bytes, String), ".");

/**
 * What a per-address rate limit counts a client address as (PLAN.md §20.30): an IPv4 address
 * whole, an IPv6 address by its /64. A /64 is the smallest block one subscriber gets (RFC 6177),
 * so counting single IPv6 addresses would let one connection rotate through 2^64 of them and
 * multiply every allowance. An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is its IPv4 address.
 * Anything that isn't an address is kept as given.
 */
export const rateLimitKey = (address: string): string =>
  Option.match(ipv4(address), {
    onSome: dotted,
    onNone: () =>
      Option.match(ipv6(address.replace(/%.*$/, "")), {
        onNone: () => address,
        onSome: (bytes) =>
          isMappedV4(bytes)
            ? dotted(Arr.drop(bytes, 12))
            : `${Arr.join(
                Arr.map(Arr.chunksOf(Arr.take(bytes, 8), 2), ([high, low]) => hex(high, low ?? 0)),
                ":",
              )}::/64`,
      }),
  });
