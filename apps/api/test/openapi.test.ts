import { openApiDocument } from "@alias/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Validator } from "@seriousme/openapi-schema-validator";
import * as Effect from "effect/Effect";
import * as TestApi from "./support/TestApi.ts";

const operation = (path: string, method: "get" | "post" | "patch" | "delete") =>
  openApiDocument.paths[path]?.[method];

describe("OpenAPI document", () => {
  it.effect("is valid OpenAPI 3.1 by the official schema", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        new Validator().validate(JSON.parse(JSON.stringify(openApiDocument))),
      );
      expect(result).toEqual({ valid: true });
      expect(openApiDocument.openapi).toBe("3.1.0");
    }),
  );

  it("names each operation's token scope, or none for session-only operations", () => {
    expect(operation("/v1/aliases", "get")?.security).toEqual([
      { session: [] },
      { token: ["aliases:read"] },
    ]);
    expect(operation("/v1/aliases/{domain}/{local}", "delete")?.security).toEqual([
      { session: [] },
      { token: ["aliases:write"] },
    ]);
    expect(operation("/v1/me", "get")?.security).toEqual([{ session: [] }, { token: [] }]);
    // Tokens, webhooks and erasure are session-only (PLAN.md §20.20).
    expect(operation("/v1/tokens", "post")?.security).toEqual([{ session: [] }]);
    expect(operation("/v1/webhooks", "get")?.security).toEqual([{ session: [] }]);
    expect(operation("/v1/me/erase", "post")?.security).toEqual([{ session: [] }]);
    expect(operation("/health", "get")?.security).toEqual([]);
    expect(operation("/v1/aliases", "get")?.description).toBe(
      "API tokens need the `aliases:read` scope.",
    );
    expect(openApiDocument.components.securitySchemes).toMatchObject({
      session: { type: "apiKey", in: "cookie", name: "__Host-alias_session" },
      token: { type: "http", scheme: "Bearer" },
    });
  });

  it.effect("is served at /v1/openapi.json without credentials", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const response = yield* api.browser().get("/v1/openapi.json");
      expect(response.status).toBe(200);
      expect(response.body).toEqual(JSON.parse(JSON.stringify(openApiDocument)));
    }),
  );
});
