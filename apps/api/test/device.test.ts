import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { MAX_FAILURES_PER_HOUR } from "../src/Authentication.ts";
import {
  DEVICE_TOKEN_DAYS,
  MAX_CODE_MISSES_PER_HOUR,
  MAX_DEVICE_REQUESTS_PER_HOUR,
} from "../src/device.ts";
import * as Browser from "./support/Browser.ts";
import * as TestApi from "./support/TestApi.ts";

const GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CLI_SCOPES = "aliases:read aliases:write";

const Authorization = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
});

const AccessToken = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
  scope: Schema.String,
});

/** The API on its own fakecloud, Ada signed in, and a device that started a login. */
const started = Effect.fn("started")(function* (scope = CLI_SCOPES) {
  const api = yield* TestApi.make;
  const ada = yield* TestApi.signedIn(api.browser, "ada");
  const device = Browser.make(api.handle, { sourceIp: "203.0.113.9" });
  const response = yield* device.postForm("/v1/oauth/device_authorization", {
    client_id: "alias-cli",
    scope,
  });
  expect(response.status).toBe(200);
  const authorization = Schema.decodeUnknownSync(Authorization)(response.body);
  const poll = () =>
    device.postForm("/v1/oauth/token", {
      grant_type: GRANT,
      device_code: authorization.device_code,
      client_id: "alias-cli",
    });
  return { api, ada, device, authorization, poll };
});

/** The OAuth `error` of a failed response. */
const error = (body: Schema.Json) =>
  Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(body).error;

describe("device login, RFC 8628 (API handler on fakecloud)", () => {
  it.effect("issues a scoped token once the signed-in user approves the code", () =>
    Effect.gen(function* () {
      const { ada, authorization, poll, api } = yield* started();
      expect(authorization.user_code).toMatch(
        /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
      );
      expect(authorization).toMatchObject({
        verification_uri: `${Browser.origin}/device`,
        verification_uri_complete: `${Browser.origin}/device?code=${authorization.user_code}`,
        expires_in: 600,
        interval: 5,
      });

      const pending = yield* poll();
      expect(pending.status).toBe(400);
      expect(pending.body).toMatchObject({ error: "authorization_pending" });
      expect(pending.headers["cache-control"]).toBe("no-store");

      // The person types the code as they like: lowercase, without the dash.
      const typed = authorization.user_code.replace("-", "").toLowerCase();
      const looked = yield* ada.browser.post("/v1/device/lookup", { userCode: typed });
      expect(looked.body).toEqual({
        userCode: authorization.user_code,
        clientId: "alias-cli",
        clientName: "Alias CLI",
        scopes: ["aliases:read", "aliases:write"],
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect((yield* ada.browser.post("/v1/device/approve", { userCode: typed })).status).toBe(204);

      yield* TestClock.adjust("5 seconds");
      const issued = yield* poll();
      expect(issued.status).toBe(200);
      const token = Schema.decodeUnknownSync(AccessToken)(issued.body);
      expect(token).toMatchObject({
        token_type: "Bearer",
        scope: CLI_SCOPES,
        expires_in: DEVICE_TOKEN_DAYS * 86_400,
      });
      expect(token.access_token).toMatch(/^alias_pat_[A-Za-z0-9_-]{43}$/);
      expect(issued.headers["cache-control"]).toBe("no-store");

      const client = api.withToken(token.access_token);
      expect((yield* client.get("/v1/me")).body).toEqual({ userId: ada.userId, username: "ada" });
      expect((yield* client.get("/v1/aliases")).status).toBe(200);
      expect((yield* client.get("/v1/recipients")).status).toBe(403);
      expect((yield* ada.browser.get("/v1/tokens")).body).toMatchObject([
        { name: "Alias CLI (device login)", scopes: ["aliases:read", "aliases:write"] },
      ]);

      // The device code is spent.
      yield* TestClock.adjust("5 seconds");
      expect(error((yield* poll()).body)).toBe("invalid_grant");
      // And the code no longer finds anything to approve.
      expect((yield* ada.browser.post("/v1/device/lookup", { userCode: typed })).status).toBe(404);
    }),
  );

  it.effect(
    "answers slow_down to a device that polls too fast, and access_denied after a denial",
    () =>
      Effect.gen(function* () {
        const { ada, authorization, poll } = yield* started();
        expect(error((yield* poll()).body)).toBe("authorization_pending");
        expect(error((yield* poll()).body)).toBe("slow_down");
        // The interval is 10 seconds now.
        yield* TestClock.adjust("6 seconds");
        expect(error((yield* poll()).body)).toBe("slow_down");
        yield* TestClock.adjust("15 seconds");
        expect(error((yield* poll()).body)).toBe("authorization_pending");

        yield* ada.browser.post("/v1/device/deny", { userCode: authorization.user_code });
        yield* TestClock.adjust("15 seconds");
        expect(error((yield* poll()).body)).toBe("access_denied");
        yield* TestClock.adjust("15 seconds");
        expect(error((yield* poll()).body)).toBe("invalid_grant");
      }),
  );

  it.effect("expires codes after 10 minutes", () =>
    Effect.gen(function* () {
      const { ada, authorization, poll } = yield* started();
      yield* TestClock.adjust("10 minutes");
      expect(error((yield* poll()).body)).toBe("expired_token");
      const late = yield* ada.browser.post("/v1/device/approve", {
        userCode: authorization.user_code,
      });
      expect(late.status).toBe(404);
    }),
  );

  it.effect("refuses unknown clients, scopes and grant types the OAuth way", () =>
    Effect.gen(function* () {
      const { device, authorization } = yield* started();
      const ask = (fields: Record<string, string>) =>
        Effect.map(device.postForm("/v1/oauth/device_authorization", fields), (r) => [
          r.status,
          error(r.body),
        ]);
      expect(yield* ask({ client_id: "evil", scope: CLI_SCOPES })).toEqual([400, "invalid_client"]);
      expect(yield* ask({ client_id: "alias-cli", scope: "aliases:read admin" })).toEqual([
        400,
        "invalid_scope",
      ]);
      expect(yield* ask({ client_id: "alias-cli", scope: " " })).toEqual([400, "invalid_scope"]);

      const poll = (fields: Record<string, string>) =>
        Effect.map(device.postForm("/v1/oauth/token", fields), (r) => error(r.body));
      const code = authorization.device_code;
      expect(
        yield* poll({ grant_type: "password", device_code: code, client_id: "alias-cli" }),
      ).toBe("unsupported_grant_type");
      expect(yield* poll({ grant_type: GRANT, device_code: code, client_id: "evil" })).toBe(
        "invalid_client",
      );
      expect(yield* poll({ grant_type: GRANT, device_code: "guess", client_id: "alias-cli" })).toBe(
        "invalid_grant",
      );
    }),
  );

  it.effect("rate-limits device codes per address, and guessed device codes like tokens", () =>
    Effect.gen(function* () {
      const { api } = yield* started();
      const other = Browser.make(api.handle, { sourceIp: "198.51.100.20" });
      const ask = () =>
        Effect.map(
          other.postForm("/v1/oauth/device_authorization", {
            client_id: "alias-cli",
            scope: CLI_SCOPES,
          }),
          (r) => r.status,
        );
      const statuses = yield* Effect.forEach(Arr.range(1, MAX_DEVICE_REQUESTS_PER_HOUR + 1), ask, {
        concurrency: 1,
      });
      expect(Arr.filter(statuses, (status) => status === 200)).toHaveLength(
        MAX_DEVICE_REQUESTS_PER_HOUR,
      );
      expect(statuses.at(-1)).toBe(429);

      const guess = () =>
        Effect.map(
          other.postForm("/v1/oauth/token", {
            grant_type: GRANT,
            device_code: "x",
            client_id: "alias-cli",
          }),
          (r) => r.status,
        );
      const guesses = yield* Effect.forEach(Arr.range(1, MAX_FAILURES_PER_HOUR + 1), guess, {
        concurrency: 1,
      });
      expect(guesses.at(-1)).toBe(429);
    }),
  );

  it.effect("limits wrong user codes per user, and keeps approval session-only", () =>
    Effect.gen(function* () {
      const { api, ada, authorization } = yield* started();
      const created = yield* ada.browser.post("/v1/tokens", {
        name: "laptop",
        scopes: ["aliases:read"],
      });
      const { token } = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(
        created.body,
      );
      const refused = yield* api
        .withToken(token)
        .post("/v1/device/approve", { userCode: authorization.user_code });
      expect(refused.status).toBe(403);

      const misses = yield* Effect.forEach(
        Arr.range(1, MAX_CODE_MISSES_PER_HOUR),
        () =>
          Effect.map(
            ada.browser.post("/v1/device/lookup", { userCode: "ZZZZ-ZZZZ" }),
            (r) => r.status,
          ),
        { concurrency: 1 },
      );
      expect(Arr.dedupe(misses)).toEqual([404]);
      // Now even the right code is refused for the rest of the hour.
      const blocked = yield* ada.browser.post("/v1/device/lookup", {
        userCode: authorization.user_code,
      });
      expect(blocked.status).toBe(429);
      yield* TestClock.adjust("1 hour");
      // The code expired meanwhile.
      expect(
        (yield* ada.browser.post("/v1/device/lookup", { userCode: authorization.user_code }))
          .status,
      ).toBe(404);
    }),
  );

  it.effect("revokes a token for its holder (RFC 7009), always answering 200", () =>
    Effect.gen(function* () {
      const { api, ada, device } = yield* started();
      const created = yield* ada.browser.post("/v1/tokens", {
        name: "cli",
        scopes: ["aliases:read"],
      });
      const { token } = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(
        created.body,
      );
      expect((yield* api.withToken(token).get("/v1/me")).status).toBe(200);
      expect((yield* device.postForm("/v1/oauth/revoke", { token })).status).toBe(200);
      expect((yield* api.withToken(token).get("/v1/me")).status).toBe(401);
      expect((yield* device.postForm("/v1/oauth/revoke", { token })).status).toBe(200);
      expect((yield* device.postForm("/v1/oauth/revoke", { token: "nonsense" })).status).toBe(200);
    }),
  );
});
