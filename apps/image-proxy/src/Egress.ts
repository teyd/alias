/**
 * The image proxy's only way out to the internet (PLAN.md §20.19). It fetches URLs that come from
 * mail, so every request is treated as hostile:
 *
 * - http and https only, on ports the policy allows (production: 80 and 443);
 * - every address the host name resolves to must be public, or nothing is fetched. The check runs
 *   inside the socket's own DNS lookup, so the connection goes to exactly the address that was
 *   checked: a second resolution can't swap in `127.0.0.1` (DNS rebinding). IP literals, which
 *   Node never looks up, are checked before connecting;
 * - redirects are followed by hand, at most three, each hop checked again;
 * - no cookies, no `Referer`, nothing from the reader's request; a fixed `User-Agent`;
 * - at most `maxBytes`, whatever `Content-Length` says, and a deadline for the whole fetch.
 *
 * It uses `node:http` directly (the one module of the app allowed to, see `vite.config.ts`):
 * Effect's HTTP client has no hook into the socket's DNS lookup.
 */
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Which addresses and ports the proxy may connect to. */
export class EgressPolicy extends Context.Service<
  EgressPolicy,
  {
    readonly isAllowedAddress: (address: string) => boolean;
    readonly isAllowedPort: (port: number) => boolean;
  }
>()("@alias/image-proxy/EgressPolicy") {}

/**
 * IANA special-purpose ranges (RFC 6890 and its updates): this network, private, shared
 * (carrier-grade NAT), loopback, link-local (incl. the cloud metadata address 169.254.169.254),
 * protocol assignments, documentation, benchmarking, 6to4 relay, multicast, reserved and
 * broadcast.
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/**
 * IPv6 must be global unicast (2000::/3), which already excludes loopback, unique local
 * (fc00::/7, incl. AWS's fd00:ec2::254), link-local, multicast and IPv4-mapped addresses. Inside
 * 2000::/3: IETF protocol assignments incl. Teredo (2001::/23), documentation (2001:db8::/32,
 * 3fff::/20) and 6to4 (2002::/16), which embeds an IPv4 address.
 */
const GLOBAL_V6: readonly [string, number] = ["2000::", 3];
const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
];

const blockList = (ranges: ReadonlyArray<readonly [string, number]>, family: "ipv4" | "ipv6") => {
  const list = new net.BlockList();
  Arr.map(ranges, ([address, prefix]) => list.addSubnet(address, prefix, family));
  return list;
};

const blockedV4 = blockList(BLOCKED_V4, "ipv4");
const blockedV6 = blockList(BLOCKED_V6, "ipv6");
const globalV6 = blockList([GLOBAL_V6], "ipv6");

/** A public unicast address: anything a mail sender may legitimately host an image on. */
export const isPublicAddress = (address: string): boolean => {
  const family = net.isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
};

/** Production: public addresses on the default http and https ports. */
export const publicInternet = Layer.succeed(EgressPolicy, {
  isAllowedAddress: isPublicAddress,
  isAllowedPort: (port) => port === 80 || port === 443,
});

/** Why a URL wasn't fetched. Names the URL's host at most, never the reader. */
export class EgressRefused extends Schema.TaggedError<EgressRefused>()("EgressRefused", {
  reason: Schema.String,
}) {}

/** The origin didn't deliver an image we may pass on. */
export class UpstreamFailed extends Schema.TaggedError<UpstreamFailed>()("UpstreamFailed", {
  reason: Schema.String,
  /** The origin's status, when it answered. */
  status: Schema.optionalKey(Schema.Number),
}) {}

export interface Fetched {
  readonly contentType: Option.Option<string>;
  readonly body: Uint8Array;
}

export interface Limits {
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly timeout: Duration.Duration;
}

const USER_AGENT = "AliasImageProxy/1.0 (+https://github.com/teyd/alias)";

/** Marks the lookup failure that is our refusal, not a DNS error. */
const BLOCKED = "EALIAS_BLOCKED";

/**
 * The socket's DNS lookup: resolves every address and refuses all of them if any one is not
 * allowed (a host that answers with one public and one private address is not to be trusted).
 */
const guardedLookup =
  (isAllowed: (address: string) => boolean): net.LookupFunction =>
  (hostname, options, callback) =>
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) return callback(error, []);
      const refused =
        !Arr.isArrayNonEmpty(addresses) ||
        !Arr.every(addresses, (found) => isAllowed(found.address));
      if (refused) {
        // The socket only accepts an `Error` here; `requestOnce` turns it into `EgressRefused`.
        // oxlint-disable-next-line effect/avoid-untagged-errors
        const blocked: NodeJS.ErrnoException = new Error(
          `${hostname} resolves to a non-public address`,
        );
        blocked.code = BLOCKED;
        return callback(blocked, []);
      }
      const [first] = addresses;
      return options.all === true
        ? callback(null, addresses)
        : callback(null, first.address, first.family);
    });

type Response =
  | { readonly kind: "redirect"; readonly location: string; readonly status: number }
  | { readonly kind: "image"; readonly fetched: Fetched };

/** One request, no redirects followed. */
const requestOnce = (url: URL, policy: EgressPolicy["Service"], limits: Limits) =>
  Effect.callback<Response, EgressRefused | UpstreamFailed>((resume, signal) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "GET",
      agent: false,
      signal,
      lookup: guardedLookup(policy.isAllowedAddress),
      headers: { "user-agent": USER_AGENT, accept: "image/avif,image/webp,image/*;q=0.8" },
    });
    request.on("error", (error: NodeJS.ErrnoException) =>
      resume(
        error.code === BLOCKED
          ? Effect.fail(new EgressRefused({ reason: error.message }))
          : Effect.fail(new UpstreamFailed({ reason: error.code ?? "connection failed" })),
      ),
    );
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location !== undefined) {
        response.resume();
        return resume(Effect.succeed({ kind: "redirect", location, status }));
      }
      if (status !== 200) {
        response.resume();
        return resume(Effect.fail(new UpstreamFailed({ reason: "unexpected status", status })));
      }
      const declared = Number(response.headers["content-length"] ?? "0");
      if (declared > limits.maxBytes) {
        response.destroy();
        return resume(Effect.fail(new UpstreamFailed({ reason: "too large", status })));
      }
      const chunks: Array<Uint8Array> = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > limits.maxBytes) {
          response.destroy();
          return resume(Effect.fail(new UpstreamFailed({ reason: "too large", status })));
        }
        chunks.push(chunk);
      });
      response.on("error", () =>
        resume(Effect.fail(new UpstreamFailed({ reason: "body interrupted", status }))),
      );
      response.on("end", () =>
        resume(
          Effect.succeed({
            kind: "image",
            fetched: {
              contentType: Option.fromUndefinedOr(response.headers["content-type"]),
              body: new Uint8Array(Buffer.concat(chunks)),
            },
          }),
        ),
      );
    });
    request.end();
  });

/** Checks a URL before connecting: scheme, port, and the host if it's an IP literal. */
const admit = (url: URL, policy: EgressPolicy["Service"]) => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Effect.fail(new EgressRefused({ reason: `scheme ${url.protocol}` }));
  }
  if (url.username !== "" || url.password !== "") {
    return Effect.fail(new EgressRefused({ reason: "credentials in the URL" }));
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!policy.isAllowedPort(port))
    return Effect.fail(new EgressRefused({ reason: `port ${port}` }));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return net.isIP(host) !== 0 && !policy.isAllowedAddress(host)
    ? Effect.fail(new EgressRefused({ reason: `${host} is not a public address` }))
    : Effect.void;
};

const follow = (
  url: URL,
  policy: EgressPolicy["Service"],
  limits: Limits,
  redirects: number,
): Effect.Effect<Fetched, EgressRefused | UpstreamFailed> =>
  Effect.flatMap(admit(url, policy), () =>
    Effect.flatMap(requestOnce(url, policy, limits), (response) => {
      if (response.kind === "image") return Effect.succeed(response.fetched);
      if (redirects >= limits.maxRedirects) {
        return Effect.fail(new EgressRefused({ reason: "too many redirects" }));
      }
      return Option.match(
        Option.liftThrowable((location: string) => new URL(location, url))(response.location),
        {
          onNone: () =>
            Effect.fail(new UpstreamFailed({ reason: "bad redirect", status: response.status })),
          onSome: (next) => follow(next, policy, limits, redirects + 1),
        },
      );
    }),
  );

/** Fetches `url` under the policy, following up to `limits.maxRedirects` redirects. */
export const fetchImage = Effect.fn("Egress.fetchImage")(function* (url: URL, limits: Limits) {
  const policy = yield* EgressPolicy;
  return yield* follow(url, policy, limits, 0).pipe(
    Effect.timeoutOrElse({
      duration: limits.timeout,
      orElse: () => Effect.fail(new UpstreamFailed({ reason: "timed out" })),
    }),
  );
});
