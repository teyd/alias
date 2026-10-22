import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import { Egress, Proxy } from "../src/index.ts";
import { onlyLoopback, origin, PNG } from "./support/index.ts";

/**
 * The proxy's egress against a local origin on 127.0.0.1. Production's policy refuses loopback,
 * so tests that need the origin allow exactly 127.0.0.1 and nothing else; everything the
 * production policy must refuse is tested with the production policy itself.
 */

const fetchWith = (url: string, policy: Layer.Layer<Egress.EgressPolicy>, limits = Proxy.limits) =>
  Egress.fetchImage(new URL(url), limits).pipe(Effect.provide(policy));

/** The error's tag and reason, for refusals. */
const refusal = (url: string, policy: Layer.Layer<Egress.EgressPolicy> = Egress.publicInternet) =>
  Effect.map(Effect.flip(fetchWith(url, policy)), (error) => ({
    tag: error._tag,
    reason: error.reason,
  }));

describe("Egress.isPublicAddress", () => {
  it.each([
    ["93.184.215.14", true],
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true],
    ["2a00:1450:4001:82a::200e", true],
    ["127.0.0.1", false],
    ["127.255.255.254", false],
    ["0.0.0.0", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["172.31.255.255", false],
    ["192.168.1.1", false],
    ["100.64.0.1", false],
    ["169.254.169.254", false],
    ["169.254.170.2", false],
    ["192.0.0.192", false],
    ["198.18.0.1", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["::", false],
    ["::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:169.254.169.254", false],
    ["::7f00:1", false],
    ["fd00:ec2::254", false],
    ["fc00::1", false],
    ["fe80::1", false],
    ["ff02::1", false],
    ["2001:db8::1", false],
    ["2002:7f00:1::", false],
    ["64:ff9b::7f00:1", false],
    ["not-an-address", false],
  ])("%s is public: %s", (address, isPublic) => {
    expect(Egress.isPublicAddress(address)).toBe(isPublic);
  });
});

describe("Egress.fetchImage", () => {
  it.effect("refuses private, loopback and metadata addresses, however they are written", () =>
    Effect.gen(function* () {
      const refusedHost = {
        tag: "EgressRefused",
        reason: expect.stringMatching(/not a public address/),
      };
      expect(yield* refusal("http://127.0.0.1/x.png")).toEqual(refusedHost);
      expect(yield* refusal("http://0x7f000001/x.png")).toEqual(refusedHost);
      expect(yield* refusal("http://2130706433/x.png")).toEqual(refusedHost);
      expect(yield* refusal("http://[::1]/x.png")).toEqual(refusedHost);
      expect(yield* refusal("http://[::ffff:127.0.0.1]/x.png")).toEqual(refusedHost);
      expect(yield* refusal("http://169.254.169.254/latest/meta-data/")).toEqual(refusedHost);
      expect(yield* refusal("https://10.0.0.1/x.png")).toEqual(refusedHost);
    }),
  );

  it.effect("refuses a host name that resolves to a non-public address (checked at connect)", () =>
    Effect.gen(function* () {
      expect(yield* refusal("http://localhost/x.png")).toEqual({
        tag: "EgressRefused",
        reason: "localhost resolves to a non-public address",
      });
    }),
  );

  it.effect("refuses other schemes, other ports and credentials", () =>
    Effect.gen(function* () {
      expect(yield* refusal("ftp://img.example/x.png")).toMatchObject({ reason: "scheme ftp:" });
      expect(yield* refusal("file:///etc/passwd")).toMatchObject({ reason: "scheme file:" });
      expect(yield* refusal("http://img.example:6379/x.png")).toMatchObject({
        reason: "port 6379",
      });
      expect(yield* refusal("https://user:pass@img.example/x.png")).toMatchObject({
        reason: "credentials in the URL",
      });
    }),
  );

  it.effect("fetches an image and sends nothing that identifies a reader", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, requests } = yield* origin;
        const fetched = yield* fetchWith(`${url}/pixel.png`, onlyLoopback);
        expect(fetched.body).toEqual(PNG);
        const [request] = requests;
        expect(Arr.sort(R.keys(request?.headers ?? {}), Order.String)).toEqual([
          "accept",
          "connection",
          "host",
          "user-agent",
        ]);
        expect(request?.headers["user-agent"]).toMatch(/^AliasImageProxy\//);
      }),
    ),
  );

  it.effect("follows up to three redirects, checking every hop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* origin;
        expect((yield* fetchWith(`${url}/redirect?hops=3`, onlyLoopback)).body).toEqual(PNG);
        expect(yield* refusal(`${url}/redirect?hops=4`, onlyLoopback)).toEqual({
          tag: "EgressRefused",
          reason: "too many redirects",
        });
        // An allowed host redirecting to the metadata service, or to a name that resolves to
        // loopback: refused at the hop.
        expect(
          yield* refusal(
            `${url}/redirect?to=http://169.254.169.254/latest/meta-data/`,
            onlyLoopback,
          ),
        ).toMatchObject({
          tag: "EgressRefused",
          reason: "169.254.169.254 is not a public address",
        });
        expect(
          yield* refusal(
            `${url}/redirect?to=${encodeURIComponent(`http://localhost:${new URL(url).port}/pixel.png`)}`,
            Egress.publicInternet,
          ),
        ).toMatchObject({ tag: "EgressRefused" });
        expect(yield* refusal(`${url}/redirect?to=file:///etc/passwd`, onlyLoopback)).toEqual({
          tag: "EgressRefused",
          reason: "scheme file:",
        });
      }),
    ),
  );

  it.live("stops at the size limit, declared or not, and at the deadline (real time)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* origin;
        const small = { ...Proxy.limits, maxBytes: 32 * 1024, timeout: Duration.millis(300) };
        const failure = (path: string) =>
          Effect.map(
            Effect.flip(fetchWith(`${url}${path}`, onlyLoopback, small)),
            (error) => error.reason,
          );
        expect(yield* failure("/huge.png")).toBe("too large");
        expect(yield* failure("/stream.png")).toBe("too large");
        expect(yield* failure("/slow.png")).toBe("timed out");
        expect(yield* failure("/missing.png")).toBe("unexpected status");
      }),
    ),
  );
});
