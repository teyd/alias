import { CloudFront, FunctionUrl } from "@alias/aws";
import { ClientAddress, Keyring, OriginSecret } from "@alias/core";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { CloudFrontServer, FunctionUrlServer } from "../src/index.ts";

const secret = Buffer.alloc(32, 5).toString("base64url");
const keys = Keyring.parse(Redacted.make(`1:${secret}`));

const Echo = Schema.Struct({
  caller: Schema.String,
  host: Schema.String,
  forwardedFor: Schema.String,
  hasCfId: Schema.Boolean,
  leaked: Schema.Array(Schema.String),
});

/**
 * The emulated distribution in front of the function URL emulator, which runs the production
 * adapter behind CloudFront: every event it builds must pass `FunctionUrl.handle`'s origin check.
 */
const stack = (viewerHost: string) =>
  Effect.gen(function* () {
    const keyring = yield* keys;
    const events: Array<FunctionUrl.FunctionUrlEvent> = [];
    const serve = FunctionUrl.handle(
      async (request) =>
        Response.json({
          caller: request.headers.get(FunctionUrl.SOURCE_IP_HEADER),
          host: new URL(request.url).host,
          forwardedFor: request.headers.get("x-forwarded-for"),
          hasCfId: request.headers.has("x-amz-cf-id"),
          leaked: [CloudFront.ORIGIN_SECRET_HEADER, CloudFront.VIEWER_ADDRESS_HEADER].filter(
            (name) => request.headers.has(name),
          ),
        }),
      FunctionUrl.cloudFront(keyring),
    );
    const origin = yield* FunctionUrlServer.make({
      handler: (event) => {
        events.push(event);
        return Effect.runPromise(serve(event));
      },
    });
    const edge = yield* CloudFrontServer.make({
      origin: origin.url,
      customHeaders: {
        [CloudFront.ORIGIN_SECRET_HEADER]: Redacted.value(OriginSecret.headerValue(keyring)),
      },
      host: viewerHost,
    });
    const call = (headers: Record<string, string>) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() => fetch(`${edge.url}/v1/health`, { headers }));
        return {
          status: response.status,
          via: response.headers.get("via"),
          body: Schema.decodeUnknownSync(Echo)(yield* Effect.promise(() => response.json())),
        };
      });
    return { origin, events, call };
  }).pipe(Effect.provide(NodeCrypto.layer));

describe("CloudFrontServer (contract: CloudFront developer guide)", () => {
  it.live("adds the viewer address and the origin secret, in events the adapter accepts", () =>
    Effect.gen(function* () {
      const { origin, events, call } = yield* stack("127.0.0.1");
      const answer = yield* call({});
      expect(answer.status).toBe(200);
      expect(answer.via).toContain("cloudfront.net (CloudFront)");
      expect(answer.body).toEqual({
        caller: "127.0.0.1",
        host: new URL(origin.url).host,
        forwardedFor: "127.0.0.1",
        hasCfId: true,
        leaked: [],
      });
      const event = events[0];
      expect(Schema.is(FunctionUrl.FunctionUrlEvent)(event)).toBe(true);
      // `IP:port`, as the docs give it, and readable by the production parser.
      const viewer = event?.headers[CloudFront.VIEWER_ADDRESS_HEADER] ?? "";
      expect(viewer).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(Option.map(CloudFront.viewerAddress(viewer), ClientAddress.format)).toEqual(
        Option.some("127.0.0.1"),
      );
    }),
  );

  it.live("replaces what a viewer sends under CloudFront's and the origin's header names", () =>
    Effect.gen(function* () {
      const { events, call } = yield* stack("127.0.0.1");
      const answer = yield* call({
        [CloudFront.VIEWER_ADDRESS_HEADER]: "198.51.100.10:46532",
        [CloudFront.ORIGIN_SECRET_HEADER]: "1:forged",
        [FunctionUrl.SOURCE_IP_HEADER]: "198.51.100.10",
        "x-forwarded-for": "198.51.100.10",
        "x-real-ip": "198.51.100.10",
      });
      expect(answer.status).toBe(200);
      expect(answer.body.caller).toBe("127.0.0.1");
      // X-Forwarded-For is appended to, never trusted.
      expect(answer.body.forwardedFor).toBe("198.51.100.10,127.0.0.1");
      expect(events[0]?.headers["x-real-ip"]).toBeUndefined();
      expect(events[0]?.headers[CloudFront.VIEWER_ADDRESS_HEADER]).toMatch(/^127\.0\.0\.1:/);
    }),
  );

  it.live("writes an IPv6 viewer without brackets, the port after the last colon", () =>
    Effect.gen(function* () {
      const { events, call } = yield* stack("::1");
      const answer = yield* call({});
      expect(answer.body.caller).toBe("::1");
      expect(events[0]?.headers[CloudFront.VIEWER_ADDRESS_HEADER]).toMatch(/^::1:\d+$/);
    }),
  );

  it.live("is the only way in: the same origin refuses a viewer that calls it directly", () =>
    Effect.gen(function* () {
      const { origin } = yield* stack("127.0.0.1");
      const response = yield* Effect.promise(() =>
        fetch(`${origin.url}/v1/health`, {
          headers: {
            [CloudFront.VIEWER_ADDRESS_HEADER]: "198.51.100.10:46532",
            [CloudFront.ORIGIN_SECRET_HEADER]: "1:forged",
          },
        }),
      );
      expect(response.status).toBe(403);
    }),
  );
});
