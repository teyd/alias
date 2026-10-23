import { TestKeys } from "@alias/turnstile-emulator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Browser from "./support/Browser.ts";
import { TestAuthenticator } from "./support/index.ts";
import * as TestApi from "./support/TestApi.ts";

const { AuthenticationChallenge, human, logIn, signUp } = TestApi;

const HOUR = "1 hour";

/** A fresh browser and passkey from `sourceIp` signing up `username`. */
const signUpFrom = (api: Effect.Success<typeof TestApi.make>, sourceIp: string, username: string) =>
  signUp(api.browser(sourceIp), TestAuthenticator.make(Browser.origin), username);

describe("sign-up and login abuse protection (PLAN.md §20.27)", () => {
  it.effect("names the Turnstile widget the sign-up form renders", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const response = yield* api.browser().get("/v1/auth/signup");
      expect(response).toMatchObject({
        status: 200,
        body: { turnstile: { siteKey: TestKeys.siteKeys.passes } },
      });
      const { scriptUrl } = Schema.decodeUnknownSync(
        Schema.Struct({ turnstile: Schema.Struct({ scriptUrl: Schema.String }) }),
      )(response.body).turnstile;
      expect(scriptUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/turnstile\/v0\/api\.js\?render=explicit$/,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("issues a registration challenge only for a solved widget", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const options = (body: Schema.Json) => api.browser().post("/v1/auth/register/options", body);

      expect(yield* options({ username: "ada", turnstileToken: "" })).toMatchObject({
        status: 400,
        body: { _tag: "HumanCheckFailed" },
      });
      // Without a token at all the request doesn't match the endpoint's schema.
      expect((yield* options({ username: "ada" })).status).toBe(400);
      expect((yield* options({ ...human, username: "ada" })).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses tokens Turnstile rejects or calls redeemed before", () =>
    Effect.gen(function* () {
      const failing = yield* TestApi.makeWith({ turnstileSecret: TestKeys.secrets.fails });
      expect(
        yield* failing.browser().post("/v1/auth/register/options", { ...human, username: "ada" }),
      ).toMatchObject({ status: 400, body: { _tag: "HumanCheckFailed" } });

      const spent = yield* TestApi.makeWith({ turnstileSecret: TestKeys.secrets.spent });
      expect(
        yield* spent.browser().post("/v1/auth/register/options", { ...human, username: "ada" }),
      ).toMatchObject({ status: 400, body: { _tag: "HumanCheckFailed" } });
    }).pipe(Effect.scoped),
  );

  it.effect("fails closed when Turnstile can't vouch for anyone (a wrong secret)", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({
        turnstileSecret: "0x4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
      expect(
        yield* api.browser().post("/v1/auth/register/options", { ...human, username: "ada" }),
      ).toMatchObject({
        status: 503,
        body: { _tag: "SignupUnavailable", reason: "human-check-unavailable" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("checks the username before redeeming the token", () =>
    Effect.gen(function* () {
      // With the spent secret every redeemed token fails, so a username error proves no redeem.
      const api = yield* TestApi.makeWith({ turnstileSecret: TestKeys.secrets.spent });
      expect(
        yield* api.browser().post("/v1/auth/register/options", { ...human, username: "admin" }),
      ).toMatchObject({ status: 400, body: { _tag: "InvalidUsername", reason: "reserved" } });
    }).pipe(Effect.scoped),
  );

  it.effect("limits sign-up and login challenges per client address and hour", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({ limits: { challengesPerHour: 3 } });
      const browser = api.browser("203.0.113.1");
      const login = () => browser.post("/v1/auth/login/options");
      const register = () =>
        browser.post("/v1/auth/register/options", { ...human, username: "ada" });

      expect((yield* login()).status).toBe(200);
      expect((yield* register()).status).toBe(200);
      expect((yield* login()).status).toBe(200);
      expect(yield* login()).toMatchObject({ status: 429, body: { _tag: "TooManyAttempts" } });
      expect(yield* register()).toMatchObject({ status: 429, body: { _tag: "TooManyAttempts" } });
      // Another address has its own budget; the next hour brings a new one.
      expect((yield* api.browser("203.0.113.2").post("/v1/auth/login/options")).status).toBe(200);
      yield* TestClock.adjust(HOUR);
      expect((yield* login()).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("serves sign-up and login only to the web app's own origin", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({ limits: { challengesPerHour: 1 } });
      const elsewhere = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
      const refused = yield* Effect.forEach(
        elsewhere,
        (headers) =>
          Effect.all(
            [
              Browser.make(api.handle, { headers, sourceIp: "203.0.113.1" }).post(
                "/v1/auth/login/options",
              ),
              Browser.make(api.handle, { headers, sourceIp: "203.0.113.1" }).post(
                "/v1/auth/register/options",
                { ...human, username: "ada" },
              ),
            ],
            { concurrency: 1 },
          ),
        { concurrency: 1 },
      );
      expect(refused.flat()).toMatchObject(
        Array.from({ length: 4 }, () => ({ status: 403, body: { _tag: "CrossSiteRequest" } })),
      );
      // Refused before counting: the address's one challenge is still there.
      expect((yield* api.browser("203.0.113.1").post("/v1/auth/login/options")).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("limits accounts per client address and day", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({ limits: { signupsPerDay: 2 } });
      expect((yield* signUpFrom(api, "203.0.113.1", "ada")).status).toBe(200);
      expect((yield* signUpFrom(api, "203.0.113.1", "grace")).status).toBe(200);
      expect(yield* signUpFrom(api, "203.0.113.1", "linus")).toMatchObject({
        status: 429,
        body: { _tag: "TooManyAttempts" },
      });
      expect((yield* signUpFrom(api, "203.0.113.2", "linus")).status).toBe(200);
      yield* TestClock.adjust("1 day");
      expect((yield* signUpFrom(api, "203.0.113.1", "edsger")).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("pauses every sign-up for the hour once the circuit breaker trips", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({ limits: { signupsPerHour: 2 } });
      const ada = TestAuthenticator.make(Browser.origin);
      expect((yield* signUp(api.browser("203.0.113.1"), ada, "ada")).status).toBe(200);
      expect((yield* signUpFrom(api, "203.0.113.2", "grace")).status).toBe(200);
      expect(yield* signUpFrom(api, "203.0.113.3", "linus")).toMatchObject({
        status: 503,
        body: { _tag: "SignupUnavailable", reason: "paused" },
      });
      // Existing users still log in.
      expect((yield* logIn(api.browser("203.0.113.1"), ada)).status).toBe(200);
      yield* TestClock.adjust(HOUR);
      expect((yield* signUpFrom(api, "203.0.113.3", "linus")).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("locks an account's logins for the hour after too many failed assertions", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({ limits: { loginFailuresPerHour: 2 } });
      const browser = api.browser();
      const authenticator = TestAuthenticator.make(Browser.origin);
      expect((yield* signUp(browser, authenticator, "ada")).status).toBe(200);

      /** An assertion signed for one challenge, sent as the answer to another. */
      const mismatch = Effect.fn("mismatch")(function* () {
        const signed = yield* browser.post("/v1/auth/login/options");
        const other = yield* browser.post("/v1/auth/login/options");
        const { options } = Schema.decodeUnknownSync(AuthenticationChallenge)(signed.body);
        const { challengeId } = Schema.decodeUnknownSync(AuthenticationChallenge)(other.body);
        return yield* browser.post("/v1/auth/login", {
          challengeId,
          credential: authenticator.get(options),
        });
      });
      expect(yield* mismatch()).toMatchObject({
        status: 400,
        body: { _tag: "PasskeyRejected", reason: "verification-failed" },
      });
      expect((yield* mismatch()).status).toBe(400);
      // Now even a valid assertion waits.
      expect(yield* logIn(browser, authenticator)).toMatchObject({
        status: 429,
        body: { _tag: "TooManyAttempts" },
      });
      // Other accounts are unaffected.
      const grace = TestAuthenticator.make(Browser.origin);
      expect((yield* signUp(api.browser("203.0.113.9"), grace, "grace")).status).toBe(200);
      expect((yield* logIn(api.browser("203.0.113.9"), grace)).status).toBe(200);
      yield* TestClock.adjust(HOUR);
      expect((yield* logIn(browser, authenticator)).status).toBe(200);
    }).pipe(Effect.scoped),
  );
});
