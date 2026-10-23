import { MAX_LABEL_COLORS } from "@alias/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { addRecipient, addVerified } from "./support/Recipients.ts";
import * as TestApi from "./support/TestApi.ts";

/**
 * Organising aliases (PLAN.md §20.31): recipients per alias, descriptions and labels, the export
 * and the import, through the API handler on fakecloud.
 */

const Created = Schema.Struct({ token: Schema.String });

/** The API with Ada signed in, and two verified recipients of hers. */
const withRecipients = Effect.fn("withRecipients")(function* () {
  const api = yield* TestApi.make;
  const ada = yield* TestApi.signedIn(api.browser, "ada");
  const home = yield* addVerified(api, ada.browser, "home@mailbox.test");
  const work = yield* addVerified(api, ada.browser, "work@mailbox.test");
  return { api, ada, browser: ada.browser, home, work };
});

const shop = "/v1/aliases/ada.alias.test/shop";

describe("alias organisation API (handler on fakecloud)", () => {
  it.effect("creates an alias with a description, labels and recipients, and shows them", () =>
    Effect.gen(function* () {
      const { browser, home, work } = yield* withRecipients();
      const created = yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada.alias.test",
        mode: "forward",
        description: "  Online shop  ",
        labels: ["shopping", "eu"],
        recipientIds: [work.id, home.id],
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        address: "shop@ada.alias.test",
        description: "Online shop",
        labels: ["shopping", "eu"],
        recipientIds: [work.id, home.id],
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
      expect((yield* browser.get(shop)).body).toEqual(created.body);
      expect((yield* browser.get("/v1/aliases")).body).toEqual([created.body]);

      // Without details, nothing is set: the default recipient gets the mail.
      const plain = yield* browser.post("/v1/aliases", {
        _tag: "Random",
        domain: "alias.test",
        mode: "forward",
      });
      expect(plain.body).toMatchObject({ labels: [], recipientIds: [] });
      expect(plain.body).not.toHaveProperty("description");
    }),
  );

  it.effect("changes and clears the details; only what's given changes", () =>
    Effect.gen(function* () {
      const { browser, home, work } = yield* withRecipients();
      yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada.alias.test",
        mode: "forward",
        description: "Shop",
        labels: ["a"],
      });
      const changed = yield* browser.patch(shop, { recipientIds: [home.id, work.id] });
      expect(changed.body).toMatchObject({
        description: "Shop",
        labels: ["a"],
        recipientIds: [home.id, work.id],
      });
      const cleared = yield* browser.patch(shop, { description: "", labels: [], recipientIds: [] });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ labels: [], recipientIds: [], isActive: true });
      expect(cleared.body).not.toHaveProperty("description");
    }),
  );

  it.effect("accepts only the caller's verified recipients, at most five", () =>
    Effect.gen(function* () {
      const { api, browser, home } = yield* withRecipients();
      const pending = yield* addRecipient(browser, "pending@mailbox.test");
      const bob = yield* TestApi.signedIn(api.browser, "bob");
      const bobs = yield* addVerified(api, bob.browser, "bob@mailbox.test");
      yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada.alias.test",
        mode: "forward",
      });

      expect(yield* browser.patch(shop, { recipientIds: [home.id, pending.id] })).toMatchObject({
        status: 400,
        body: { _tag: "InvalidAliasRecipient", recipientId: pending.id, reason: "unverified" },
      });
      expect(yield* browser.patch(shop, { recipientIds: [bobs.id] })).toMatchObject({
        status: 400,
        body: { _tag: "InvalidAliasRecipient", recipientId: bobs.id, reason: "unknown" },
      });
      expect(
        (yield* browser.post("/v1/aliases", {
          _tag: "Random",
          domain: "alias.test",
          mode: "forward",
          recipientIds: ["rcp_nope"],
        })).status,
      ).toBe(400);
      // Nothing was created by the refused request.
      expect((yield* browser.get("/v1/aliases")).body).toHaveLength(1);
      const tooMany = Arr.makeBy(6, (index) => `rcp_${index}`);
      const refused = yield* Effect.forEach(
        [
          { recipientIds: tooMany },
          { recipientIds: [home.id, home.id] },
          { labels: ["ok", "has,comma"] },
          { labels: ["-leading"] },
          { labels: Arr.makeBy(11, (index) => `l${index}`) },
          { labels: ["a", "a"] },
          { description: "x".repeat(201) },
        ],
        (payload) => Effect.map(browser.patch(shop, payload), (response) => response.status),
        { concurrency: 1 },
      );
      expect(refused).toEqual(Arr.replicate(400, 7));
      expect((yield* browser.patch(shop, { description: "x".repeat(200) })).status).toBe(200);
    }),
  );

  it.effect("leaves out a recipient deleted since it was chosen", () =>
    Effect.gen(function* () {
      const { browser, home, work } = yield* withRecipients();
      yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada.alias.test",
        mode: "forward",
        recipientIds: [home.id, work.id],
      });
      expect((yield* browser.delete(`/v1/recipients/${work.id}`)).status).toBe(204);
      expect((yield* browser.get(shop)).body).toMatchObject({ recipientIds: [home.id] });
      const exported = yield* browser.get("/v1/aliases/export");
      expect(exported.body).toMatchObject({
        aliases: [{ address: "shop@ada.alias.test", recipients: ["home@mailbox.test"] }],
      });
    }),
  );

  it.effect("exports every alias with its details, recipients by address and counters", () =>
    Effect.gen(function* () {
      const { browser, work } = yield* withRecipients();
      yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada.alias.test",
        mode: "both",
        description: "Shop",
        labels: ["shopping"],
        recipientIds: [work.id],
      });
      // Listed by creation time; the same instant would order them by their random ids.
      yield* TestClock.adjust("1 second");
      yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "club@ada.alias.test",
        mode: "forward",
      });
      yield* browser.patch("/v1/aliases/ada.alias.test/club", { isActive: false });
      // Temporary inboxes have their own list and aren't exported.
      expect((yield* browser.post("/v1/inboxes", {})).status).toBe(201);

      const exported = yield* browser.get("/v1/aliases/export");
      expect(exported.status).toBe(200);
      expect(exported.body).toEqual({
        exportedAt: expect.any(String),
        aliases: [
          {
            address: "shop@ada.alias.test",
            isActive: true,
            mode: "both",
            description: "Shop",
            labels: ["shopping"],
            recipients: ["work@mailbox.test"],
            forwardedCount: 0,
            blockedCount: 0,
            createdAt: expect.any(String),
          },
          {
            address: "club@ada.alias.test",
            isActive: false,
            mode: "forward",
            labels: [],
            recipients: [],
            forwardedCount: 0,
            blockedCount: 0,
            createdAt: expect.any(String),
          },
        ],
      });
    }),
  );

  it.effect("lets a token export only with both aliases:read and recipients:read", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const mint = (scopes: ReadonlyArray<string>) =>
        Effect.map(ada.browser.post("/v1/tokens", { name: "export", scopes }), (response) =>
          api.withToken(Schema.decodeUnknownSync(Created)(response.body).token),
        );
      const aliasesOnly = yield* mint(["aliases:read"]);
      expect(yield* aliasesOnly.get("/v1/aliases/export")).toMatchObject({
        status: 403,
        body: { _tag: "Forbidden", scope: "recipients:read" },
      });
      // Listing aliases names recipients by id only, so aliases:read is enough there.
      expect((yield* aliasesOnly.get("/v1/aliases")).status).toBe(200);
      const recipientsOnly = yield* mint(["recipients:read"]);
      expect(yield* recipientsOnly.get("/v1/aliases/export")).toMatchObject({
        status: 403,
        body: { scope: "aliases:read" },
      });
      const both = yield* mint(["aliases:read", "recipients:read"]);
      expect((yield* both.get("/v1/aliases/export")).status).toBe(200);
    }),
  );

  it.effect("imports addresses on the caller's own domains, with a result per row", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      yield* TestApi.signedIn(api.browser, "bob");
      yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "taken@ada.alias.test",
        mode: "forward",
      });
      const imported = yield* browser.post("/v1/aliases/import", {
        aliases: [
          {
            address: " Shop@ADA.alias.test ",
            description: "Shop",
            labels: ["shopping", "eu"],
            isActive: false,
          },
          { address: "club@ada.alias.test" },
          { address: "shop@ada.alias.test" },
          { address: "taken@ada.alias.test" },
          { address: "x@bob.alias.test" },
          { address: "random@alias.test" },
          { address: "abuse@ada.alias.test" },
          { address: "not an address" },
          { address: "a@ada.alias.test", labels: ["bad;label"] },
          { address: "b@ada.alias.test", description: "x".repeat(201) },
          { address: "c@nobody.example" },
        ],
      });
      expect(imported.status).toBe(200);
      expect(imported.body).toEqual({
        results: [
          {
            _tag: "Created",
            row: 1,
            alias: expect.objectContaining({
              address: "shop@ada.alias.test",
              isActive: false,
              description: "Shop",
              labels: ["shopping", "eu"],
            }),
          },
          {
            _tag: "Created",
            row: 2,
            alias: expect.objectContaining({ address: "club@ada.alias.test", isActive: true }),
          },
          { _tag: "Failed", row: 3, address: "shop@ada.alias.test", reason: "duplicate" },
          { _tag: "Failed", row: 4, address: "taken@ada.alias.test", reason: "taken" },
          { _tag: "Failed", row: 5, address: "x@bob.alias.test", reason: "not-your-subdomain" },
          {
            _tag: "Failed",
            row: 6,
            address: "random@alias.test",
            reason: "random-only-on-shared-domain",
          },
          { _tag: "Failed", row: 7, address: "abuse@ada.alias.test", reason: "role-address" },
          { _tag: "Failed", row: 8, address: "not an address", reason: "invalid-address" },
          { _tag: "Failed", row: 9, address: "a@ada.alias.test", reason: "invalid-labels" },
          { _tag: "Failed", row: 10, address: "b@ada.alias.test", reason: "invalid-description" },
          { _tag: "Failed", row: 11, address: "c@nobody.example", reason: "unknown-domain" },
        ],
      });
      expect((yield* browser.get("/v1/aliases")).body).toHaveLength(3);
      expect((yield* browser.post("/v1/aliases/import", { aliases: [] })).status).toBe(400);
      expect(
        (yield* browser.post("/v1/aliases/import", {
          aliases: Arr.makeBy(101, (index) => ({ address: `a${index}@ada.alias.test` })),
        })).status,
      ).toBe(400);
    }),
  );

  it.effect("lists labels with their colours and counts, and colours them", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      const bob = yield* TestApi.signedIn(api.browser, "bob");
      yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "shop@ada.alias.test",
        mode: "forward",
        labels: ["work", "shopping"],
      });
      yield* browser.post("/v1/aliases", {
        _tag: "Address",
        address: "club@ada.alias.test",
        mode: "forward",
        labels: ["work"],
      });
      expect((yield* browser.get("/v1/labels")).body).toEqual([
        { name: "shopping", aliasCount: 1 },
        { name: "work", aliasCount: 2 },
      ]);
      expect((yield* browser.put("/v1/labels/work", { color: "blue" })).body).toEqual({
        name: "work",
        color: "blue",
        aliasCount: 2,
      });
      // A label may get its colour before any alias carries it.
      expect((yield* browser.put("/v1/labels/later%20on", { color: "pink" })).body).toEqual({
        name: "later on",
        color: "pink",
        aliasCount: 0,
      });
      expect((yield* browser.get("/v1/labels")).body).toEqual([
        { name: "later on", color: "pink", aliasCount: 0 },
        { name: "shopping", aliasCount: 1 },
        { name: "work", color: "blue", aliasCount: 2 },
      ]);
      expect((yield* browser.put("/v1/labels/later%20on", { color: null })).status).toBe(200);
      expect((yield* browser.get("/v1/labels")).body).toHaveLength(2);
      // Each user's labels are their own.
      expect((yield* bob.browser.get("/v1/labels")).body).toEqual([]);

      expect((yield* browser.put("/v1/labels/work", { color: "#ff0000" })).status).toBe(400);
      expect((yield* browser.put("/v1/labels/a%3Bb", { color: "red" })).status).toBe(400);
      expect((yield* api.browser().get("/v1/labels")).status).toBe(401);
    }),
  );

  it.effect("caps how many labels may have a colour", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      yield* Effect.forEach(
        Arr.makeBy(MAX_LABEL_COLORS, (index) => `l${index}`),
        (label) => browser.put(`/v1/labels/${label}`, { color: "red" }),
        { concurrency: 8, discard: true },
      );
      expect(yield* browser.put("/v1/labels/one-more", { color: "red" })).toMatchObject({
        status: 409,
        body: { _tag: "TooManyLabelColors", limit: MAX_LABEL_COLORS },
      });
      // Recolouring one that has a colour is fine.
      expect((yield* browser.put("/v1/labels/l0", { color: "blue" })).status).toBe(200);
    }),
  );
});
