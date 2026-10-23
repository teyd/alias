import type { RuleInput } from "@alias/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestApi from "./support/TestApi.ts";

const Identified = Schema.Struct({ id: Schema.String });
const decodeId = Schema.decodeUnknownSync(Identified);
const decodeIds = Schema.decodeUnknownSync(Schema.Array(Identified));
const idOf = (response: { readonly body: Schema.Json }) => decodeId(response.body).id;
const idsOf = (response: { readonly body: Schema.Json }) =>
  Arr.map(decodeIds(response.body), (found) => found.id);

const CreatedToken = Schema.Struct({ token: Schema.String });

const rule = (overrides: Partial<RuleInput> = {}): RuleInput => ({
  name: "Shop newsletters",
  isEnabled: true,
  match: "all",
  conditions: [
    { field: "sender-domain", match: "equals", value: "shop.example", isNegated: false },
  ],
  actions: [{ type: "prefix-subject", value: "[shop]" }],
  ...overrides,
});

describe("blocklist API (handler on fakecloud)", () => {
  it.effect("blocks addresses and domains, lists them in their stored form, unblocks", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      expect((yield* browser.get("/v1/blocklist")).body).toEqual([]);
      const address = yield* browser.post("/v1/blocklist", {
        kind: "address",
        value: " Spam@Mail.Example ",
      });
      expect(address.status).toBe(201);
      expect(address.body).toEqual({
        id: "spam@mail.example",
        kind: "address",
        value: "spam@mail.example",
        isSubdomainIncluded: false,
      });
      yield* browser.post("/v1/blocklist", {
        kind: "domain",
        value: "ads.example",
        isSubdomainIncluded: true,
      });
      // Adding an entry twice is harmless.
      expect(
        (yield* browser.post("/v1/blocklist", { kind: "domain", value: "*.ads.example" })).status,
      ).toBe(201);
      const listed = yield* browser.get("/v1/blocklist");
      expect(idsOf(listed)).toEqual(["*.ads.example", "spam@mail.example"]);

      expect(
        (yield* browser.delete(`/v1/blocklist/${encodeURIComponent("*.ads.example")}`)).status,
      ).toBe(204);
      const gone = yield* browser.delete(`/v1/blocklist/${encodeURIComponent("*.ads.example")}`);
      expect(gone.status).toBe(404);
      expect(gone.body).toMatchObject({ _tag: "BlocklistEntryNotFound" });

      // Another user sees none of it.
      const grace = yield* TestApi.signedIn(api.browser, "grace");
      expect((yield* grace.browser.get("/v1/blocklist")).body).toEqual([]);
    }),
  );

  it.effect("refuses what can't be blocked, with the reason", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      const address = yield* browser.post("/v1/blocklist", { kind: "address", value: "nope" });
      expect(address.status).toBe(400);
      expect(address.body).toMatchObject({
        _tag: "InvalidBlocklistEntry",
        reason: "invalid-address",
      });
      const domain = yield* browser.post("/v1/blocklist", { kind: "domain", value: "localhost" });
      expect(domain.body).toMatchObject({ reason: "invalid-domain" });
    }),
  );
});

describe("rules API (handler on fakecloud)", () => {
  it.effect("creates, lists, replaces, reorders and deletes rules", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      const first = yield* browser.post("/v1/rules", rule());
      expect(first.status).toBe(201);
      const firstId = idOf(first);
      expect(firstId).toMatch(/^rl_[0-9a-z]{26}$/);
      expect(first.body).toEqual({ id: firstId, ...rule() });
      const secondId = idOf(yield* browser.post("/v1/rules", rule({ name: "Second" })));

      const listed = yield* browser.get("/v1/rules");
      expect(idsOf(listed)).toEqual([firstId, secondId]);

      const replaced = yield* browser.put(`/v1/rules/${firstId}`, rule({ isEnabled: false }));
      expect(replaced.body).toMatchObject({ id: firstId, isEnabled: false });

      const reordered = yield* browser.post("/v1/rules/order", { ruleIds: [secondId, firstId] });
      expect(idsOf(reordered)).toEqual([secondId, firstId]);
      // An order must name every rule once.
      const refused = yield* Effect.forEach(
        [[secondId], [secondId, secondId], [secondId, firstId, "rl_x"]],
        (ruleIds) => Effect.map(browser.post("/v1/rules/order", { ruleIds }), (r) => r.status),
        { concurrency: 1 },
      );
      expect(refused).toEqual([400, 400, 400]);

      expect((yield* browser.delete(`/v1/rules/${secondId}`)).status).toBe(204);
      expect((yield* browser.delete(`/v1/rules/${secondId}`)).status).toBe(404);
      expect((yield* browser.put(`/v1/rules/${secondId}`, rule())).status).toBe(404);
      expect((yield* browser.get("/v1/rules")).body).toHaveLength(1);
    }),
  );

  it.effect("validates rules: bounds, no regex, and only the caller's destinations", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      const regex = {
        ...rule(),
        conditions: [{ field: "subject", match: "regex", value: "(a+)+$", isNegated: false }],
      };
      expect((yield* browser.post("/v1/rules", regex)).status).toBe(400);
      const many = { ...rule(), conditions: Arr.replicate(rule().conditions, 6).flat() };
      expect((yield* browser.post("/v1/rules", many)).status).toBe(400);

      const unknown = yield* browser.post(
        "/v1/rules",
        rule({ actions: [{ type: "forward-to", recipientId: "rcp_someone_else" }] }),
      );
      expect(unknown.status).toBe(400);
      expect(unknown.body).toMatchObject({
        _tag: "UnknownRecipient",
        recipientId: "rcp_someone_else",
      });
      const added = yield* browser.post("/v1/recipients", { address: "work@mailbox.test" });
      const recipientId = idOf(added);
      const routed = yield* browser.post(
        "/v1/rules",
        rule({ actions: [{ type: "forward-to", recipientId }] }),
      );
      expect(routed.status).toBe(201);
    }),
  );

  it.effect("keeps at most 30 rules", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      yield* Effect.forEach(
        Arr.range(1, 30),
        (n) => browser.post("/v1/rules", rule({ name: `r${n}` })),
        {
          concurrency: 1,
          discard: true,
        },
      );
      const refused = yield* browser.post("/v1/rules", rule());
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ _tag: "TooManyRules", limit: 30 });
    }),
  );

  it.effect("tries a sample on the saved blocklist and rules, or on a draft rule alone", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* TestApi.signedIn(api.browser, "ada");
      const ruleId = idOf(
        yield* browser.post(
          "/v1/rules",
          rule({ actions: [{ type: "prefix-subject", value: "[shop]" }, { type: "webhook" }] }),
        ),
      );
      yield* browser.post("/v1/blocklist", { kind: "address", value: "spam@shop.example" });
      const sample = { sender: "news@shop.example", subject: "Deals", alias: "x@alias.test" };

      const ruled = yield* browser.post("/v1/rules/test", { sample });
      expect(ruled.body).toEqual({
        matched: [ruleId],
        subject: "[shop] Deals",
        isTrackerRemovalSkipped: false,
        isEncryptionSkipped: false,
        notify: [ruleId],
      });
      const listed = yield* browser.post("/v1/rules/test", {
        sample: { ...sample, sender: "SPAM@shop.example" },
      });
      expect(listed.body).toMatchObject({
        blockedBy: { kind: "blocklist", entryId: "spam@shop.example" },
        matched: [],
      });
      const draft = yield* browser.post("/v1/rules/test", {
        sample,
        rule: rule({ actions: [{ type: "block" }] }),
      });
      expect(draft.body).toMatchObject({ blockedBy: { kind: "rule", ruleId: "draft" } });
      const labelled = yield* browser.post("/v1/rules/test", {
        sample: { sender: "x@elsewhere.example", alias: "x@alias.test", labels: ["Work"] },
        rule: rule({
          conditions: [{ field: "alias-label", match: "equals", value: "work", isNegated: false }],
          actions: [{ type: "block" }],
        }),
      });
      expect(labelled.body).toMatchObject({ blockedBy: { kind: "rule", ruleId: "draft" } });
      // Nothing was saved by trying.
      expect((yield* browser.get("/v1/rules")).body).toHaveLength(1);
    }),
  );

  it.effect("opens to tokens with rules scopes only", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const mint = (scopes: ReadonlyArray<string>) =>
        Effect.map(ada.browser.post("/v1/tokens", { name: "cli", scopes }), (created) =>
          api.withToken(Schema.decodeUnknownSync(CreatedToken)(created.body).token),
        );
      const reader = yield* mint(["rules:read"]);
      expect((yield* reader.get("/v1/blocklist")).status).toBe(200);
      expect((yield* reader.get("/v1/rules")).status).toBe(200);
      const denied = yield* reader.post("/v1/blocklist", { kind: "domain", value: "x.example" });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ scope: "rules:write" });
      const writer = yield* mint(["rules:write"]);
      expect(
        (yield* writer.post("/v1/blocklist", { kind: "domain", value: "x.example" })).status,
      ).toBe(201);
      expect((yield* writer.post("/v1/rules", rule())).status).toBe(201);
      const other = yield* mint(["contacts:write"]);
      expect((yield* other.get("/v1/rules")).status).toBe(403);
    }),
  );

  it.effect("needs a sign-in", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const browser = api.browser();
      expect((yield* browser.get("/v1/rules")).status).toBe(401);
      expect(
        (yield* browser.post("/v1/blocklist", { kind: "domain", value: "x.example" })).status,
      ).toBe(401);
    }),
  );
});
