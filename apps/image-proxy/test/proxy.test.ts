import { AwsClient, FunctionUrl, Parameters } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { ImageProxy } from "@alias/core";
import { FunctionUrlServer } from "@alias/lambda-emulator";
import * as SSM from "@distilled.cloud/aws/ssm";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { Egress, Proxy } from "../src/index.ts";
import { ServicesConfig } from "../src/config.ts";
import { onlyLoopback, origin, PNG } from "./support/index.ts";

/**
 * The image proxy Lambda as it runs: keys from SSM Parameter Store on fakecloud, the handler
 * behind the function URL emulator, a local origin on 127.0.0.1 standing in for a sender's image
 * host. Only the tests that need that origin allow 127.0.0.1; production's policy is tested in
 * `egress.test.ts` and below.
 */
const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

const parameter = "/alias/test/image-proxy-keys";
const KEYS = `1:${Buffer.alloc(32, 5).toString("base64url")}`;

/** Puts the keys the way production stores them and loads them the way the Lambda does. */
const keys = Effect.fn("keys")(function* () {
  yield* SSM.putParameter({ Name: parameter, Value: KEYS, Type: "SecureString", Overwrite: true });
  return yield* Parameters.keyring(parameter);
});

/** The handler behind a function URL, with `policy` as its egress; stops with the test's scope. */
const server = Effect.fn("server")(function* (policy: Layer.Layer<Egress.EgressPolicy>) {
  const loaded = yield* keys();
  const services = Layer.mergeAll(Layer.succeed(Proxy.ProxyKeys, loaded), policy, NodeCrypto.layer);
  const { url } = yield* FunctionUrlServer.make({
    handler: (event) =>
      Effect.runPromise(
        FunctionUrl.decode(event).pipe(Effect.flatMap(Proxy.handle), Effect.provide(services)),
      ),
  });
  const signer: ImageProxy.Signer = { base: url, keys: loaded };
  return { url, sign: (target: string) => ImageProxy.sign(signer, target) };
});

const get = (url: string, init: RequestInit = {}) =>
  Effect.promise(async () => {
    const response = await fetch(url, init);
    return {
      status: response.status,
      headers: R.fromEntries(Arr.fromIterable(response.headers)),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  });

describe("image proxy (fakecloud SSM + function URL emulator)", () => {
  it.layer(Layer.mergeAll(aws, NodeCrypto.layer).pipe(Layer.provideMerge(FakeCloud.layer())), {
    timeout: 30_000,
  })((it) => {
    it.effect("serves a signed image with only its type and our cache and security headers", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* origin;
          const proxy = yield* server(onlyLoopback);
          const response = yield* get(yield* proxy.sign(`${host.url}/pixel.png`), {
            headers: { cookie: "session=reader", referer: "https://webmail.example/inbox/42" },
          });
          expect(response.status).toBe(200);
          expect(response.body).toEqual(PNG);
          expect(response.headers).toMatchObject({
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "referrer-policy": "no-referrer",
          });
          // The origin's cookie and its other headers don't come back…
          expect(response.headers["set-cookie"]).toBeUndefined();
          expect(response.headers["x-origin-secret"]).toBeUndefined();
          // …and the reader's cookie and referrer never reached the origin.
          const [request] = host.requests;
          expect(request?.headers.cookie).toBeUndefined();
          expect(request?.headers.referer).toBeUndefined();
        }),
      ),
    );

    it.effect("trusts the bytes, not the origin's Content-Type", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* origin;
          const proxy = yield* server(onlyLoopback);
          const mislabelled = yield* get(yield* proxy.sign(`${host.url}/mislabelled`));
          expect(mislabelled).toMatchObject({
            status: 200,
            headers: { "content-type": "image/png" },
          });
          // SVG can carry scripts, and HTML labelled as PNG is still HTML.
          expect((yield* get(yield* proxy.sign(`${host.url}/logo.svg`))).status).toBe(415);
          const html = yield* get(yield* proxy.sign(`${host.url}/page.html`));
          expect(html.status).toBe(415);
          expect(html.body).toEqual(new Uint8Array());
        }),
      ),
    );

    it.effect("is no open relay: unsigned, tampered and foreign-key URLs are refused", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* origin;
          const proxy = yield* server(onlyLoopback);
          const signed = yield* proxy.sign(`${host.url}/pixel.png`);
          const evil = Buffer.from(`${host.url}/page.html`).toString("base64url");
          const tampered = `${signed.slice(0, signed.lastIndexOf("/"))}/${evil}`;
          expect((yield* get(tampered)).status).toBe(403);
          expect((yield* get(`${proxy.url}/img/1/AAAAAAAAAAAAAAAAAAAAAA/${evil}`)).status).toBe(
            403,
          );
          expect((yield* get(`${proxy.url}/?url=${host.url}/pixel.png`)).status).toBe(403);
          expect((yield* get(signed, { method: "POST", body: "x" })).status).toBe(405);
          expect(host.requests).toEqual([]);
        }),
      ),
    );

    it.effect("answers HEAD without a body, and origin failures with a short-lived 502", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* origin;
          const proxy = yield* server(onlyLoopback);
          const head = yield* get(yield* proxy.sign(`${host.url}/pixel.png`), { method: "HEAD" });
          expect(head).toMatchObject({ status: 200, headers: { "content-type": "image/png" } });
          expect(head.body).toEqual(new Uint8Array());
          const missing = yield* get(yield* proxy.sign(`${host.url}/missing.png`));
          expect(missing).toMatchObject({
            status: 502,
            headers: { "cache-control": "public, max-age=300" },
          });
        }),
      ),
    );

    it.effect("runs with production's egress from its configuration, which refuses loopback", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* origin;
          const { url: fakecloud } = yield* FakeCloud.FakeCloud;
          yield* keys();
          const services = yield* Effect.provideService(
            ServicesConfig,
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({
              env: { ALIAS_IMAGE_PROXY_KEYS_PARAMETER: parameter, AWS_ENDPOINT_URL_SSM: fakecloud },
            }),
          );
          const loaded = yield* Parameters.keyring(parameter);
          const path = yield* ImageProxy.sign({ base: "", keys: loaded }, `${host.url}/pixel.png`);
          const event = {
            version: "2.0",
            rawPath: path,
            rawQueryString: "",
            headers: { host: "img.alias.test" },
            requestContext: {
              domainName: "img.alias.test",
              requestId: "r1",
              timeEpoch: 0,
              http: { method: "GET", path, sourceIp: "203.0.113.9" },
            },
            isBase64Encoded: false,
          } satisfies FunctionUrl.FunctionUrlEvent;
          const result = yield* Proxy.handle(event).pipe(Effect.provide(services));
          // The result is what Lambda takes from a function URL handler.
          expect(Schema.decodeUnknownSync(FunctionUrl.FunctionUrlResult)(result)).toMatchObject({
            statusCode: 403,
          });
          expect(host.requests).toEqual([]);
        }),
      ),
    );
  });
});
