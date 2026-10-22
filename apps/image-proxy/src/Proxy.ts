import { FunctionUrl } from "@alias/aws";
import { ImageProxy, type Keyring } from "@alias/core";
import { ProxyRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Egress from "./Egress.ts";

/**
 * The image proxy (PLAN.md §20.19, §20.29): `GET /img/<key version>/<tag>/<owner>/<mac>/<base64url
 * URL>` answers with the image at the URL forwarding signed, within the fetch budgets of the
 * alias owner and the origin host. Nothing about the reader's request travels on, and nothing
 * about the origin's response comes back but the image bytes.
 */

/** The keys that verify proxy URLs; the inbound Lambda signs with the same ones. */
export class ProxyKeys extends Context.Service<ProxyKeys, Keyring.Keyring>()(
  "@alias/image-proxy/ProxyKeys",
) {}

/**
 * How many origin fetches (CloudFront's cache misses) the proxy makes, so that one user, or a
 * URL shared around, can't take the few reserved slots from everyone (PLAN.md §20.29).
 */
export class Budgets extends Context.Service<
  Budgets,
  {
    /** Per alias owner and UTC minute: a newsletter opened is a few dozen. */
    readonly perOwnerPerMinute: number;
    /** Per origin host and UTC minute, for all owners together. */
    readonly perHostPerMinute: number;
    /** How long an origin that couldn't be reached is left alone. */
    readonly downFor: Duration.Duration;
  }
>()("@alias/image-proxy/Budgets") {}

export const defaultBudgets = Layer.succeed(Budgets, {
  perOwnerPerMinute: 60,
  perHostPerMinute: 300,
  downFor: Duration.minutes(1),
});

/**
 * Function URL responses are capped at 6 MB, base64 included (4 MiB of image become 5.6 MB), and
 * mail images are far smaller: newsletter heroes run to a few hundred KB.
 */
export const limits: Egress.Limits = {
  maxBytes: 4 * 1024 * 1024,
  maxRedirects: 3,
  // A mail image host that takes longer than this to connect or start answering holds one of
  // the few reserved slots for nothing (PLAN.md §20.29).
  idleTimeout: Duration.seconds(2),
  timeout: Duration.seconds(5),
};

/** Image formats every mail client shows, recognised by their first bytes (never SVG: scripts). */
const FORMATS: ReadonlyArray<{
  readonly type: string;
  readonly matches: (bytes: Uint8Array) => boolean;
}> = [
  {
    type: "image/png",
    matches: (b) =>
      Arr.every([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], (x, i) => b[i] === x),
  },
  { type: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/gif", matches: (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a" },
  { type: "image/webp", matches: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  {
    type: "image/avif",
    matches: (b) => ascii(b, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(b, 8, 12)),
  },
  { type: "image/bmp", matches: (b) => ascii(b, 0, 2) === "BM" },
  {
    type: "image/x-icon",
    matches: (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
  },
];

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** The image's type from its bytes, whatever the origin claimed. */
const sniff = (bytes: Uint8Array): Option.Option<string> =>
  Option.map(
    Arr.findFirst(FORMATS, (format) => format.matches(bytes)),
    (format) => format.type,
  );

/**
 * Sent with every answer. The body is only ever an image we recognised, and nothing may run or
 * be sniffed as anything else if someone opens a proxy URL directly.
 */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "cross-origin",
};

/**
 * CloudFront caches what the Lambda allows: images for a day, so a newsletter opened again or by
 * many recipients costs one fetch; failures briefly, so a dead origin isn't asked again and
 * again; bad signatures for a day, since they never turn good.
 */
const answer = (
  status: number,
  maxAge: Duration.Duration,
  image: Option.Option<{ readonly body: Uint8Array; readonly type: string }> = Option.none(),
) =>
  new Response(
    Option.match(image, { onNone: () => null, onSome: ({ body }) => Uint8Array.from(body) }),
    {
      status,
      headers: [
        ...R.toEntries(SECURITY_HEADERS),
        ["cache-control", `public, max-age=${Math.ceil(Duration.toSeconds(maxAge))}`],
        ...Option.toArray(
          Option.map(image, ({ type }): [string, string] => ["content-type", type]),
        ),
      ],
    },
  );

/** Not now: try again after `wait` (at least a second), which is also how long it may be cached. */
const later = (status: 429 | 502 | 503, wait: Duration.Duration) => {
  const seconds = Math.max(1, Math.ceil(Duration.toSeconds(wait)));
  const response = answer(status, Duration.seconds(seconds));
  response.headers.set("retry-after", String(seconds));
  return response;
};

const DAY = Duration.days(1);

/** Until the current UTC minute ends, when the budgets start again. */
const untilNextMinute = (now: DateTime.Utc) =>
  DateTime.distance(
    now,
    DateTime.addDuration(DateTime.startOf(now, "minute"), Duration.minutes(1)),
  );

/**
 * Whether the origin may be asked now: not while it is down, and only within the owner's and the
 * host's budget (in that order, so a down host costs nothing). None means fetch it.
 */
const admit = Effect.fn("Proxy.admit")(function* (target: ImageProxy.Verified) {
  const budgets = yield* Budgets;
  const repo = yield* ProxyRepo.ProxyRepo;
  const now = yield* DateTime.now;
  const down = yield* repo.downUntil(target.url.origin, now);
  if (Option.isSome(down)) {
    yield* Effect.logInfo("image proxy origin down");
    return Option.some(later(502, DateTime.distance(now, down.value)));
  }
  if (!(yield* repo.reserveOwner(target.userId, now, budgets.perOwnerPerMinute))) {
    yield* Effect.logInfo("image proxy owner budget used up");
    return Option.some(later(429, untilNextMinute(now)));
  }
  if (!(yield* repo.reserveHost(target.url.hostname, now, budgets.perHostPerMinute))) {
    yield* Effect.logInfo("image proxy host budget used up");
    return Option.some(later(429, untilNextMinute(now)));
  }
  return Option.none<Response>();
});

/** Leaves an origin that couldn't be reached alone for `Budgets.downFor`. */
const markDown = Effect.fn("Proxy.markDown")(function* (origin: string) {
  const { downFor } = yield* Budgets;
  const until = DateTime.addDuration(yield* DateTime.now, downFor);
  yield* (yield* ProxyRepo.ProxyRepo).markDown(origin, until);
});

/** Serves one request. */
const respond = Effect.fn("Proxy.respond")(function* (request: Request) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return answer(405, Duration.zero);
  }
  const keys = yield* ProxyKeys;
  const path = new URL(request.url).pathname;
  const target = yield* ImageProxy.verify(keys, path).pipe(Effect.option);
  if (Option.isNone(target)) return answer(403, DAY);
  const refused = yield* admit(target.value);
  if (Option.isSome(refused)) return refused.value;
  return yield* Egress.fetchImage(target.value.url, limits).pipe(
    Effect.map((fetched) =>
      Option.match(sniff(fetched.body), {
        onNone: () => answer(415, Duration.hours(1)),
        onSome: (type) =>
          answer(
            200,
            DAY,
            Option.some({
              body: request.method === "HEAD" ? new Uint8Array() : fetched.body,
              type,
            }),
          ),
      }),
    ),
    Effect.catchTags({
      // A host we refuse stays refused.
      EgressRefused: (error) =>
        Effect.as(Effect.logInfo("image proxy refused", error.reason), answer(403, DAY)),
      UpstreamFailed: (error) =>
        Effect.logInfo("image proxy upstream failed", error.reason).pipe(
          Effect.andThen(
            error.unreachable === undefined ? Effect.void : markDown(error.unreachable),
          ),
          Effect.as(answer(502, Duration.minutes(5))),
        ),
    }),
  );
});

/** The Lambda's work, on a function URL event parsed with `FunctionUrl.decode`. */
export const handle = Effect.fn("Proxy.handle")(function* (event: FunctionUrl.FunctionUrlEvent) {
  const response = yield* respond(yield* FunctionUrl.toRequest(event)).pipe(
    // Without the table no budget can be checked: refuse (briefly) rather than fetch unmetered.
    Effect.catchTag("DatabaseError", (error) =>
      Effect.as(
        Effect.logWarning("image proxy budgets unavailable", error.operation),
        later(503, Duration.seconds(5)),
      ),
    ),
  );
  return yield* FunctionUrl.fromResponse(response);
});
