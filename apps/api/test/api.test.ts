import { AliasRepo } from "@alias/db";
import { freshTable } from "@alias/db/testing";
import { FakeCloud } from "@alias/aws-emulators";
import { FunctionUrl } from "@alias/aws";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFunctionUrlHandler } from "../src/index.ts";

/** A function URL GET event (payload format 2.0). */
const get = (rawPath: string) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath,
  rawQueryString: "",
  headers: { accept: "application/json", host: "api.alias.test" },
  isBase64Encoded: false,
  requestContext: {
    domainName: "api.alias.test",
    requestId: "req-1",
    timeEpoch: 0,
    http: { method: "GET", path: rawPath, sourceIp: "127.0.0.1" },
  },
});

const database = freshTable().pipe(Layer.provide(FakeCloud.layer()));

const api = Effect.acquireRelease(
  Effect.gen(function* () {
    const context = yield* Layer.build(database);
    yield* AliasRepo.make().pipe(
      Effect.flatMap((repo) =>
        repo.insert({
          id: "al_1",
          userId: "usr_1",
          domain: "alias.test",
          localPart: "shop",
          mode: "forward",
          createdAt: 0,
        }),
      ),
      Effect.provide(context),
    );
    return makeFunctionUrlHandler(Layer.succeedContext(context));
  }),
  (handler) => Effect.promise(() => handler.dispose()),
);

describe("api as a Lambda function URL handler (fakecloud DynamoDB)", () => {
  it.effect("serves health", () =>
    Effect.gen(function* () {
      const { handle } = yield* api;
      const result = yield* FunctionUrl.decode(get("/health")).pipe(Effect.flatMap(handle));
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body ?? "")).toEqual({ status: "ok" });
    }).pipe(Effect.scoped),
  );

  it.effect("looks up an alias in DynamoDB", () =>
    Effect.gen(function* () {
      const { handle } = yield* api;
      const result = yield* FunctionUrl.decode(get("/v1/aliases/alias.test/shop")).pipe(
        Effect.flatMap(handle),
      );
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body ?? "")).toEqual({
        id: "al_1",
        address: "shop@alias.test",
        mode: "forward",
        isActive: true,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("returns a typed 404 for unknown aliases", () =>
    Effect.gen(function* () {
      const { handle } = yield* api;
      const result = yield* FunctionUrl.decode(get("/v1/aliases/alias.test/nobody")).pipe(
        Effect.flatMap(handle),
      );
      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body ?? "")).toMatchObject({ _tag: "AliasNotFound" });
    }).pipe(Effect.scoped),
  );
});
