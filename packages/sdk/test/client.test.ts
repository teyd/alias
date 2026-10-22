import { TestApi } from "@alias/api/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { AliasClient, AliasNotFound, Forbidden } from "../src/index.ts";

/** The API behind the function URL emulator, and a token Ada minted in her session. */
const withToken = Effect.fn("withToken")(function* (scopes: ReadonlyArray<string>) {
  const api = yield* TestApi.served;
  const ada = yield* TestApi.signedIn(api.browser, "ada");
  const created = yield* ada.browser.post("/v1/tokens", { name: "sdk", scopes });
  const { token } = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(created.body);
  return { api, options: { baseUrl: api.url, token: Redacted.make(token) } };
});

describe("@alias/sdk over HTTP (API on the function URL emulator)", () => {
  it.live("calls the API with a token and fails with the endpoint's typed errors", () =>
    Effect.gen(function* () {
      const { options } = yield* withToken(["aliases:read", "aliases:write"]);
      const client = yield* AliasClient.make(options);

      const created = yield* client.aliases.create({
        payload: { _tag: "Random", domain: "alias.test", mode: "forward" },
      });
      expect(created).toMatchObject({ mode: "forward", isActive: true, forwardedCount: 0 });
      expect(yield* client.aliases.list()).toEqual([created]);
      expect((yield* client.account.me()).username).toBe("ada");

      const [local = "", domain = ""] = created.address.split("@");
      yield* client.aliases.remove({ params: { domain, local } });
      const missing = yield* Effect.flip(client.aliases.lookup({ params: { domain, local } }));
      expect(missing).toBeInstanceOf(AliasNotFound);
      // The token lacks `recipients:read`.
      const refused = yield* Effect.flip(client.recipients.list());
      expect(refused).toEqual(new Forbidden({ scope: "recipients:read" }));
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

  it.live("runs as plain promises for callers without Effect", () =>
    Effect.gen(function* () {
      const { options } = yield* withToken(["aliases:read"]);
      const failure = yield* Effect.promise(async () => {
        const client = await Effect.runPromise(
          AliasClient.make(options).pipe(Effect.provide(FetchHttpClient.layer)),
        );
        expect(await Effect.runPromise(client.aliases.list())).toEqual([]);
        return Effect.runPromise(
          client.aliases.lookup({ params: { domain: "alias.test", local: "nobody" } }),
        ).catch((error: AliasNotFound) => error);
      });
      expect(failure).toBeInstanceOf(AliasNotFound);
    }),
  );
});
