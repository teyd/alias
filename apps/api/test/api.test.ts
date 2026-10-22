import { AliasRepo } from "@alias/db";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Browser from "./support/Browser.ts";
import { TestAuthenticator } from "./support/index.ts";
import * as TestApi from "./support/TestApi.ts";

const { RegistrationChallenge, signUp } = TestApi;

const SESSION = "__Host-alias_session";

/** The API Lambda on a fresh table in its own fakecloud, plus a way to seed aliases. */
const api = Effect.map(TestApi.make, (handler) => ({
  ...handler,
  seedAlias: (alias: AliasRepo.NewAlias) =>
    AliasRepo.make().pipe(
      Effect.flatMap((repo) => repo.insert(alias)),
      Effect.provide(handler.context),
    ),
}));

const AuthenticationChallenge = Schema.Struct({
  challengeId: Schema.String,
  options: Schema.Struct({ challenge: Schema.String, rpId: Schema.optionalKey(Schema.String) }),
});

const Me = Schema.Struct({ userId: Schema.String, username: Schema.String });

const logIn = Effect.fn("logIn")(function* (
  browser: Browser.Client,
  authenticator: TestAuthenticator.TestAuthenticator,
) {
  const started = yield* browser.post("/v1/auth/login/options");
  const { challengeId, options } = Schema.decodeUnknownSync(AuthenticationChallenge)(started.body);
  return yield* browser.post("/v1/auth/login", {
    challengeId,
    credential: authenticator.get(options),
  });
});

describe("api as a Lambda function URL handler (fakecloud DynamoDB)", () => {
  it.effect("serves health", () =>
    Effect.gen(function* () {
      const { browser } = yield* api;
      expect(yield* browser().get("/health")).toMatchObject({
        status: 200,
        body: { status: "ok" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("walks register → login → /v1/me → logout with a passkey", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const authenticator = TestAuthenticator.make(Browser.origin);

      // Sign up on one device: the response sets the session cookie.
      const signUpBrowser = open();
      const registered = yield* signUp(signUpBrowser, authenticator, "Ada");
      expect(registered.status).toBe(200);
      const me = Schema.decodeUnknownSync(Me)(registered.body);
      expect(me.username).toBe("ada");
      expect(me.userId).toMatch(/^usr_[0-9a-z]{26}$/);
      expect(registered.setCookies).toHaveLength(1);
      const cookie = registered.setCookies[0] ?? "";
      expect(cookie).toMatch(new RegExp(`^${SESSION}=[A-Za-z0-9_-]{43};`));
      expect(cookie).toContain("Max-Age=2592000");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");

      // Log in from a fresh browser with the same passkey.
      const browser = open();
      expect((yield* browser.get("/v1/me")).status).toBe(401);
      const loggedIn = yield* logIn(browser, authenticator);
      expect(loggedIn).toMatchObject({ status: 200, body: me });
      expect(yield* browser.get("/v1/me")).toMatchObject({ status: 200, body: me });

      // Logging out ends the session server-side, not just in this browser.
      const token = Option.getOrElse(browser.cookie(SESSION), () => "");
      expect(token).not.toBe("");
      const loggedOut = yield* browser.post("/v1/auth/logout");
      expect(loggedOut.status).toBe(204);
      expect(loggedOut.setCookies[0]).toMatch(new RegExp(`^${SESSION}=;.*Max-Age=0`));
      expect(yield* browser.get("/v1/me")).toMatchObject({
        status: 401,
        body: { _tag: "Unauthenticated" },
      });
      browser.setCookie(SESSION, token);
      expect((yield* browser.get("/v1/me")).status).toBe(401);

      // The other device's session is untouched, and logging out twice is harmless.
      expect((yield* signUpBrowser.get("/v1/me")).status).toBe(200);
      expect((yield* browser.post("/v1/auth/logout")).status).toBe(204);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects requests without a valid session cookie", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const browser = open();
      expect(yield* browser.get("/v1/me")).toMatchObject({
        status: 401,
        body: { _tag: "Unauthenticated" },
      });
      browser.setCookie(SESSION, "made-up-token");
      expect((yield* browser.get("/v1/me")).status).toBe(401);
      expect((yield* browser.get("/v1/aliases/alias.test/shop")).status).toBe(401);
    }).pipe(Effect.scoped),
  );

  it.effect("looks up the caller's own aliases only", () =>
    Effect.gen(function* () {
      const { browser: open, seedAlias } = yield* api;
      const browser = open();
      const registered = yield* signUp(browser, TestAuthenticator.make(Browser.origin), "grace");
      const { userId } = Schema.decodeUnknownSync(Me)(registered.body);
      const alias = { domain: "alias.test", mode: "forward", createdAt: 0 } as const;
      yield* seedAlias({ ...alias, id: "al_mine", userId, localPart: "shop" });
      yield* seedAlias({ ...alias, id: "al_theirs", userId: "usr_other", localPart: "bank" });

      expect(yield* browser.get("/v1/aliases/alias.test/shop")).toMatchObject({
        status: 200,
        body: { id: "al_mine", address: "shop@alias.test", mode: "forward", isActive: true },
      });
      // Someone else's alias looks exactly like a missing one.
      const others = yield* Effect.forEach(
        ["bank", "nobody"],
        (local) => browser.get(`/v1/aliases/alias.test/${local}`),
        { concurrency: 1 },
      );
      expect(others).toMatchObject([
        { status: 404, body: { _tag: "AliasNotFound" } },
        { status: 404, body: { _tag: "AliasNotFound" } },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects invalid, reserved and taken usernames", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const browser = open();
      const options = (username: string) => browser.post("/v1/auth/register/options", { username });

      expect(yield* options("admin")).toMatchObject({
        status: 400,
        body: { _tag: "InvalidUsername", reason: "reserved" },
      });
      expect(yield* options("a.b")).toMatchObject({
        status: 400,
        body: { _tag: "InvalidUsername", reason: "invalid-characters" },
      });
      expect((yield* signUp(browser, TestAuthenticator.make(Browser.origin), "john")).status).toBe(
        200,
      );
      expect(yield* options("j0hn")).toMatchObject({
        status: 409,
        body: { _tag: "UsernameTaken", username: "j0hn" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects two sign-ups racing for one username at the final step", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const [first, second] = [open(), open()];
      const start = (browser: Browser.Client) =>
        browser
          .post("/v1/auth/register/options", { username: "linus" })
          .pipe(
            Effect.map((response) =>
              Schema.decodeUnknownSync(RegistrationChallenge)(response.body),
            ),
          );
      const a = yield* start(first);
      const b = yield* start(second);
      const finish = (browser: Browser.Client, started: TestApi.RegistrationChallenge) =>
        browser.post("/v1/auth/register", {
          challengeId: started.challengeId,
          credential: TestAuthenticator.make(Browser.origin).create(started.options),
        });

      expect((yield* finish(first, a)).status).toBe(200);
      expect(yield* finish(second, b)).toMatchObject({
        status: 409,
        body: { _tag: "UsernameTaken" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("accepts each challenge once, and only for its own ceremony", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const browser = open();
      const authenticator = TestAuthenticator.make(Browser.origin);
      const started = yield* browser.post("/v1/auth/register/options", { username: "edsger" });
      const { challengeId, options } = Schema.decodeUnknownSync(RegistrationChallenge)(
        started.body,
      );
      const credential = authenticator.create(options);
      expect((yield* browser.post("/v1/auth/register", { challengeId, credential })).status).toBe(
        200,
      );
      expect(yield* browser.post("/v1/auth/register", { challengeId, credential })).toMatchObject({
        status: 400,
        body: { _tag: "PasskeyRejected", reason: "challenge-expired" },
      });

      // A login answer sent against a registration challenge is refused.
      const registration = yield* browser.post("/v1/auth/register/options", {
        username: "barbara",
      });
      const wrongCeremony = Schema.decodeUnknownSync(RegistrationChallenge)(registration.body);
      const login = yield* browser.post("/v1/auth/login/options");
      const { options: loginOptions } = Schema.decodeUnknownSync(AuthenticationChallenge)(
        login.body,
      );
      expect(
        yield* browser.post("/v1/auth/login", {
          challengeId: wrongCeremony.challengeId,
          credential: authenticator.get(loginOptions),
        }),
      ).toMatchObject({ status: 400, body: { reason: "challenge-expired" } });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects passkeys it doesn't know and answers from another origin", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const browser = open();

      // A passkey made for this site but never registered here.
      const stranger = TestAuthenticator.make(Browser.origin);
      stranger.create({ challenge: "x", rp: { id: "alias.test" }, user: { id: "dXNyX3g" } });
      expect(yield* logIn(browser, stranger)).toMatchObject({
        status: 400,
        body: { _tag: "PasskeyRejected", reason: "unknown-credential" },
      });

      // A phishing page on another origin relaying our challenge.
      const phished = TestAuthenticator.make("https://alias-login.example");
      const started = yield* browser.post("/v1/auth/register/options", { username: "mallory" });
      const { challengeId, options } = Schema.decodeUnknownSync(RegistrationChallenge)(
        started.body,
      );
      expect(
        yield* browser.post("/v1/auth/register", {
          challengeId,
          credential: phished.create(options),
        }),
      ).toMatchObject({ status: 400, body: { reason: "verification-failed" } });
      expect(browser.cookie(SESSION)).toEqual(Option.none());
    }).pipe(Effect.scoped),
  );
});
