import { Identities } from "@alias/aws";
import created from "@alias/aws/fixtures/sesv2-create-email-identity-response.json" with { type: "json" };
import { AliasRepo, DomainRepo } from "@alias/db";
import { DohServer, type ZoneRecord } from "@alias/doh-emulator";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as DomainVerification from "../src/DomainVerification.ts";
import * as Browser from "./support/Browser.ts";
import { TestAuthenticator } from "./support/index.ts";
import * as TestApi from "./support/TestApi.ts";

type Api = Effect.Success<typeof TestApi.make>;

const RecordView = Schema.Struct({
  purpose: Schema.String,
  isRequired: Schema.Boolean,
  type: Schema.Literals(["TXT", "MX", "CNAME"]),
  name: Schema.String,
  value: Schema.String,
  priority: Schema.optionalKey(Schema.Number),
  state: Schema.String,
});
const DomainView = Schema.Struct({
  domain: Schema.String,
  status: Schema.String,
  isCatchAllEnabled: Schema.Boolean,
  createdAt: Schema.String,
  verifiedAt: Schema.optionalKey(Schema.String),
  checkedAt: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
  records: Schema.Array(RecordView),
});
type DomainView = typeof DomainView.Type;
const decodeDomain = Schema.decodeUnknownSync(DomainView);

const signedIn = Effect.fn("signedIn")(function* (api: Api, username: string) {
  const browser = api.browser();
  const registered = yield* TestApi.signUp(
    browser,
    TestAuthenticator.make(Browser.origin),
    username,
  );
  expect(registered.status).toBe(200);
  return browser;
});

const addDomain = Effect.fn("addDomain")(function* (browser: Browser.Client, domain: string) {
  const response = yield* browser.post("/v1/domains", { domain });
  expect(response.status).toBe(201);
  return decodeDomain(response.body);
});

/** The owner's "check now"; it answers from the last check for 10 seconds, so wait that out. */
const checkNow = Effect.fn("checkNow")(function* (browser: Browser.Client, domain: string) {
  yield* TestClock.adjust(Duration.seconds(11));
  return yield* browser.post(`/v1/domains/${domain}/check`);
});

const check = Effect.fn("check")(function* (browser: Browser.Client, domain: string) {
  const response = yield* checkNow(browser, domain);
  expect(response.status).toBe(200);
  return decodeDomain(response.body);
});

/** The records a user following the wizard publishes, as zone records. */
const zoneFor = (
  view: DomainView,
  skip: (record: DomainView["records"][number]) => boolean = () => false,
) =>
  Arr.map(
    Arr.filter(view.records, (record) => !skip(record)),
    (record): ZoneRecord => ({
      name: record.name,
      type: record.type,
      data: record.type === "MX" ? `${record.priority ?? 10} ${record.value}` : record.value,
    }),
  );

const publish = (api: Api, apex: string, records: ReadonlyArray<ZoneRecord>) =>
  Effect.flatMap(DohServer.DohServer, (server) => server.setZone(apex, records)).pipe(
    Effect.provide(api.context),
  );

const states = (view: DomainView) => Arr.dedupe(Arr.map(view.records, (record) => record.state));

describe("custom domains on the API handler (fakecloud SES identities, DoH emulator)", () => {
  it.effect("adds a domain: SES identity with Easy DKIM, the records to publish", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const browser = yield* signedIn(api, "ada");
      const added = yield* addDomain(browser, " Custom.Example. ");
      expect(added).toMatchObject({
        domain: "custom.example",
        status: "pending",
        isCatchAllEnabled: false,
        createdAt: "1970-01-01T00:00:00.000Z",
        expiresAt: "1970-01-04T00:00:00.000Z",
      });
      expect(Arr.map(added.records, (record) => [record.type, record.name, record.state])).toEqual([
        ["TXT", "custom.example", "unchecked"],
        ["MX", "custom.example", "unchecked"],
        ["CNAME", "token1._domainkey.custom.example", "unchecked"],
        ["CNAME", "token2._domainkey.custom.example", "unchecked"],
        ["CNAME", "token3._domainkey.custom.example", "unchecked"],
        ["MX", "bounce.custom.example", "unchecked"],
        ["TXT", "bounce.custom.example", "unchecked"],
        ["TXT", "_dmarc.custom.example", "unchecked"],
      ]);
      expect(added.records[0]?.value).toMatch(/^alias-verification=[0-9a-f]{32}$/);

      const identity = yield* SESV2.getEmailIdentity({ EmailIdentity: "custom.example" }).pipe(
        Effect.provide(api.context),
      );
      expect(identity.MailFromAttributes?.MailFromDomain).toBe("bounce.custom.example");
      expect(identity.FeedbackForwardingStatus).toBe(false);

      const listed = yield* browser.get("/v1/domains");
      expect(
        Arr.map(Schema.decodeUnknownSync(Schema.Array(DomainView))(listed.body), (d) => d.domain),
      ).toEqual(["custom.example"]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses bad and shared domains, taken domains and a fourth domain", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* signedIn(api, "ada");
      const bob = yield* signedIn(api, "bob");
      const reasons = yield* Effect.forEach(
        ["not a domain", "localhost", "alias.test", "ada.alias.test", "test", "alias2.test"],
        (domain) =>
          Effect.map(ada.post("/v1/domains", { domain }), (response) => [
            response.status,
            response.body,
          ]),
        { concurrency: 1 },
      );
      expect(reasons).toEqual([
        [400, { _tag: "InvalidDomain", domain: "not a domain", reason: "invalid" }],
        [400, { _tag: "InvalidDomain", domain: "localhost", reason: "invalid" }],
        [400, { _tag: "InvalidDomain", domain: "alias.test", reason: "shared-domain" }],
        [400, { _tag: "InvalidDomain", domain: "ada.alias.test", reason: "shared-domain" }],
        [400, { _tag: "InvalidDomain", domain: "test", reason: "invalid" }],
        [400, { _tag: "InvalidDomain", domain: "alias2.test", reason: "shared-domain" }],
      ]);

      yield* addDomain(ada, "one.example");
      expect(yield* bob.post("/v1/domains", { domain: "ONE.example" })).toMatchObject({
        status: 409,
        body: { _tag: "DomainTaken", domain: "one.example" },
      });
      expect((yield* ada.post("/v1/domains", { domain: "one.example" })).status).toBe(409);
      yield* addDomain(ada, "two.example");
      yield* addDomain(ada, "three.example");
      expect(yield* ada.post("/v1/domains", { domain: "four.example" })).toMatchObject({
        status: 409,
        body: { _tag: "TooManyDomains", limit: 3 },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("verifies once every required record is published, and fails when one goes", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const browser = yield* signedIn(api, "ada");
      const added = yield* addDomain(browser, "custom.example");

      const before = yield* check(browser, "custom.example");
      expect(before).toMatchObject({ status: "pending" });
      expect(states(before)).toEqual(["missing"]);

      // Everything but the ownership token: SES would verify (DKIM), but we don't.
      yield* publish(
        api,
        "custom.example",
        zoneFor(added, (record) => record.purpose === "ownership"),
      );
      const noToken = yield* check(browser, "custom.example");
      expect(noToken.status).toBe("pending");
      expect(noToken.records[0]?.state).toBe("missing");

      // Only the required records: verified; the recommended ones show as missing.
      yield* publish(
        api,
        "custom.example",
        zoneFor(added, (record) => !record.isRequired),
      );
      const verified = yield* check(browser, "custom.example");
      expect(verified).toMatchObject({
        status: "verified",
        verifiedAt: "1970-01-01T00:00:33.000Z",
      });
      expect(Arr.map(verified.records ?? [], (record) => record.state)).toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
        "missing",
        "missing",
        "missing",
      ]);

      yield* publish(api, "custom.example", zoneFor(added));
      expect(states(yield* check(browser, "custom.example"))).toEqual(["ok"]);

      // The MX now points elsewhere: mail no longer reaches SES, so the domain fails.
      yield* publish(api, "custom.example", [
        ...zoneFor(added, (record) => record.purpose === "receiving"),
        { name: "custom.example", type: "MX", data: "10 mx.elsewhere.example" },
      ]);
      const failed = yield* check(browser, "custom.example");
      expect(failed).toMatchObject({
        status: "failed",
        verifiedAt: "1970-01-01T00:00:33.000Z",
      });
      expect(failed.records[1]?.state).toBe("wrong");

      yield* publish(api, "custom.example", zoneFor(added));
      expect(yield* check(browser, "custom.example")).toMatchObject({
        status: "verified",
        verifiedAt: "1970-01-01T00:00:33.000Z",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("answers a repeated check within 10 seconds from the last one", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const browser = yield* signedIn(api, "ada");
      const added = yield* addDomain(browser, "custom.example");
      yield* check(browser, "custom.example");
      yield* publish(api, "custom.example", zoneFor(added));
      const soon = yield* browser.post("/v1/domains/custom.example/check");
      expect(soon.body).toMatchObject({ status: "pending", checkedAt: "1970-01-01T00:00:11.000Z" });
    }).pipe(Effect.scoped),
  );

  it.effect("releases a domain nobody verified within 72 hours", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* signedIn(api, "ada");
      const bob = yield* signedIn(api, "bob");
      yield* addDomain(ada, "squat.example");
      yield* TestClock.adjust(Duration.hours(72));
      expect((yield* checkNow(ada, "squat.example")).status).toBe(404);
      const identity = yield* Effect.result(
        SESV2.getEmailIdentity({ EmailIdentity: "squat.example" }).pipe(
          Effect.provide(api.context),
        ),
      );
      expect(Result.isFailure(identity)).toBe(true);
      // The real owner can add it now.
      yield* addDomain(bob, "squat.example");
    }).pipe(Effect.scoped),
  );

  it.effect("shows, checks, changes and deletes only the caller's domains", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* signedIn(api, "ada");
      const bob = yield* signedIn(api, "bob");
      yield* addDomain(ada, "custom.example");
      const attempts = yield* Effect.all(
        [
          bob.get("/v1/domains/custom.example"),
          bob.post("/v1/domains/custom.example/check"),
          bob.patch("/v1/domains/custom.example", { isCatchAllEnabled: true }),
          bob.delete("/v1/domains/custom.example"),
          ada.get("/v1/domains/missing.example"),
        ],
        { concurrency: 1 },
      );
      expect(Arr.map(attempts, (response) => response.status)).toEqual([404, 404, 404, 404, 404]);
      expect((yield* bob.get("/v1/domains")).body).toEqual([]);
      expect((yield* ada.get("/v1/domains/Custom.Example")).status).toBe(200);
      expect(
        (yield* ada.patch("/v1/domains/custom.example", { isCatchAllEnabled: true })).body,
      ).toMatchObject({
        isCatchAllEnabled: true,
      });
      const signedOut = api.browser();
      expect((yield* signedOut.get("/v1/domains")).status).toBe(401);
    }).pipe(Effect.scoped),
  );

  it.effect("deleting a domain deletes its SES identity and the owner's aliases on it", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* signedIn(api, "ada");
      yield* addDomain(ada, "custom.example");
      const me = yield* ada.get("/v1/me");
      const { userId } = Schema.decodeUnknownSync(Schema.Struct({ userId: Schema.String }))(
        me.body,
      );
      const aliases = yield* AliasRepo.make().pipe(Effect.provide(api.context));
      const insert = (domain: string, localPart: string) =>
        aliases.insert({
          id: `al_${localPart}`,
          userId,
          domain,
          localPart,
          mode: "forward",
          createdAt: 0,
        });
      yield* insert("custom.example", "shop");
      yield* insert("alias.test", "keep");

      expect((yield* ada.delete("/v1/domains/custom.example")).status).toBe(204);
      expect(Arr.map(yield* aliases.listByUser(userId), (alias) => alias.localPart)).toEqual([
        "keep",
      ]);
      expect((yield* ada.get("/v1/domains/custom.example")).status).toBe(404);
      const identity = yield* Effect.result(
        SESV2.getEmailIdentity({ EmailIdentity: "custom.example" }).pipe(
          Effect.provide(api.context),
        ),
      );
      expect(Result.isFailure(identity)).toBe(true);
      yield* addDomain(ada, "custom.example");
    }).pipe(Effect.scoped),
  );

  it.effect("tokens reach domains only with the domains scopes (§20.20)", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* signedIn(api, "ada");
      yield* addDomain(ada, "custom.example");
      const mint = (scopes: ReadonlyArray<string>) =>
        Effect.map(ada.post("/v1/tokens", { name: "cli", scopes }), (created) =>
          api.withToken(
            Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(created.body).token,
          ),
        );
      const reader = yield* mint(["domains:read"]);
      expect((yield* reader.get("/v1/domains")).status).toBe(200);
      expect((yield* reader.get("/v1/domains/custom.example")).status).toBe(200);
      expect(yield* reader.post("/v1/domains", { domain: "other.example" })).toMatchObject({
        status: 403,
        body: { _tag: "Forbidden", scope: "domains:write" },
      });
      expect((yield* reader.post("/v1/domains/custom.example/check")).status).toBe(403);
      const writer = yield* mint(["domains:write"]);
      expect((yield* writer.post("/v1/domains", { domain: "other.example" })).status).toBe(201);
      expect((yield* writer.get("/v1/domains")).status).toBe(403);
      const unrelated = yield* mint(["aliases:read", "aliases:write"]);
      expect((yield* unrelated.get("/v1/domains")).status).toBe(403);
    }).pipe(Effect.scoped),
  );

  it.effect("creates aliases only on the caller's verified custom domains", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* signedIn(api, "ada");
      const bob = yield* signedIn(api, "bob");
      const added = yield* addDomain(ada, "custom.example");
      yield* addDomain(bob, "bob.example");
      const create = (browser: Browser.Client, address: string) =>
        browser.post("/v1/aliases", { _tag: "Address", address, mode: "forward" });

      expect((yield* create(ada, "shop@custom.example")).body).toMatchObject({
        reason: "domain-not-verified",
      });
      expect((yield* create(ada, "shop@bob.example")).body).toMatchObject({
        reason: "unknown-domain",
      });
      expect((yield* ada.get("/v1/aliases/domains")).body).toMatchObject({ custom: [] });

      yield* publish(api, "custom.example", zoneFor(added));
      expect((yield* check(ada, "custom.example")).status).toBe("verified");
      expect(yield* create(ada, "Shop@Custom.Example")).toMatchObject({
        status: 201,
        body: { address: "shop@custom.example" },
      });
      expect((yield* create(bob, "news@custom.example")).body).toMatchObject({
        reason: "unknown-domain",
      });
      expect((yield* ada.get("/v1/aliases/domains")).body).toMatchObject({
        custom: ["custom.example"],
      });
      // Deleting it leaves a tombstone (§20.15): only its owner may create it again.
      expect((yield* ada.delete("/v1/aliases/custom.example/shop")).status).toBe(204);
      expect((yield* create(ada, "shop@custom.example")).status).toBe(201);
    }).pipe(Effect.scoped),
  );

  it.effect("the verification cron checks every due domain", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* signedIn(api, "ada");
      const first = yield* addDomain(ada, "first.example");
      yield* addDomain(ada, "second.example");
      yield* publish(api, "first.example", zoneFor(first));
      const run = DomainVerification.runDue().pipe(
        Effect.provide(DomainRepo.layer),
        Effect.provide(api.context),
      );
      expect(yield* run).toEqual({ checked: 2, failed: 0 });
      const statuses = Arr.map(
        Schema.decodeUnknownSync(Schema.Array(DomainView))((yield* ada.get("/v1/domains")).body),
        (domain) => [domain.domain, domain.status],
      );
      expect(statuses).toEqual([
        ["first.example", "verified"],
        ["second.example", "pending"],
      ]);
      // Nothing is due again until the pending domain's next check, ten minutes on.
      expect(yield* run).toEqual({ checked: 0, failed: 0 });
      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* run).toEqual({ checked: 1, failed: 0 });
    }).pipe(Effect.scoped),
  );
});

describe("DomainVerification.decide (on the documented SES responses)", () => {
  const response = Schema.decodeUnknownSync(Identities.IdentityResponse)(created);
  const pendingIdentity: Identities.DomainIdentity = {
    isVerifiedForSending: response.VerifiedForSendingStatus,
    dkimStatus: response.DkimAttributes.Status,
    dkimTokens: response.DkimAttributes.Tokens,
    dkimZone: Option.fromUndefinedOr(response.DkimAttributes.SigningHostedZone),
  };
  const verifiedIdentity: Identities.DomainIdentity = {
    ...pendingIdentity,
    isVerifiedForSending: true,
    dkimStatus: "SUCCESS",
  };
  const at = (hours: number) => DateTime.makeUnsafe(hours * 3_600_000);
  const domain = (status: DomainRepo.DomainStatus): DomainRepo.Domain => ({
    domain: "custom.example",
    userId: "usr_1",
    status,
    verificationToken: "tok",
    dkimTokens: pendingIdentity.dkimTokens,
    dkimZone: "dkim.amazonses.com",
    isCatchAllEnabled: false,
    createdAt: at(0),
    verifiedAt: status === "pending" ? Option.none() : Option.some(at(1)),
    checkedAt: Option.none(),
    checks: [],
    nextCheckAt: at(0),
  });
  const ses = (identity: Identities.DomainIdentity) => Result.succeed(Option.some(identity));
  const decide = DomainVerification.decide;
  const record = DomainVerification.Decision.Record;

  it("waits for SES while it reports DKIM pending, even with every record published", () => {
    expect(decide(domain("pending"), "ready", ses(pendingIdentity), at(2))).toEqual(
      record({ status: "pending", verifiedAt: Option.none(), isConclusive: true }),
    );
    expect(decide(domain("pending"), "ready", ses(verifiedIdentity), at(2))).toEqual(
      record({ status: "verified", verifiedAt: Option.some(at(2)), isConclusive: true }),
    );
  });

  it("changes nothing when the resolver or SES couldn't answer", () => {
    expect(decide(domain("verified"), "inconclusive", ses(verifiedIdentity), at(2))).toEqual(
      record({ status: "verified", verifiedAt: Option.some(at(1)), isConclusive: false }),
    );
    expect(decide(domain("verified"), "ready", Result.fail("unavailable"), at(2))).toEqual(
      record({ status: "verified", verifiedAt: Option.some(at(1)), isConclusive: false }),
    );
    expect(
      decide(
        domain("verified"),
        "ready",
        ses({ ...verifiedIdentity, dkimStatus: "TEMPORARY_FAILURE" }),
        at(2),
      ),
    ).toEqual(record({ status: "verified", verifiedAt: Option.some(at(1)), isConclusive: false }));
  });

  it("fails a verified domain whose records or SES verification are gone", () => {
    expect(decide(domain("verified"), "not-ready", ses(verifiedIdentity), at(2))).toEqual(
      record({ status: "failed", verifiedAt: Option.some(at(1)), isConclusive: true }),
    );
    expect(
      decide(
        domain("verified"),
        "ready",
        ses({ ...verifiedIdentity, dkimStatus: "FAILED" }),
        at(2),
      ),
    ).toEqual(record({ status: "failed", verifiedAt: Option.some(at(1)), isConclusive: true }));
    expect(decide(domain("verified"), "ready", Result.succeed(Option.none()), at(2))).toEqual(
      record({ status: "failed", verifiedAt: Option.some(at(1)), isConclusive: true }),
    );
  });

  it("releases a pending domain after 72 hours", () => {
    expect(decide(domain("pending"), "not-ready", ses(pendingIdentity), at(71))).toEqual(
      record({ status: "pending", verifiedAt: Option.none(), isConclusive: true }),
    );
    expect(decide(domain("pending"), "not-ready", ses(pendingIdentity), at(72))).toEqual(
      DomainVerification.Decision.Expire({ deadline: at(72) }),
    );
  });
});
