import { describe, expect, it } from "@effect/vitest";
import { ClientAddress, Keyring } from "@alias/core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import documented from "../fixtures/function-url-request.json" with { type: "json" };
import response from "../fixtures/function-url-response.json" with { type: "json" };
import { CloudFront, FunctionUrl } from "../src/index.ts";

// The documented sample uses placeholders like `<url-id>`; give it a domain AWS would really send.
const request = {
  ...documented,
  requestContext: {
    ...documented.requestContext,
    domainName: "abc123.lambda-url.eu-west-1.on.aws",
  },
};

describe("FunctionUrl (contract: AWS documentation payloads)", () => {
  it.effect("decodes the documented request payload", () =>
    Effect.gen(function* () {
      const event = yield* Schema.decodeUnknownEffect(FunctionUrl.FunctionUrlEvent)(documented);
      expect(event.requestContext.http.method).toBe("POST");
    }),
  );

  it.effect("decodes the documented response payload", () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(FunctionUrl.FunctionUrlResult)(response);
      expect(result.statusCode).toBe(201);
    }),
  );

  it.effect("rebuilds the web request: URL, query, cookies and body", () =>
    Effect.gen(function* () {
      const built = yield* FunctionUrl.decode(request).pipe(Effect.flatMap(FunctionUrl.toRequest));
      expect(built.method).toBe("POST");
      expect(built.url).toBe(
        "https://abc123.lambda-url.eu-west-1.on.aws/my/path?parameter1=value1&parameter1=value2&parameter2=value",
      );
      expect(built.headers.get("cookie")).toBe("cookie1; cookie2");
      expect(built.headers.get("header2")).toBe("value1,value2");
      expect(yield* Effect.promise(() => built.text())).toBe("Hello from client!");
    }),
  );

  it.effect("passes the caller's address in a header the client can't set", () =>
    Effect.gen(function* () {
      const built = yield* FunctionUrl.decode({
        ...request,
        headers: { ...request.headers, [FunctionUrl.SOURCE_IP_HEADER]: "10.0.0.1" },
      }).pipe(Effect.flatMap(FunctionUrl.toRequest));
      expect(built.headers.get(FunctionUrl.SOURCE_IP_HEADER)).toBe("123.123.123.123");
    }),
  );

  it.effect("decodes base64 request bodies", () =>
    Effect.gen(function* () {
      const built = yield* FunctionUrl.decode({
        ...request,
        body: btoa("binary\u0000payload"),
        isBase64Encoded: true,
      }).pipe(Effect.flatMap(FunctionUrl.toRequest));
      expect(new Uint8Array(yield* Effect.promise(() => built.arrayBuffer()))).toEqual(
        new TextEncoder().encode("binary\u0000payload"),
      );
    }),
  );

  it.effect("fails with a typed error, not a crash, when the URL can't be built", () =>
    Effect.gen(function* () {
      const event = yield* FunctionUrl.decode(documented);
      const error = yield* Effect.flip(FunctionUrl.toRequest(event));
      expect(error._tag).toBe("InvalidFunctionUrlEvent");
    }),
  );

  it.effect("rejects payloads that are not function URL events", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(FunctionUrl.decode({ Records: [] }));
      expect(error._tag).toBe("InvalidFunctionUrlEvent");
    }),
  );

  it.effect("returns JSON as text, binary as base64, and cookies separately", () =>
    Effect.gen(function* () {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      const json = yield* FunctionUrl.fromResponse(
        new Response('{"ok":true}', { status: 201, headers }),
      );
      expect(json).toEqual({
        statusCode: 201,
        headers: { "content-type": "application/json" },
        cookies: ["a=1", "b=2"],
        body: '{"ok":true}',
        isBase64Encoded: false,
      });
      expect(Schema.is(FunctionUrl.FunctionUrlResult)(json)).toBe(true);

      const binary = yield* FunctionUrl.fromResponse(
        new Response(new Uint8Array([0, 1, 2]), {
          headers: { "content-type": "application/octet-stream" },
        }),
      );
      expect(binary.isBase64Encoded).toBe(true);
      expect(binary.body).toBe("AAEC");
    }),
  );

  it.effect("serves an event end to end through a web handler", () =>
    Effect.gen(function* () {
      const serve = FunctionUrl.handle(async (incoming) =>
        Response.json({ path: new URL(incoming.url).pathname }),
      );
      const event = yield* FunctionUrl.decode({
        ...request,
        rawPath: "/health",
        rawQueryString: "",
      });
      const result = yield* serve(event);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body ?? "")).toEqual({ path: "/health" });
    }),
  );
});

const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64url");
const originSecrets = Keyring.parse(Redacted.make(`2:${secret(2)},1:${secret(1)}`));

/** Echoes the caller address the handler sees, and whether any front header got through. */
const echo = async (incoming: Request) =>
  Response.json({
    caller: incoming.headers.get(FunctionUrl.SOURCE_IP_HEADER),
    leaked: [CloudFront.ORIGIN_SECRET_HEADER, CloudFront.VIEWER_ADDRESS_HEADER].filter((name) =>
      incoming.headers.has(name),
    ),
  });

const serveWith = (front: FunctionUrl.Front, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const event = yield* FunctionUrl.decode({
      ...request,
      headers: { ...request.headers, ...headers },
    });
    const result = yield* FunctionUrl.handle(echo, front)(event);
    return { status: result.statusCode, body: JSON.parse(result.body ?? "null") };
  });

describe("FunctionUrl behind CloudFront (PLAN.md §20.26)", () => {
  // The documentation's example value.
  const viewer = { [CloudFront.VIEWER_ADDRESS_HEADER]: "198.51.100.10:46532" };

  it.effect("trusts CloudFront-Viewer-Address only with a valid origin secret", () =>
    Effect.gen(function* () {
      const front = FunctionUrl.cloudFront(yield* originSecrets);
      const answers = yield* Effect.forEach(
        [`2:${secret(2)}`, `1:${secret(1)}`],
        (proof) => serveWith(front, { ...viewer, [CloudFront.ORIGIN_SECRET_HEADER]: proof }),
        { concurrency: 1 },
      );
      expect(answers).toEqual(
        Arr.replicate({ status: 200, body: { caller: "198.51.100.10", leaked: [] } }, 2),
      );
    }),
  );

  it.effect("refuses requests that skipped CloudFront, whatever they claim", () =>
    Effect.gen(function* () {
      const front = FunctionUrl.cloudFront(yield* originSecrets);
      const attempts: ReadonlyArray<Record<string, string>> = [
        {},
        viewer,
        { ...viewer, [FunctionUrl.SOURCE_IP_HEADER]: "198.51.100.10" },
        { ...viewer, [CloudFront.ORIGIN_SECRET_HEADER]: `3:${secret(2)}` },
        { ...viewer, [CloudFront.ORIGIN_SECRET_HEADER]: `2:${secret(1)}` },
        { ...viewer, [CloudFront.ORIGIN_SECRET_HEADER]: secret(2) },
      ];
      const answers = yield* Effect.forEach(attempts, (headers) => serveWith(front, headers), {
        concurrency: 1,
      });
      expect(answers.map((answer) => answer.status)).toEqual(Arr.replicate(403, attempts.length));
    }),
  );

  it.effect("fails closed when a proven request has no usable viewer address", () =>
    Effect.gen(function* () {
      const front = FunctionUrl.cloudFront(yield* originSecrets);
      const proof = { [CloudFront.ORIGIN_SECRET_HEADER]: `2:${secret(2)}` };
      const viewers = ["198.51.100.10", "198.51.100.10:1,192.0.2.1:2", "x:1"];
      const answers = yield* Effect.forEach(
        [
          proof,
          ...viewers.map((value) => ({ ...proof, [CloudFront.VIEWER_ADDRESS_HEADER]: value })),
        ],
        (headers) => serveWith(front, headers),
        { concurrency: 1 },
      );
      expect(answers.map((answer) => answer.status)).toEqual(Arr.replicate(403, 4));
    }),
  );

  it.effect("ignores client-sent addresses and secrets when called directly", () =>
    Effect.gen(function* () {
      expect(
        yield* serveWith(FunctionUrl.direct, {
          ...viewer,
          [FunctionUrl.SOURCE_IP_HEADER]: "10.0.0.1",
          [CloudFront.ORIGIN_SECRET_HEADER]: `2:${secret(2)}`,
        }),
      ).toEqual({ status: 200, body: { caller: "123.123.123.123", leaked: [] } });
    }),
  );
});

describe("CloudFront.viewerAddress", () => {
  it.each<readonly [string, string]>([
    ["198.51.100.10:46532", "198.51.100.10"],
    ["2001:db8:85a3::8a2e:370:7334:46532", "2001:db8:85a3::8a2e:370:7334"],
    ["[2001:db8::1]:443", "2001:db8::1"],
    ["::ffff:198.51.100.10:80", "198.51.100.10"],
  ])("reads %j as %j", (value, address) => {
    expect(Option.map(CloudFront.viewerAddress(value), ClientAddress.format)).toEqual(
      Option.some(address),
    );
  });

  it.each([
    "198.51.100.10",
    "198.51.100.10:",
    "198.51.100.10:65536",
    "198.51.100.10:1, 192.0.2.1:2",
    "unknown:80",
  ])("refuses %j", (value) => {
    expect(Option.isNone(CloudFront.viewerAddress(value))).toBe(true);
  });
});
