import { CloudFront, FunctionUrl } from "@alias/aws";
import { Keyring } from "@alias/core";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MAX_FAILURES_PER_HOUR } from "../src/Authentication.ts";
import * as Browser from "./support/Browser.ts";
import * as TestApi from "./support/TestApi.ts";

/**
 * Whom the per-client limits count (PLAN.md §20.26), shown with the token-failure limit: 20 bad
 * tokens from one client lock that client out for an hour. Every client here sends a bad token.
 */

const BAD_TOKEN = { authorization: `Bearer alias_pat_${"B".repeat(43)}` };
const secret = Buffer.alloc(32, 7).toString("base64url");
const originSecrets = Keyring.parse(Redacted.make(`1:${secret}`));
/** What CloudFront's origin custom header carries. */
const proof = { [CloudFront.ORIGIN_SECRET_HEADER]: `1:${secret}` };
/** Where CloudFront's edge connects from: the function URL's `sourceIp` behind it. */
const EDGE = "130.176.0.1";

type Api = Effect.Success<typeof TestApi.make>;

const status = (api: Api, sourceIp: string, headers: Record<string, string>) =>
  Effect.map(
    Browser.make(api.handle, { sourceIp, headers: { ...BAD_TOKEN, ...headers } }).get(
      "/v1/aliases",
    ),
    (response) => response.status,
  );

/** Fails `MAX_FAILURES_PER_HOUR` times, each attempt from `attempt(i)`. */
const exhaust = (api: Api, attempt: (i: number) => readonly [string, Record<string, string>]) =>
  Effect.forEach(Arr.range(1, MAX_FAILURES_PER_HOUR), (i) => status(api, ...attempt(i)), {
    concurrency: 1,
  });

describe("client address for rate limits, called directly (API handler on fakecloud)", () => {
  it.effect("is the function URL's sourceIp, whatever address headers the client sends", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      yield* exhaust(api, (i) => [
        "203.0.113.9",
        {
          [CloudFront.VIEWER_ADDRESS_HEADER]: `192.0.2.${i}:443`,
          [FunctionUrl.SOURCE_IP_HEADER]: `198.51.100.${i}`,
          "x-forwarded-for": `192.0.2.${i}`,
          ...proof,
        },
      ]);
      expect(
        yield* status(api, "203.0.113.9", { [FunctionUrl.SOURCE_IP_HEADER]: "192.0.2.77" }),
      ).toBe(429);
      expect(yield* status(api, "203.0.113.10", {})).toBe(401);
    }),
  );

  it.effect("counts an IPv6 client per /64, so picking new addresses doesn't help", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      yield* exhaust(api, (i) => [`2001:db8:1:2::${i.toString(16)}`, {}]);
      expect(yield* status(api, "2001:db8:1:2:ffff:ffff:ffff:ffff", {})).toBe(429);
      expect(yield* status(api, "2001:db8:1:3::1", {})).toBe(401);
    }),
  );
});

describe("client address for rate limits, behind CloudFront (API handler on fakecloud)", () => {
  it.effect("is CloudFront-Viewer-Address, so viewers on one edge don't share a limit", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({ front: FunctionUrl.cloudFront(yield* originSecrets) });
      const viewer = (address: string) => ({
        ...proof,
        [CloudFront.VIEWER_ADDRESS_HEADER]: address,
        // CloudFront overwrites the viewer's copy of its own headers; ours is replaced too.
        [FunctionUrl.SOURCE_IP_HEADER]: "192.0.2.1",
      });
      const statuses = yield* exhaust(api, (i) => [EDGE, viewer(`198.51.100.7:${40_000 + i}`)]);
      expect(statuses).toEqual(Arr.replicate(401, MAX_FAILURES_PER_HOUR));
      expect(yield* status(api, EDGE, viewer("198.51.100.7:50000"))).toBe(429);
      expect(yield* status(api, EDGE, viewer("198.51.100.8:50000"))).toBe(401);
      expect(yield* status(api, EDGE, viewer("2001:db8:85a3::8a2e:370:7334:50000"))).toBe(401);
    }),
  );

  it.effect("refuses requests that come around CloudFront, whatever they claim", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({ front: FunctionUrl.cloudFront(yield* originSecrets) });
      const claims = [
        {},
        { [CloudFront.VIEWER_ADDRESS_HEADER]: "198.51.100.7:1" },
        { [FunctionUrl.SOURCE_IP_HEADER]: "198.51.100.7" },
        { [CloudFront.ORIGIN_SECRET_HEADER]: `1:${Buffer.alloc(32, 8).toString("base64url")}` },
      ];
      const statuses = yield* Effect.forEach(claims, (headers) => status(api, EDGE, headers), {
        concurrency: 1,
      });
      expect(statuses).toEqual([403, 403, 403, 403]);
      // Even the health check: nothing but CloudFront reaches the API.
      expect((yield* Browser.make(api.handle).get("/v1/health")).status).toBe(403);
    }),
  );
});
