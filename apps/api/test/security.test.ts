import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Browser from "./support/Browser.ts";
import { TestAuthenticator } from "./support/index.ts";
import * as TestApi from "./support/TestApi.ts";

const Sessions = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    createdAt: Schema.String,
    expiresAt: Schema.String,
    isCurrent: Schema.Boolean,
  }),
);
const Passkeys = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    createdAt: Schema.String,
    lastUsedAt: Schema.optionalKey(Schema.String),
    transports: Schema.Array(Schema.String),
  }),
);
const Created = Schema.Struct({ token: Schema.String });

// SR-25 (PLAN.md §20.25): a stolen cookie worked for 30 days with nothing to end it but logout.
describe("sessions and passkeys (API handler on fakecloud)", () => {
  it.effect("lists the account's sessions and ends the others", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const authenticator = TestAuthenticator.make(Browser.origin);
      const laptop = api.browser();
      expect((yield* TestApi.signUp(laptop, authenticator, "ada")).status).toBe(200);
      const phone = api.browser();
      expect((yield* TestApi.logIn(phone, authenticator)).status).toBe(200);
      const tablet = api.browser();
      expect((yield* TestApi.logIn(tablet, authenticator)).status).toBe(200);

      const listed = Schema.decodeUnknownSync(Sessions)((yield* laptop.get("/v1/sessions")).body);
      expect(listed).toHaveLength(3);
      expect(listed.filter((session) => session.isCurrent)).toHaveLength(1);
      const others = listed.filter((session) => !session.isCurrent);

      // One by one…
      const [first] = others;
      expect((yield* laptop.delete(`/v1/sessions/${first?.id}`)).status).toBe(204);
      const phoneOrTablet = [
        (yield* phone.get("/v1/me")).status,
        (yield* tablet.get("/v1/me")).status,
      ];
      expect(phoneOrTablet.toSorted((a, b) => a - b)).toEqual([200, 401]);
      // …or every other one at once; this one stays.
      expect((yield* laptop.delete("/v1/sessions")).body).toEqual({ ended: 1 });
      expect((yield* phone.get("/v1/me")).status).toBe(401);
      expect((yield* tablet.get("/v1/me")).status).toBe(401);
      expect((yield* laptop.get("/v1/me")).status).toBe(200);
      expect((yield* laptop.get("/v1/sessions")).body).toMatchObject([{ isCurrent: true }]);
    }),
  );

  it.effect("ends only the caller's own sessions", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const grace = yield* TestApi.signedIn(api.browser, "grace");
      const [graceSession] = Schema.decodeUnknownSync(Sessions)(
        (yield* grace.browser.get("/v1/sessions")).body,
      );
      expect(yield* ada.browser.delete(`/v1/sessions/${graceSession?.id}`)).toMatchObject({
        status: 404,
        body: { _tag: "SessionNotFound" },
      });
      expect((yield* ada.browser.delete("/v1/sessions")).body).toEqual({ ended: 0 });
      expect((yield* grace.browser.get("/v1/me")).status).toBe(200);
    }),
  );

  it.effect("lists the account's passkeys with their last use", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const authenticator = TestAuthenticator.make(Browser.origin);
      const browser = api.browser();
      yield* TestApi.signUp(browser, authenticator, "ada");
      const [fresh] = Schema.decodeUnknownSync(Passkeys)((yield* browser.get("/v1/passkeys")).body);
      expect(fresh).toMatchObject({ transports: ["internal"] });
      expect(fresh?.lastUsedAt).toBeUndefined();
      yield* TestApi.logIn(api.browser(), authenticator);
      const [used] = Schema.decodeUnknownSync(Passkeys)((yield* browser.get("/v1/passkeys")).body);
      expect(used?.id).toBe(fresh?.id);
      expect(used?.lastUsedAt).toEqual(expect.any(String));
    }),
  );

  it.effect("keeps sessions and passkeys away from tokens", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const { token } = Schema.decodeUnknownSync(Created)(
        (yield* ada.browser.post("/v1/tokens", {
          name: "script",
          scopes: ["aliases:read", "settings:write"],
        })).body,
      );
      const client = api.withToken(token);
      expect((yield* client.get("/v1/sessions")).status).toBe(403);
      expect((yield* client.delete("/v1/sessions")).status).toBe(403);
      expect((yield* client.get("/v1/passkeys")).status).toBe(403);
    }),
  );
});
