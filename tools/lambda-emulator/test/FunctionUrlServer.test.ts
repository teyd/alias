import { FunctionUrl } from "@alias/aws";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FunctionUrlServer } from "../src/index.ts";

const isEvent = Schema.is(FunctionUrl.FunctionUrlEvent);

const captured: Array<FunctionUrl.FunctionUrlEvent> = [];

/** Echoes what it received and exercises cookies, binary bodies and implicit JSON results. */
const handler = async (event: FunctionUrl.FunctionUrlEvent): Promise<Schema.Json> => {
  captured.push(event);
  if (event.rawPath === "/implicit") return { hello: "world" };
  if (event.rawPath === "/boom") throw new Error("boom");
  if (event.rawPath === "/binary") {
    return {
      statusCode: 200,
      headers: { "content-type": "image/png" },
      body: "AAEC",
      isBase64Encoded: true,
    };
  }
  return {
    statusCode: 201,
    headers: { "content-type": "application/json" },
    cookies: ["a=1; Path=/", "b=2"],
    body: JSON.stringify({ path: event.rawPath, query: event.rawQueryString }),
  };
};

const server = FunctionUrlServer.layer({ handler }).pipe(Layer.provide(NodeCrypto.layer));

const call = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const { url } = yield* FunctionUrlServer.FunctionUrlServer;
    return yield* Effect.promise(() => fetch(`${url}${path}`, init));
  });

describe("toEvent (pure)", () => {
  it("builds a documented payload-2.0 event", () => {
    const event = FunctionUrlServer.toEvent(
      {
        method: "POST",
        target: "/my/path?a=1&a=2",
        headers: [
          ["Host", "fn.test"],
          ["Content-Type", "text/plain"],
          ["Cookie", "c1=x; c2=y"],
          ["X-Multi", "1"],
          ["x-multi", "2"],
        ],
        body: new TextEncoder().encode("Hello"),
        sourceIp: "203.0.113.1",
      },
      { requestId: "req", now: DateTime.makeUnsafe(1_583_348_638_390) },
    );
    expect(isEvent(event)).toBe(true);
    expect(event).toMatchObject({
      rawPath: "/my/path",
      rawQueryString: "a=1&a=2",
      cookies: ["c1=x", "c2=y"],
      headers: { host: "fn.test", "content-type": "text/plain", "x-multi": "1,2" },
      body: "Hello",
      isBase64Encoded: false,
      requestContext: { domainName: "fn.test", timeEpoch: 1_583_348_638_390 },
    });
    expect(event.headers["cookie"]).toBeUndefined();
  });
});

describe("FunctionUrlServer (in-process, port 0)", () => {
  it.layer(server)((it) => {
    it.effect("invokes the handler with a valid event and returns its result", () =>
      Effect.gen(function* () {
        const response = yield* call("/echo?x=1", {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array([0, 1, 2]),
        });
        expect(response.status).toBe(201);
        expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2"]);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          path: "/echo",
          query: "x=1",
        });

        const event = captured.at(-1);
        expect(event !== undefined && isEvent(event)).toBe(true);
        expect(event?.isBase64Encoded).toBe(true);
        expect(event?.body).toBe("AAEC");
      }),
    );

    it.effect("treats a result without statusCode as a JSON body", () =>
      Effect.gen(function* () {
        const response = yield* call("/implicit");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(yield* Effect.promise(() => response.json())).toEqual({ hello: "world" });
      }),
    );

    it.effect("decodes base64 response bodies", () =>
      Effect.gen(function* () {
        const response = yield* call("/binary");
        expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(
          new Uint8Array([0, 1, 2]),
        );
      }),
    );

    it.effect("answers 502 when the function throws", () =>
      Effect.gen(function* () {
        const response = yield* call("/boom");
        expect(response.status).toBe(502);
      }),
    );
  });
});
