import { AliasRepo, ContactRepo } from "@alias/db";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Browser from "./support/Browser.ts";
import { TestAuthenticator } from "./support/index.ts";
import * as TestApi from "./support/TestApi.ts";

const { AuthenticationChallenge, logIn, signUp } = TestApi;

const Me = Schema.Struct({ userId: Schema.String, username: Schema.String });
const Created = Schema.Struct({ id: Schema.String, address: Schema.String });

/** The API Lambda on a fresh table in its own fakecloud, with direct access to its table. */
const api = Effect.map(TestApi.make, (handler) => {
  const withRepos = <A, E>(
    effect: Effect.Effect<A, E, AliasRepo.AliasRepo | ContactRepo.ContactRepo>,
  ) =>
    Layer.build(Layer.mergeAll(AliasRepo.layer, ContactRepo.layer)).pipe(
      Effect.flatMap((context) => Effect.provide(effect, context)),
      Effect.provide(handler.context),
    );
  return { ...handler, withRepos };
});

/** A browser signed in as a freshly registered user, and the passkey it registered. */
const signedIn = Effect.fn("signedIn")(function* (open: () => Browser.Client, username: string) {
  const browser = open();
  const authenticator = TestAuthenticator.make(Browser.origin);
  const registered = yield* signUp(browser, authenticator, username);
  return { browser, authenticator, ...Schema.decodeUnknownSync(Me)(registered.body) };
});

/** Both calls of an erasure: the challenge, then the authenticator's answer to it. */
const erase = Effect.fn("erase")(function* (
  browser: Browser.Client,
  authenticator: TestAuthenticator.TestAuthenticator,
) {
  const started = yield* browser.post("/v1/me/erase/options");
  const { challengeId, options } = Schema.decodeUnknownSync(AuthenticationChallenge)(started.body);
  return yield* browser.post("/v1/me/erase", {
    challengeId,
    credential: authenticator.get(options),
  });
});

const contact = (aliasId: string): ContactRepo.NewContact => ({
  id: "c1aaaaaaaaaaaaaa",
  aliasId,
  address: "orders@store.example",
  name: Option.some("Store"),
  createdAt: DateTime.makeUnsafe(1_000),
});

describe("data lifecycle over the API (fakecloud)", () => {
  it.effect("deletes an alias with its contacts, and lets only its owner create it again", () =>
    Effect.gen(function* () {
      const { browser: open, withRepos } = yield* api;
      const ada = yield* signedIn(open, "ada");
      const created = yield* ada.browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada.alias.test",
        mode: "forward",
      });
      const shop = Schema.decodeUnknownSync(Created)(created.body);
      const address = { domain: "ada.alias.test", localPart: "shop" };
      yield* withRepos(
        ContactRepo.ContactRepo.use((repo) => repo.create(contact(shop.id), address)),
      );
      expect(yield* ada.browser.get("/v1/aliases/ada.alias.test/shop/contacts")).toMatchObject({
        body: [{ id: "c1aaaaaaaaaaaaaa" }],
      });

      expect((yield* ada.browser.delete("/v1/aliases/ada.alias.test/shop")).status).toBe(204);
      expect(yield* withRepos(ContactRepo.ContactRepo.use((repo) => repo.list(shop.id)))).toEqual(
        [],
      );
      expect((yield* ada.browser.get("/v1/aliases/ada.alias.test/shop/contacts")).status).toBe(404);

      // Created again by its owner, it is a new alias: new id, no contacts.
      const again = yield* ada.browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada.alias.test",
        mode: "forward",
      });
      expect(again.status).toBe(201);
      expect(Schema.decodeUnknownSync(Created)(again.body).id).not.toBe(shop.id);
      expect(yield* ada.browser.get("/v1/aliases/ada.alias.test/shop/contacts")).toMatchObject({
        status: 200,
        body: [],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("erases the account after a fresh passkey assertion, leaving nothing usable", () =>
    Effect.gen(function* () {
      const handler = yield* api;
      const { browser: open, withRepos, context } = handler;
      const ada = yield* signedIn(open, "ada");
      const grace = yield* signedIn(open, "grace");
      // Ada on a second device.
      const phone = open();
      expect((yield* logIn(phone, ada.authenticator)).status).toBe(200);

      expect((yield* ada.browser.patch("/v1/settings", { isOnTheFlyEnabled: true })).status).toBe(
        200,
      );
      expect(
        (yield* ada.browser.post("/v1/recipients", { address: "ada@mailbox.example" })).status,
      ).toBe(201);
      // Bounced later: SES keeps the address on the account's suppression list.
      yield* SESV2.putSuppressedDestination({
        EmailAddress: "ada@mailbox.example",
        Reason: "BOUNCE",
      }).pipe(Effect.provide(context));
      const created = yield* ada.browser.post("/v1/aliases", {
        _tag: "Random",
        domain: "alias.test",
        mode: "forward",
      });
      const shared = Schema.decodeUnknownSync(Created)(created.body);
      const [localPart = "", domain = ""] = shared.address.split("@");
      yield* withRepos(
        ContactRepo.ContactRepo.use((repo) =>
          repo.create(contact(shared.id), { domain, localPart }),
        ),
      );

      const minted = yield* ada.browser.post("/v1/tokens", {
        name: "cli",
        scopes: ["aliases:read"],
      });
      const { token } = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(
        minted.body,
      );
      // Erasure takes a passkey: a token can't start it.
      expect((yield* handler.withToken(token).post("/v1/me/erase/options")).status).toBe(403);

      const erased = yield* erase(ada.browser, ada.authenticator);
      expect(erased.status).toBe(204);
      expect(erased.setCookies).toEqual([expect.stringContaining("Max-Age=0")]);

      // No session works any more, on either device, nor the API token, and the passkey logs
      // nobody in.
      expect((yield* ada.browser.get("/v1/me")).status).toBe(401);
      expect((yield* handler.withToken(token).get("/v1/me")).status).toBe(401);
      expect((yield* phone.get("/v1/me")).status).toBe(401);
      expect(yield* logIn(open(), ada.authenticator)).toMatchObject({
        status: 400,
        body: { _tag: "PasskeyRejected", reason: "unknown-credential" },
      });
      // The username is never given out again.
      expect(yield* open().post("/v1/auth/register/options", { username: "ada" })).toMatchObject({
        status: 409,
        body: { _tag: "UsernameTaken" },
      });
      // The recipient's address is off SES's suppression list.
      const unsuppressed = yield* Effect.flip(
        SESV2.getSuppressedDestination({ EmailAddress: "ada@mailbox.example" }),
      ).pipe(Effect.provide(context));
      expect(unsuppressed._tag).toBe("NotFoundException");
      // The alias and its contacts are gone; its address stays taken, by nobody.
      expect(yield* withRepos(ContactRepo.ContactRepo.use((repo) => repo.list(shared.id)))).toEqual(
        [],
      );
      expect(
        yield* withRepos(
          AliasRepo.AliasRepo.use((repo) =>
            Effect.all([repo.findByAddress(domain, localPart), repo.isDeleted(domain, localPart)], {
              concurrency: 1,
            }),
          ),
        ),
      ).toEqual([Option.none(), true]);

      // Grace is untouched.
      expect(yield* grace.browser.get("/v1/me")).toMatchObject({
        status: 200,
        body: { username: "grace" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("erases only with a passkey of this account answering an erasure challenge", () =>
    Effect.gen(function* () {
      const { browser: open } = yield* api;
      const ada = yield* signedIn(open, "ada");
      const grace = yield* signedIn(open, "grace");
      const challenge = (browser: Browser.Client, path: string) =>
        Effect.map(browser.post(path), (response) =>
          Schema.decodeUnknownSync(AuthenticationChallenge)(response.body),
        );
      const answer = (
        browser: Browser.Client,
        issued: TestApi.AuthenticationChallenge,
        authenticator: TestAuthenticator.TestAuthenticator,
      ) =>
        browser.post("/v1/me/erase", {
          challengeId: issued.challengeId,
          credential: authenticator.get(issued.options),
        });
      const expired = { status: 400, body: { reason: "challenge-expired" } };

      // A login challenge doesn't erase.
      const login = yield* challenge(open(), "/v1/auth/login/options");
      expect(yield* answer(ada.browser, login, ada.authenticator)).toMatchObject(expired);
      // Nor does Grace's erasure challenge, even answered with Ada's own passkey.
      const graces = yield* challenge(grace.browser, "/v1/me/erase/options");
      expect(yield* answer(ada.browser, graces, ada.authenticator)).toMatchObject(expired);
      // Nor Ada's challenge answered with Grace's passkey.
      const adas = yield* challenge(ada.browser, "/v1/me/erase/options");
      expect(yield* answer(ada.browser, adas, grace.authenticator)).toMatchObject({
        status: 400,
        body: { reason: "unknown-credential" },
      });
      // Each challenge works once.
      expect(yield* answer(ada.browser, adas, ada.authenticator)).toMatchObject(expired);

      expect((yield* ada.browser.get("/v1/me")).status).toBe(200);
      expect((yield* grace.browser.get("/v1/me")).status).toBe(200);

      const anonymous = open();
      expect((yield* anonymous.post("/v1/me/erase/options")).status).toBe(401);
      expect((yield* answer(anonymous, adas, ada.authenticator)).status).toBe(401);
    }).pipe(Effect.scoped),
  );
});
