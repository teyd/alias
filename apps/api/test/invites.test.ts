import { InviteRepo } from "@alias/db";
import { TestKeys } from "@alias/turnstile-emulator";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Invites } from "../src/index.ts";
import * as Browser from "./support/Browser.ts";
import { TestAuthenticator } from "./support/index.ts";
import * as TestApi from "./support/TestApi.ts";

const { RegistrationChallenge, human } = TestApi;

type Api = Effect.Success<typeof TestApi.make>;

/** Mints codes the way `bin/invites.ts` does, into the API's table, on the test's clock. */
const mint = (api: Api, options: { readonly maxUses?: number; readonly days?: number } = {}) =>
  Invites.mint({
    count: 1,
    maxUses: options.maxUses ?? 1,
    validFor: Duration.days(options.days ?? 14),
    note: Option.some("test"),
  }).pipe(
    Effect.map(([code]) => code ?? ""),
    Effect.provide(Layer.merge(InviteRepo.layer, NodeCrypto.layer)),
    Effect.provide(api.context),
  );

const options = (browser: Browser.Client, username: string, inviteCode?: string) =>
  browser.post(
    "/v1/auth/register/options",
    Option.match(Option.fromUndefinedOr(inviteCode), {
      onNone: () => ({ ...human, username }),
      onSome: (code) => ({ ...human, username, inviteCode: code }),
    }),
  );

/** Answers a registration challenge with a new passkey. */
const register = (browser: Browser.Client, started: { readonly body: unknown }) => {
  const { challengeId, options: creation } = Schema.decodeUnknownSync(RegistrationChallenge)(
    started.body,
  );
  return browser.post("/v1/auth/register", {
    challengeId,
    credential: TestAuthenticator.make(Browser.origin).create(creation),
  });
};

const signUp = Effect.fn("signUp")(function* (
  browser: Browser.Client,
  username: string,
  inviteCode?: string,
) {
  const started = yield* options(browser, username, inviteCode);
  return started.status === 200 ? yield* register(browser, started) : started;
});

const invite = TestApi.makeWith({ signupMode: "invite" });

describe("invite codes for the private beta (PLAN.md §20.36)", () => {
  it.effect("tells the sign-up form whether to ask for an invite code", () =>
    Effect.gen(function* () {
      expect(yield* (yield* invite).browser().get("/v1/auth/signup")).toMatchObject({
        status: 200,
        body: { isInviteRequired: true },
      });
      expect(yield* (yield* TestApi.make).browser().get("/v1/auth/signup")).toMatchObject({
        status: 200,
        body: { isInviteRequired: false },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("signs up with a minted code, written in any case and spacing, once", () =>
    Effect.gen(function* () {
      const api = yield* invite;
      const code = yield* mint(api);
      expect(code).toMatch(/^[B-Z]{4}(-[B-Z]{4}){4}$/);

      const typed = ` ${code.toLowerCase().replaceAll("-", " ")} `;
      expect(yield* signUp(api.browser(), "ada", typed)).toMatchObject({
        status: 200,
        body: { username: "ada" },
      });
      expect(yield* signUp(api.browser("203.0.113.2"), "grace", code)).toMatchObject({
        status: 403,
        body: { _tag: "InviteRejected", reason: "invalid" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a sign-up without a code, or with one that redeems nothing", () =>
    Effect.gen(function* () {
      const api = yield* invite;
      const browser = api.browser();
      const missing = yield* Effect.forEach(
        [undefined, "", "   "],
        (code) => options(browser, "ada", code),
        { concurrency: 1 },
      );
      expect(missing).toMatchObject(
        Array.from({ length: 3 }, () => ({
          status: 403,
          body: { _tag: "InviteRejected", reason: "missing" },
        })),
      );
      const wrong = yield* Effect.forEach(
        ["not-a-code", "BCDF-GHJK-LMNP-QRST-VWXZ"],
        (code) => options(browser, "ada", code),
        { concurrency: 1 },
      );
      expect(wrong).toMatchObject(
        Array.from({ length: 2 }, () => ({
          status: 403,
          body: { _tag: "InviteRejected", reason: "invalid" },
        })),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("checks the username, then the code, before redeeming the Turnstile token", () =>
    Effect.gen(function* () {
      // With the spent secret every redeemed token fails, so another error proves no redeem.
      const api = yield* TestApi.makeWith({
        signupMode: "invite",
        turnstileSecret: TestKeys.secrets.spent,
      });
      const code = yield* mint(api);
      expect(yield* options(api.browser(), "admin", code)).toMatchObject({
        status: 400,
        body: { _tag: "InvalidUsername" },
      });
      expect(yield* options(api.browser(), "ada", "BCDF-GHJK-LMNP-QRST-VWXZ")).toMatchObject({
        status: 403,
        body: { _tag: "InviteRejected" },
      });
      expect(yield* options(api.browser(), "ada", code)).toMatchObject({
        status: 400,
        body: { _tag: "HumanCheckFailed" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("counts codes that redeem nothing per client address and hour", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({
        signupMode: "invite",
        limits: { inviteMissesPerHour: 2 },
      });
      const code = yield* mint(api);
      const browser = api.browser("203.0.113.1");
      // A missing code is no guess and isn't counted.
      expect((yield* options(browser, "ada")).status).toBe(403);
      expect((yield* options(browser, "ada", "BCDF-GHJK-LMNP-QRST-VWXZ")).status).toBe(403);
      expect((yield* options(browser, "ada", "BCDF-GHJK-LMNP-QRST-VWXB")).status).toBe(403);
      // Past the limit even a good code is refused unread.
      expect(yield* options(browser, "ada", code)).toMatchObject({
        status: 429,
        body: { _tag: "TooManyAttempts" },
      });
      expect((yield* options(api.browser("203.0.113.2"), "ada", code)).status).toBe(200);
      yield* TestClock.adjust("1 hour");
      expect((yield* options(browser, "ada", code)).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("redeems a code when the account is created, so a race for its last use loses", () =>
    Effect.gen(function* () {
      const api = yield* invite;
      const code = yield* mint(api);
      const first = api.browser("203.0.113.1");
      const second = api.browser("203.0.113.2");
      // Both pass the check: the code isn't redeemed by a challenge.
      const ada = yield* options(first, "ada", code);
      const grace = yield* options(second, "grace", code);
      expect([ada.status, grace.status]).toEqual([200, 200]);

      expect((yield* register(first, ada)).status).toBe(200);
      expect(yield* register(second, grace)).toMatchObject({
        status: 403,
        body: { _tag: "InviteRejected", reason: "invalid" },
      });
      // Nothing of the losing sign-up was kept: the username is still free.
      const fresh = yield* mint(api);
      expect((yield* signUp(api.browser("203.0.113.3"), "grace", fresh)).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a code with several uses sign up that many accounts", () =>
    Effect.gen(function* () {
      const api = yield* invite;
      const code = yield* mint(api, { maxUses: 2 });
      expect((yield* signUp(api.browser("203.0.113.1"), "ada", code)).status).toBe(200);
      expect((yield* signUp(api.browser("203.0.113.2"), "grace", code)).status).toBe(200);
      expect((yield* signUp(api.browser("203.0.113.3"), "linus", code)).status).toBe(403);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses expired and revoked codes", () =>
    Effect.gen(function* () {
      const api = yield* invite;
      const expiring = yield* mint(api, { days: 1 });
      const revoked = yield* mint(api);
      const isRevoked = yield* Invites.revoke(revoked).pipe(
        Effect.provide(Layer.merge(InviteRepo.layer, NodeCrypto.layer)),
        Effect.provide(api.context),
      );
      expect(isRevoked).toBe(true);
      expect(yield* options(api.browser(), "ada", revoked)).toMatchObject({
        status: 403,
        body: { _tag: "InviteRejected", reason: "invalid" },
      });
      yield* TestClock.adjust("2 days");
      expect(yield* options(api.browser(), "ada", expiring)).toMatchObject({
        status: 403,
        body: { _tag: "InviteRejected", reason: "invalid" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("ignores codes while sign-up is open", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      expect((yield* signUp(api.browser(), "ada", "not-a-code")).status).toBe(200);
    }).pipe(Effect.scoped),
  );
});
