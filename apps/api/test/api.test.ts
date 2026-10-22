import { AliasRepo } from "@alias/db";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
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
  findAlias: (domain: string, localPart: string) =>
    AliasRepo.make().pipe(
      Effect.flatMap((repo) => repo.findByAddress(domain, localPart)),
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

/** A browser signed in as a freshly registered user. */
const signedIn = Effect.fn("signedIn")(function* (open: () => Browser.Client, username: string) {
  const browser = open();
  const registered = yield* signUp(browser, TestAuthenticator.make(Browser.origin), username);
  return { browser, ...Schema.decodeUnknownSync(Me)(registered.body) };
});

const random = (domain: string) => ({ _tag: "Random", domain, mode: "forward" });
const address = (value: string) => ({ _tag: "Address", address: value, mode: "inbox" });

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

  it.effect("creates random aliases on the shared domains only", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const { browser } = yield* signedIn(open, "ada");

      const first = yield* browser.post("/v1/aliases", random("alias.test"));
      expect(first).toMatchObject({ status: 201, body: { mode: "forward", isActive: true } });
      expect(first.body).toMatchObject({
        id: expect.stringMatching(/^al_[0-9a-z]{26}$/),
        address: expect.stringMatching(/^[2-9a-hjkmnp-z]{10}@alias\.test$/),
      });
      const second = yield* browser.post("/v1/aliases", random(" ALIAS2.test "));
      expect(second).toMatchObject({
        status: 201,
        body: { address: expect.stringMatching(/^[2-9a-hjkmnp-z]{10}@alias2\.test$/) },
      });

      const refused = yield* Effect.forEach(
        ["example.org", "ada.alias.test"],
        (domain) => browser.post("/v1/aliases", random(domain)),
        { concurrency: 1 },
      );
      expect(refused).toMatchObject([
        { status: 400, body: { _tag: "InvalidAlias", reason: "unknown-domain" } },
        { status: 400, body: { _tag: "InvalidAlias", reason: "unknown-domain" } },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("creates any address on the caller's own subdomain, and nowhere else", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const { browser } = yield* signedIn(open, "ada");
      yield* signedIn(open, "grace");

      expect(yield* browser.post("/v1/aliases", address(" Shop@ADA.alias2.test"))).toMatchObject({
        status: 201,
        body: { address: "shop@ada.alias2.test", mode: "inbox", isActive: true },
      });

      const cases = [
        ["not an address", "invalid-address"],
        ["shop@grace.alias.test", "not-your-subdomain"],
        ["shop@alias.test", "random-only-on-shared-domain"],
        ["me@example.org", "unknown-domain"],
        ["a@x.ada.alias.test", "unknown-domain"],
        ["shop+r.abc@ada.alias.test", "reserved-local-part"],
      ] as const;
      const responses = yield* Effect.forEach(
        cases,
        ([value]) => browser.post("/v1/aliases", address(value)),
        { concurrency: 1 },
      );
      expect(responses).toMatchObject(
        cases.map(([value, reason]) => ({
          status: 400,
          body: { _tag: "InvalidAlias", address: value, reason },
        })),
      );
      expect((yield* browser.post("/v1/aliases", { _tag: "Address", mode: "inbox" })).status).toBe(
        400,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("answers 409 when the address is taken, whatever its case", () =>
    Effect.gen(function* () {
      const { browser: open, seedAlias } = yield* api;
      const { browser } = yield* signedIn(open, "ada");
      expect((yield* browser.post("/v1/aliases", address("shop@ada.alias.test"))).status).toBe(201);
      expect(yield* browser.post("/v1/aliases", address("SHOP@ada.alias.test"))).toMatchObject({
        status: 409,
        body: { _tag: "AliasTaken", address: "shop@ada.alias.test" },
      });

      // Left over from a previous owner of the name, say: still nobody else's to take.
      yield* seedAlias({
        id: "al_old",
        userId: "usr_old",
        domain: "ada.alias.test",
        localPart: "bank",
        mode: "forward",
        createdAt: 0,
      });
      expect(yield* browser.post("/v1/aliases", address("bank@ada.alias.test"))).toMatchObject({
        status: 409,
        body: { _tag: "AliasTaken" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("lists the caller's aliases only, oldest first", () =>
    Effect.gen(function* () {
      const { browser: open, seedAlias } = yield* api;
      const ada = yield* signedIn(open, "ada");
      const grace = yield* signedIn(open, "grace");
      expect(yield* ada.browser.get("/v1/aliases")).toMatchObject({ status: 200, body: [] });

      const seed = (id: string, userId: string, localPart: string, createdAt: number) =>
        seedAlias({ id, userId, domain: "alias.test", localPart, mode: "both", createdAt });
      yield* seed("al_2", ada.userId, "second", 2);
      yield* seed("al_1", ada.userId, "first", 1);
      yield* seed("al_3", grace.userId, "theirs", 3);

      expect(yield* ada.browser.get("/v1/aliases")).toMatchObject({
        status: 200,
        body: [
          { id: "al_1", address: "first@alias.test", mode: "both", isActive: true },
          { id: "al_2", address: "second@alias.test", mode: "both", isActive: true },
        ],
      });
      expect(yield* grace.browser.get("/v1/aliases/domains")).toMatchObject({
        status: 200,
        body: {
          shared: ["alias.test", "alias2.test"],
          subdomains: ["grace.alias.test", "grace.alias2.test"],
        },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("updates and deletes the caller's own aliases, and 404s on anyone else's", () =>
    Effect.gen(function* () {
      const { browser: open, seedAlias, findAlias } = yield* api;
      const { browser, userId } = yield* signedIn(open, "ada");
      const alias = { domain: "alias.test", mode: "forward", createdAt: 0 } as const;
      yield* seedAlias({ ...alias, id: "al_mine", userId, localPart: "shop" });
      yield* seedAlias({ ...alias, id: "al_theirs", userId: "usr_other", localPart: "bank" });

      expect(
        yield* browser.patch("/v1/aliases/alias.test/SHOP", { isActive: false, mode: "both" }),
      ).toMatchObject({
        status: 200,
        body: { id: "al_mine", address: "shop@alias.test", mode: "both", isActive: false },
      });
      expect(yield* browser.patch("/v1/aliases/alias.test/shop", {})).toMatchObject({
        status: 200,
        body: { mode: "both", isActive: false },
      });
      expect((yield* browser.patch("/v1/aliases/alias.test/shop", { mode: "bogus" })).status).toBe(
        400,
      );

      // Someone else's alias looks exactly like a missing one, and stays as it was.
      const notFound = { status: 404, body: { _tag: "AliasNotFound" } };
      expect(
        yield* browser.patch("/v1/aliases/alias.test/bank", { isActive: false }),
      ).toMatchObject({ ...notFound, body: { ...notFound.body, address: "bank@alias.test" } });
      expect(yield* browser.patch("/v1/aliases/alias.test/nobody", {})).toMatchObject(notFound);
      expect(yield* browser.delete("/v1/aliases/alias.test/bank")).toMatchObject(notFound);
      expect(yield* findAlias("alias.test", "bank")).toEqual(
        Option.some(expect.objectContaining({ userId: "usr_other", isActive: true })),
      );

      expect((yield* browser.delete("/v1/aliases/alias.test/shop")).status).toBe(204);
      expect(yield* findAlias("alias.test", "shop")).toEqual(Option.none());
      expect(yield* browser.get("/v1/aliases/alias.test/shop")).toMatchObject(notFound);
      expect(yield* browser.delete("/v1/aliases/alias.test/shop")).toMatchObject(notFound);
      expect(yield* browser.get("/v1/aliases")).toMatchObject({ status: 200, body: [] });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps every alias endpoint behind the session", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const browser = open();
      const responses = yield* Effect.all(
        [
          browser.get("/v1/aliases"),
          browser.get("/v1/aliases/domains"),
          browser.post("/v1/aliases", random("alias.test")),
          browser.patch("/v1/aliases/alias.test/shop", { isActive: false }),
          browser.delete("/v1/aliases/alias.test/shop"),
        ],
        { concurrency: 1 },
      );
      expect(Arr.map(responses, (response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    }).pipe(Effect.scoped),
  );

  it.effect("turns on-the-fly aliases on and off per user, off by default", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const ada = yield* signedIn(open, "ada");
      const grace = yield* signedIn(open, "grace");
      const off = { status: 200, body: { isOnTheFlyEnabled: false } };
      const on = { status: 200, body: { isOnTheFlyEnabled: true } };

      expect(yield* ada.browser.get("/v1/settings")).toMatchObject(off);
      expect(yield* ada.browser.patch("/v1/settings", { isOnTheFlyEnabled: true })).toMatchObject(
        on,
      );
      expect(yield* ada.browser.patch("/v1/settings", {})).toMatchObject(on);
      expect(yield* ada.browser.get("/v1/settings")).toMatchObject(on);
      // Someone else's setting is their own.
      expect(yield* grace.browser.get("/v1/settings")).toMatchObject(off);
      expect((yield* ada.browser.patch("/v1/settings", { isOnTheFlyEnabled: "yes" })).status).toBe(
        400,
      );
      expect(yield* ada.browser.patch("/v1/settings", { isOnTheFlyEnabled: false })).toMatchObject(
        off,
      );

      const anonymous = open();
      expect((yield* anonymous.get("/v1/settings")).status).toBe(401);
      expect((yield* anonymous.patch("/v1/settings", { isOnTheFlyEnabled: true })).status).toBe(
        401,
      );
    }).pipe(Effect.scoped),
  );
});
