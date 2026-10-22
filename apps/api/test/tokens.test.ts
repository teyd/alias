import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { MAX_FAILURES_PER_HOUR } from "../src/Authentication.ts";
import * as Browser from "./support/Browser.ts";
import * as TestApi from "./support/TestApi.ts";

const SESSION = "__Host-alias_session";

const CreatedToken = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
  hint: Schema.String,
});

const random = { _tag: "Random", domain: "alias.test", mode: "forward" };

/** The API on its own fakecloud, with Ada signed in and a token minted with `scopes`. */
const withToken = Effect.fn("withToken")(function* (
  scopes: ReadonlyArray<string>,
  extra: Record<string, number> = {},
) {
  const api = yield* TestApi.make;
  const ada = yield* TestApi.signedIn(api.browser, "ada");
  const created = yield* ada.browser.post("/v1/tokens", { name: "laptop", scopes, ...extra });
  expect(created.status).toBe(201);
  const token = Schema.decodeUnknownSync(CreatedToken)(created.body);
  return { api, ada, ...token, client: api.withToken(token.token) };
});

describe("personal API tokens (API handler on fakecloud)", () => {
  it.effect("are shown once, listed without the secret, and act for their user", () =>
    Effect.gen(function* () {
      const { ada, client, token, hint, id } = yield* withToken(["aliases:read", "aliases:write"]);
      expect(token).toMatch(/^alias_pat_[A-Za-z0-9_-]{43}$/);
      expect(hint).toBe(token.slice(-4));

      const listed = yield* ada.browser.get("/v1/tokens");
      expect(listed.body).toEqual([
        {
          id,
          name: "laptop",
          scopes: ["aliases:read", "aliases:write"],
          hint,
          createdAt: expect.any(String),
        },
      ]);
      expect(JSON.stringify(listed.body)).not.toContain(token);

      const created = yield* client.post("/v1/aliases", random);
      expect(created.status).toBe(201);
      const aliases = yield* ada.browser.get("/v1/aliases");
      expect(aliases.body).toEqual([created.body]);
      expect((yield* client.get("/v1/me")).body).toEqual({ userId: ada.userId, username: "ada" });

      // The first use is recorded.
      expect((yield* ada.browser.get("/v1/tokens")).body).toMatchObject([
        { lastUsedAt: expect.any(String) },
      ]);
    }),
  );

  it.effect("reach only endpoints whose scope they hold", () =>
    Effect.gen(function* () {
      const { client } = yield* withToken(["aliases:read"]);
      expect((yield* client.get("/v1/aliases")).status).toBe(200);
      expect(yield* client.post("/v1/aliases", random)).toMatchObject({
        status: 403,
        body: { _tag: "Forbidden", scope: "aliases:write" },
      });
      expect(yield* client.get("/v1/recipients")).toMatchObject({
        status: 403,
        body: { scope: "recipients:read" },
      });
      expect((yield* client.get("/v1/settings")).status).toBe(403);
    }),
  );

  it.effect("never reach session-only endpoints: a token can't mint, list or revoke tokens", () =>
    Effect.gen(function* () {
      const { client, id } = yield* withToken(["aliases:read", "aliases:write", "settings:write"]);
      const forbidden = { status: 403, body: { _tag: "Forbidden" } };
      expect(yield* client.get("/v1/tokens")).toMatchObject(forbidden);
      expect(
        yield* client.post("/v1/tokens", { name: "more", scopes: ["aliases:read"] }),
      ).toMatchObject(forbidden);
      expect(yield* client.delete(`/v1/tokens/${id}`)).toMatchObject(forbidden);
      expect((yield* client.get("/v1/tokens")).body).not.toHaveProperty("scope");
    }),
  );

  it.effect("stop working when revoked, and only the owner can revoke", () =>
    Effect.gen(function* () {
      const { api, ada, client, id } = yield* withToken(["aliases:read"]);
      const grace = yield* TestApi.signedIn(api.browser, "grace");
      expect(yield* grace.browser.delete(`/v1/tokens/${id}`)).toMatchObject({
        status: 404,
        body: { _tag: "TokenNotFound" },
      });
      expect((yield* client.get("/v1/aliases")).status).toBe(200);

      expect((yield* ada.browser.delete(`/v1/tokens/${id}`)).status).toBe(204);
      expect(yield* client.get("/v1/aliases")).toMatchObject({
        status: 401,
        body: { _tag: "Unauthenticated" },
      });
      expect((yield* ada.browser.get("/v1/tokens")).body).toEqual([]);
    }),
  );

  it.effect("expire after the chosen number of days", () =>
    Effect.gen(function* () {
      const { client } = yield* withToken(["aliases:read"], { expiresInDays: 1 });
      yield* TestClock.adjust("23 hours");
      expect((yield* client.get("/v1/aliases")).status).toBe(200);
      yield* TestClock.adjust("1 hour");
      expect((yield* client.get("/v1/aliases")).status).toBe(401);
    }),
  );

  it.effect("rejects malformed or unknown tokens, and tokens without a session cookie", () =>
    Effect.gen(function* () {
      const { api, token } = yield* withToken(["aliases:read"]);
      const unknown = `alias_pat_${"A".repeat(43)}`;
      const statuses = yield* Effect.forEach(
        ["", "garbage", unknown, token.slice(0, -1), `${token}x`],
        (bad) => Effect.map(api.withToken(bad).get("/v1/aliases"), (response) => response.status),
        { concurrency: 1 },
      );
      expect(statuses).toEqual([401, 401, 401, 401, 401]);
    }),
  );

  it.effect("keeps a valid session working whatever bearer header comes along", () =>
    Effect.gen(function* () {
      const { api, ada } = yield* withToken(["aliases:read"]);
      const both = Browser.make(api.handle, { headers: { authorization: "Bearer junk" } });
      both.setCookie(SESSION, yield* Effect.fromOption(ada.browser.cookie(SESSION)));
      // The session is tried first, so even a session-only endpoint answers.
      expect((yield* both.get("/v1/tokens")).status).toBe(200);
    }),
  );

  it.effect("answers 429 to a client address after too many failed attempts in an hour", () =>
    Effect.gen(function* () {
      const { api, token } = yield* withToken(["aliases:read"]);
      const attacker = api.withToken(`alias_pat_${"B".repeat(43)}`, "203.0.113.9");
      const statuses = yield* Effect.forEach(
        Arr.range(1, MAX_FAILURES_PER_HOUR + 1),
        () => Effect.map(attacker.get("/v1/aliases"), (response) => response.status),
        { concurrency: 1 },
      );
      expect(statuses).toEqual([...Arr.replicate(401, MAX_FAILURES_PER_HOUR), 429]);
      // Even a valid token from that address waits; other addresses don't.
      expect((yield* api.withToken(token, "203.0.113.9").get("/v1/aliases")).status).toBe(429);
      expect((yield* api.withToken(token).get("/v1/aliases")).status).toBe(200);
      yield* TestClock.adjust("1 hour");
      expect((yield* api.withToken(token, "203.0.113.9").get("/v1/aliases")).status).toBe(200);
    }),
  );

  it.effect("validates new tokens: a name, known scopes, and 1 to 366 days", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      const statuses = yield* Effect.forEach(
        [
          { name: "x", scopes: [] },
          { name: "x", scopes: ["admin"] },
          { name: " ", scopes: ["aliases:read"] },
          { name: "x", scopes: ["aliases:read"], expiresInDays: 0 },
          { name: "x", scopes: ["aliases:read"], expiresInDays: 367 },
        ],
        (payload) => Effect.map(browser.post("/v1/tokens", payload), (response) => response.status),
        { concurrency: 1 },
      );
      expect(statuses).toEqual([400, 400, 400, 400, 400]);
      expect((yield* api.browser().post("/v1/tokens", { name: "x", scopes: [] })).status).toBe(401);
    }),
  );
});
