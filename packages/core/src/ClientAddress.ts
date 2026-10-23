import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { MAPPED_V4, ipv4, ipv6, within } from "./internal/ip.ts";

/**
 * A client's IP address, parsed, for the per-client rate limits (token failures, device
 * requests, OAuth registration, MCP). An IPv4 address that arrives in IPv6 form
 * (`::ffff:192.0.2.1`, as dual-stack sockets report it) is the IPv4 address.
 */
export type ClientAddress =
  | { readonly family: 4; readonly bytes: ReadonlyArray<number> }
  | { readonly family: 6; readonly bytes: ReadonlyArray<number> };

/** An IP literal as AWS and sockets write it: dotted IPv4, or IPv6 without brackets or zone. */
export const parse = (text: string): Option.Option<ClientAddress> =>
  Option.match(ipv4(text), {
    onSome: (bytes): Option.Option<ClientAddress> => Option.some({ family: 4, bytes }),
    onNone: () =>
      Option.map(ipv6(text), (bytes): ClientAddress =>
        within(bytes, MAPPED_V4, 96) ? { family: 4, bytes: bytes.slice(12) } : { family: 6, bytes },
      ),
  });

const groupsOf = (bytes: ReadonlyArray<number>) =>
  Arr.map(Arr.chunksOf(bytes, 2), ([high, low]) => high * 256 + (low ?? 0));

/** The longest run of at least two zero groups (the first of equal ones), as RFC 5952 picks it. */
const longestZeroRun = (groups: ReadonlyArray<number>) =>
  Arr.reduce(
    groups,
    { best: { start: -1, size: 0 }, run: { start: -1, size: 0 } },
    ({ best, run }, group, index) => {
      const next =
        group === 0
          ? { start: run.size < 1 ? index : run.start, size: run.size + 1 }
          : { start: -1, size: 0 };
      return { best: next.size > best.size ? next : best, run: next };
    },
  ).best;

/** The canonical text form: dotted IPv4, or RFC 5952 IPv6 (lowercase, shortest, `::` once). */
export const format = (address: ClientAddress): string => {
  if (address.family === 4) return Arr.join(Arr.map(address.bytes, String), ".");
  const groups = groupsOf(address.bytes);
  const hex = (part: ReadonlyArray<number>) =>
    Arr.join(
      Arr.map(part, (g) => g.toString(16)),
      ":",
    );
  const zeros = longestZeroRun(groups);
  return zeros.size < 2
    ? hex(groups)
    : `${hex(groups.slice(0, zeros.start))}::${hex(groups.slice(zeros.start + zeros.size))}`;
};

/**
 * What a per-address rate limit counts a client address as (PLAN.md §20.26, §20.30): an IPv4
 * address whole, an IPv6 address by its /64. A /64 is the smallest block one subscriber gets
 * (RFC 6177), so counting single IPv6 addresses would let one connection rotate through 2^64 of
 * them and multiply every allowance. An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is its IPv4
 * address, a zone (`%eth0`) is ignored, and anything that isn't an address is kept as given.
 */
export const rateLimitKey = (address: string): string =>
  Option.match(parse(address.replace(/%.*$/, "")), {
    onNone: () => address,
    onSome: (parsed) =>
      parsed.family === 4
        ? format(parsed)
        : `${format({ family: 6, bytes: [...parsed.bytes.slice(0, 8), ...Arr.replicate(0, 8)] })}/64`,
  });
