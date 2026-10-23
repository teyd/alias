import { FakeCloud } from "@alias/aws-emulators";
import { AwsClient } from "@alias/aws";
import { AliasRepo, ContactRepo, RecipientRepo } from "@alias/db";
import { TestQueue } from "@alias/webhooks/testing";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Browser from "./support/Browser.ts";
import { TestAuthenticator } from "./support/index.ts";
import * as TestApi from "./support/TestApi.ts";

const { human } = TestApi;

type Api = Effect.Success<typeof TestApi.make>;

const repos = Layer.mergeAll(AliasRepo.layer, ContactRepo.layer, RecipientRepo.layer);

/** Runs `effect` on the API's own table. */
const withRepos = <A, E>(api: Api, effect: Effect.Effect<A, E, Layer.Success<typeof repos>>) =>
  Layer.build(repos).pipe(
    Effect.flatMap((context) => Effect.provide(effect, context)),
    Effect.provide(api.context),
    Effect.scoped,
  );

/** A confirmed destination of `userId`, written the way the API does: pending, then confirmed. */
const verifiedRecipient = (api: Api, userId: string, address: string) =>
  withRepos(
    api,
    Effect.gen(function* () {
      const repo = yield* RecipientRepo.RecipientRepo;
      const now = yield* DateTime.now;
      const added = { id: `rcp_${address}`, userId, address, createdAt: now };
      yield* repo.add(
        added,
        { tokenHash: "hash", expiresAt: DateTime.add(now, { hours: 1 }), sentAt: now },
        10,
      );
      yield* repo.confirm(
        {
          ...added,
          verifiedAt: Option.none(),
          lastSentAt: now,
          isDefault: false,
          bouncedAt: Option.none(),
          bounceReason: Option.none(),
          complainedAt: Option.none(),
          encryption: Option.none(),
        },
        "hash",
        now,
      );
      return added.id;
    }),
  );

const addUsername = (browser: Browser.Client, username: string) =>
  browser.post("/v1/usernames", { ...human, username });

const Listed = Schema.Struct({
  usernames: Schema.Array(
    Schema.Struct({
      username: Schema.String,
      isPrimary: Schema.Boolean,
      subdomains: Schema.Array(Schema.String),
      isOnTheFlyEnabled: Schema.Boolean,
      defaultRecipientId: Schema.optionalKey(Schema.String),
    }),
  ),
  limit: Schema.Number,
});

const listed = (browser: Browser.Client) =>
  Effect.map(browser.get("/v1/usernames"), (response) =>
    Schema.decodeUnknownSync(Listed)(response.body),
  );

/** The webhook events waiting on the test's queue. */
const queuedEvents = (api: Api) =>
  Effect.gen(function* () {
    const { queueUrl } = yield* TestQueue;
    const { url } = yield* FakeCloud.FakeCloud;
    const { Messages = [] } = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
    }).pipe(Effect.provide(AwsClient.emulator(url)));
    return Arr.map(Messages, (message) => JSON.parse(message.Body ?? "null").event);
  }).pipe(Effect.provide(api.context));

describe("additional usernames (PLAN.md §20.34, API handler on fakecloud)", () => {
  it.effect("adds usernames whose subdomains take aliases, and lists them with the primary", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const grace = yield* TestApi.signedIn(api.browser, "grace");

      const added = yield* addUsername(ada.browser, "Ada-Work");
      expect(added).toMatchObject({
        status: 201,
        body: {
          username: "ada-work",
          isPrimary: false,
          subdomains: ["ada-work.alias.test", "ada-work.alias2.test"],
          isOnTheFlyEnabled: false,
        },
      });
      expect(yield* listed(ada.browser)).toEqual({
        usernames: [
          {
            username: "ada",
            isPrimary: true,
            subdomains: ["ada.alias.test", "ada.alias2.test"],
            isOnTheFlyEnabled: false,
          },
          {
            username: "ada-work",
            isPrimary: false,
            subdomains: ["ada-work.alias.test", "ada-work.alias2.test"],
            isOnTheFlyEnabled: false,
          },
        ],
        limit: 3,
      });
      // The primary stays the login handle.
      expect((yield* ada.browser.get("/v1/me")).body).toMatchObject({ username: "ada" });
      // Alias creation offers its subdomains, and takes addresses on them.
      expect((yield* ada.browser.get("/v1/aliases/domains")).body).toMatchObject({
        subdomains: [
          "ada.alias.test",
          "ada.alias2.test",
          "ada-work.alias.test",
          "ada-work.alias2.test",
        ],
      });
      expect(
        yield* ada.browser.post("/v1/aliases", {
          _tag: "Address",
          address: "shop@ada-work.alias.test",
          mode: "forward",
        }),
      ).toMatchObject({ status: 201, body: { address: "shop@ada-work.alias.test" } });
      // Role mailboxes stay ours there too, and nobody else may use the subdomain.
      expect(
        yield* ada.browser.post("/v1/aliases", {
          _tag: "Address",
          address: "abuse@ada-work.alias.test",
          mode: "forward",
        }),
      ).toMatchObject({ status: 400, body: { reason: "role-address" } });
      expect(
        yield* grace.browser.post("/v1/aliases", {
          _tag: "Address",
          address: "shop2@ada-work.alias.test",
          mode: "forward",
        }),
      ).toMatchObject({ status: 400, body: { reason: "not-your-subdomain" } });
      expect((yield* listed(grace.browser)).usernames).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("holds new usernames to sign-up's name rules", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      yield* TestApi.signedIn(api.browser, "grace");
      yield* addUsername(ada.browser, "lovelace");

      expect(yield* addUsername(ada.browser, "admin")).toMatchObject({
        status: 400,
        body: { _tag: "InvalidUsername", reason: "reserved" },
      });
      expect(yield* addUsername(ada.browser, "x")).toMatchObject({
        status: 400,
        body: { _tag: "InvalidUsername", reason: "too-short" },
      });
      // Taken: another user's primary, the caller's own, a lookalike of one.
      const taken = yield* Effect.forEach(
        ["grace", "ada", "iovelace"],
        (name) => addUsername(ada.browser, name),
        { concurrency: 1 },
      );
      expect(taken).toMatchObject(
        Arr.map(taken, () => ({ status: 409, body: { _tag: "UsernameTaken" } })),
      );
      // And sign-up can't take an additional username either.
      expect(
        yield* api.browser().post("/v1/auth/register/options", { ...human, username: "lovelace" }),
      ).toMatchObject({ status: 409, body: { _tag: "UsernameTaken" } });
    }).pipe(Effect.scoped),
  );

  it.effect("needs a solved Turnstile widget, checked after the name and the cap", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const unsolved = (username: string) =>
        ada.browser.post("/v1/usernames", { username, turnstileToken: "" });
      expect(yield* unsolved("ada-work")).toMatchObject({
        status: 400,
        body: { _tag: "HumanCheckFailed" },
      });
      // The name and the cap are checked first, so a refusal never spends a solved widget.
      expect(yield* unsolved("admin")).toMatchObject({
        status: 400,
        body: { _tag: "InvalidUsername", reason: "reserved" },
      });
      yield* Effect.forEach(
        ["ada-one", "ada-two", "ada-three"],
        (name) => addUsername(ada.browser, name),
        { concurrency: 1 },
      );
      expect(yield* unsolved("ada-four")).toMatchObject({
        status: 409,
        body: { _tag: "TooManyUsernames" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("caps additional usernames, and counts them against sign-up's limits", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({ limits: { signupsPerDay: 3 } });
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      // Ada's sign-up was this address's first account of the day.
      expect((yield* addUsername(ada.browser, "ada-one")).status).toBe(201);
      expect((yield* addUsername(ada.browser, "ada-two")).status).toBe(201);
      expect(yield* addUsername(ada.browser, "ada-three")).toMatchObject({
        status: 429,
        body: { _tag: "TooManyAttempts" },
      });
      yield* TestClock.adjust("1 day");
      expect((yield* addUsername(ada.browser, "ada-three")).status).toBe(201);
      expect(yield* addUsername(ada.browser, "ada-four")).toMatchObject({
        status: 409,
        body: { _tag: "TooManyUsernames", limit: 3 },
      });
      // Deleting one frees its slot.
      expect((yield* ada.browser.delete("/v1/usernames/ada-one")).status).toBe(204);
      expect((yield* addUsername(ada.browser, "ada-four")).status).toBe(201);
    }).pipe(Effect.scoped),
  );

  it.effect("pauses new usernames with sign-ups when the circuit breaker trips", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.makeWith({ limits: { signupsPerHour: 1 } });
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      expect(yield* addUsername(ada.browser, "ada-work")).toMatchObject({
        status: 503,
        body: { _tag: "SignupUnavailable", reason: "paused" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps each username's on-the-fly setting and default destination", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const grace = yield* TestApi.signedIn(api.browser, "grace");
      yield* addUsername(ada.browser, "ada-work");
      const work = yield* verifiedRecipient(api, ada.userId, "ada.work@office.example");
      const graces = yield* verifiedRecipient(api, grace.userId, "grace@mailbox.example");
      const pending = `rcp_new@mailbox.example`;
      yield* withRepos(
        api,
        RecipientRepo.RecipientRepo.use((repo) =>
          Effect.flatMap(DateTime.now, (now) =>
            repo.add(
              { id: pending, userId: ada.userId, address: "new@mailbox.example", createdAt: now },
              { tokenHash: "h", expiresAt: DateTime.add(now, { hours: 1 }), sentAt: now },
              10,
            ),
          ),
        ),
      );

      expect(
        yield* ada.browser.patch("/v1/usernames/ada-work", {
          isOnTheFlyEnabled: true,
          defaultRecipientId: work,
        }),
      ).toMatchObject({
        status: 200,
        body: { username: "ada-work", isOnTheFlyEnabled: true, defaultRecipientId: work },
      });
      // The primary's setting is the account's, and it is untouched.
      expect((yield* ada.browser.get("/v1/settings")).body).toMatchObject({
        isOnTheFlyEnabled: false,
      });
      expect(
        yield* ada.browser.patch("/v1/usernames/ada-work", { defaultRecipientId: graces }),
      ).toMatchObject({ status: 404, body: { _tag: "RecipientNotFound" } });
      expect(
        yield* ada.browser.patch("/v1/usernames/ada-work", { defaultRecipientId: pending }),
      ).toMatchObject({ status: 409, body: { _tag: "RecipientNotVerified" } });
      expect(
        yield* ada.browser.patch("/v1/usernames/ada-work", { defaultRecipientId: null }),
      ).toMatchObject({ status: 200, body: { isOnTheFlyEnabled: true } });
      expect(
        (yield* listed(ada.browser)).usernames.find((entry) => entry.username === "ada-work"),
      ).toEqual(expect.not.objectContaining({ defaultRecipientId: expect.anything() }));

      // The primary: on the fly goes to the account's settings; a destination of its own, no.
      expect(
        yield* ada.browser.patch("/v1/usernames/ada", { isOnTheFlyEnabled: true }),
      ).toMatchObject({
        status: 200,
        body: { username: "ada", isPrimary: true, isOnTheFlyEnabled: true },
      });
      expect((yield* ada.browser.get("/v1/settings")).body).toMatchObject({
        isOnTheFlyEnabled: true,
      });
      expect(
        yield* ada.browser.patch("/v1/usernames/ada", { defaultRecipientId: work }),
      ).toMatchObject({ status: 409, body: { _tag: "PrimaryUsername" } });
      // Someone else's or unknown usernames look the same.
      expect(
        yield* grace.browser.patch("/v1/usernames/ada-work", { isOnTheFlyEnabled: false }),
      ).toMatchObject({ status: 404, body: { _tag: "UsernameNotFound" } });
      expect(
        yield* ada.browser.patch("/v1/usernames/nobody-here", { isOnTheFlyEnabled: false }),
      ).toMatchObject({ status: 404, body: { _tag: "UsernameNotFound" } });
    }).pipe(Effect.scoped),
  );

  it.effect("deletes a username with every alias on it, and never gives the name out again", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const grace = yield* TestApi.signedIn(api.browser, "grace");
      yield* addUsername(ada.browser, "ada-work");
      yield* ada.browser.post("/v1/webhooks", {
        url: "https://hooks.example.com/alias",
        eventTypes: ["alias.deleted"],
      });
      const create = (address: string) =>
        ada.browser.post("/v1/aliases", { _tag: "Address", address, mode: "forward" });
      const work = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
        (yield* create("shop@ada-work.alias.test")).body,
      );
      yield* create("old@ada-work.alias2.test");
      yield* ada.browser.delete("/v1/aliases/ada-work.alias2.test/old");
      yield* create("shop@ada.alias.test");
      yield* withRepos(
        api,
        ContactRepo.ContactRepo.use((repo) =>
          repo.create(
            {
              id: "c1aaaaaaaaaaaaaa",
              aliasId: work.id,
              address: "orders@store.example",
              name: Option.none(),
              createdAt: DateTime.makeUnsafe(1_000),
            },
            { domain: "ada-work.alias.test", localPart: "shop" },
          ),
        ),
      );

      // Not the primary, not someone else's.
      expect(yield* ada.browser.delete("/v1/usernames/ada")).toMatchObject({
        status: 409,
        body: { _tag: "PrimaryUsername" },
      });
      expect(yield* grace.browser.delete("/v1/usernames/ada-work")).toMatchObject({
        status: 404,
        body: { _tag: "UsernameNotFound" },
      });
      expect((yield* ada.browser.delete("/v1/usernames/ada-work")).status).toBe(204);
      expect(yield* ada.browser.delete("/v1/usernames/ada-work")).toMatchObject({
        status: 404,
        body: { _tag: "UsernameNotFound" },
      });

      expect(Arr.map((yield* listed(ada.browser)).usernames, (entry) => entry.username)).toEqual([
        "ada",
      ]);
      const aliases = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ address: Schema.String })),
      )((yield* ada.browser.get("/v1/aliases")).body);
      expect(Arr.map(aliases, (alias) => alias.address)).toEqual(["shop@ada.alias.test"]);
      // Nothing is left of its aliases, tombstones included: the username's tombstone covers
      // its subdomains for good.
      expect(
        yield* withRepos(
          api,
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            return yield* Effect.all(
              [
                repo.findByAddress("ada-work.alias.test", "shop"),
                repo.isDeleted("ada-work.alias.test", "shop"),
                repo.isDeleted("ada-work.alias2.test", "old"),
                (yield* ContactRepo.ContactRepo).list(work.id),
              ],
              { concurrency: 1 },
            );
          }),
        ),
      ).toEqual([Option.none(), false, false, []]);
      // Its webhooks heard about the deleted alias.
      expect(yield* queuedEvents(api)).toContainEqual(
        expect.objectContaining({
          type: "alias.deleted",
          data: { aliasId: work.id, address: "shop@ada-work.alias.test" },
        }),
      );
      // Nobody gets the name again, nor its subdomain: not Ada, not Grace, not at sign-up.
      expect(yield* addUsername(ada.browser, "ada-work")).toMatchObject({
        status: 409,
        body: { _tag: "UsernameTaken" },
      });
      expect(yield* addUsername(grace.browser, "adawork")).toMatchObject({
        status: 409,
        body: { _tag: "UsernameTaken" },
      });
      expect(
        yield* api.browser().post("/v1/auth/register/options", { ...human, username: "ada-work" }),
      ).toMatchObject({ status: 409, body: { _tag: "UsernameTaken" } });
      expect(yield* create("again@ada-work.alias.test")).toMatchObject({
        status: 400,
        body: { reason: "not-your-subdomain" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("opens to tokens with the usernames scopes, except for adding one", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      yield* addUsername(ada.browser, "ada-work");
      const mint = (scopes: ReadonlyArray<string>) =>
        Effect.map(ada.browser.post("/v1/tokens", { name: "cli", scopes }), (response) =>
          api.withToken(
            Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(response.body).token,
          ),
        );
      const reader = yield* mint(["usernames:read"]);
      const writer = yield* mint(["usernames:read", "usernames:write"]);

      expect((yield* reader.get("/v1/usernames")).status).toBe(200);
      expect(
        yield* reader.patch("/v1/usernames/ada-work", { isOnTheFlyEnabled: true }),
      ).toMatchObject({
        status: 403,
        body: { _tag: "Forbidden", scope: "usernames:write" },
      });
      expect(
        (yield* writer.patch("/v1/usernames/ada-work", { isOnTheFlyEnabled: true })).status,
      ).toBe(200);
      // Adding one takes a passkey sign-in and a human check, so no token may.
      expect(yield* writer.post("/v1/usernames", { ...human, username: "ada-home" })).toMatchObject(
        {
          status: 403,
          body: { _tag: "Forbidden" },
        },
      );
      expect((yield* writer.delete("/v1/usernames/ada-work")).status).toBe(204);
      expect((yield* api.browser().get("/v1/usernames")).status).toBe(401);
    }).pipe(Effect.scoped),
  );

  it.effect("erases additional usernames with the account, and keeps them taken", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const open = api.browser;
      const browser = open();
      const authenticator = TestAuthenticator.make(Browser.origin);
      yield* TestApi.signUp(browser, authenticator, "ada");
      yield* addUsername(browser, "ada-work");
      yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada-work.alias.test",
        mode: "forward",
      });

      const started = yield* browser.post("/v1/me/erase/options");
      const { challengeId, options } = Schema.decodeUnknownSync(TestApi.AuthenticationChallenge)(
        started.body,
      );
      expect(
        (yield* browser.post("/v1/me/erase", {
          challengeId,
          credential: authenticator.get(options),
        })).status,
      ).toBe(204);

      expect(
        yield* open().post("/v1/auth/register/options", { ...human, username: "ada-work" }),
      ).toMatchObject({ status: 409, body: { _tag: "UsernameTaken" } });
      // Its aliases leave nothing: the username's tombstone covers the subdomain.
      expect(
        yield* withRepos(
          api,
          AliasRepo.AliasRepo.use((repo) =>
            Effect.all(
              [
                repo.findByAddress("ada-work.alias.test", "shop"),
                repo.isDeleted("ada-work.alias.test", "shop"),
              ],
              { concurrency: 1 },
            ),
          ),
        ),
      ).toEqual([Option.none(), false]);
    }).pipe(Effect.scoped),
  );
});
