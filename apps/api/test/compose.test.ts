import { FakeCloud } from "@alias/aws-emulators";
import { Keyring, ReverseToken } from "@alias/core";
import { ContactRepo, OutboxRepo } from "@alias/db";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import { AwsClient } from "@alias/aws";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestApi from "./support/TestApi.ts";

/**
 * New mail from an alias (PLAN.md §20.33): composed in the web app to any address, and contacts
 * the owner adds to write to through their reverse alias. API handler on fakecloud.
 */

const Created = Schema.Struct({ id: Schema.String, address: Schema.String });
const Added = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  replyAddress: Schema.String,
});

/** Ada with a random alias on the shared domain, verified on fakecloud. */
const setUp = Effect.fn("setUp")(function* () {
  const api = yield* TestApi.make;
  const ada = yield* TestApi.signedIn(api.browser, "ada");
  const created = yield* ada.browser.post("/v1/aliases", {
    _tag: "Random",
    domain: "alias.test",
    mode: "forward",
  });
  const alias = Schema.decodeUnknownSync(Created)(created.body);
  const [local = "", domain = ""] = alias.address.split("@");
  return { api, ada, alias, path: `/v1/aliases/${domain}/${local}` };
});

type Setup = Effect.Success<ReturnType<typeof setUp>>;

const mail = (setup: Setup, to: string) => ({
  from: setup.alias.address,
  to,
  subject: "Hello",
  text: "First message from my alias.",
});

/** What fakecloud's SES accepted, as text. */
const sentMail = (setup: Setup) =>
  FakeCloud.sentEmails().pipe(
    Effect.map((emails) =>
      Arr.map(emails, (email) => ({
        from: email.from,
        to: email.to,
        raw: Option.match(email.raw, {
          onNone: () => "",
          onSome: (raw) => new TextDecoder().decode(raw),
        }),
      })),
    ),
    Effect.provide(setup.api.context),
  );

const inContext = <A, E>(
  setup: Setup,
  effect: Effect.Effect<A, E, OutboxRepo.OutboxRepo | ContactRepo.ContactRepo>,
) =>
  Layer.build(Layer.merge(OutboxRepo.layer, ContactRepo.layer)).pipe(
    Effect.flatMap((context) => Effect.provide(effect, context)),
    Effect.provide(setup.api.context),
  );

describe("compose (API handler on fakecloud)", () => {
  it.effect("sends new mail from the alias to a new address, which becomes a contact", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const sent = yield* setup.ada.browser.post(
        "/v1/outbox",
        mail(setup, "Grace@Elsewhere.example"),
      );
      expect(sent).toMatchObject({
        status: 200,
        body: {
          from: setup.alias.address,
          to: "grace@elsewhere.example",
          subject: "Hello",
          status: "sent",
        },
      });
      const [email, ...more] = yield* sentMail(setup);
      expect(more).toEqual([]);
      expect(email?.from).toBe(setup.alias.address);
      expect(email?.to).toEqual(["grace@elsewhere.example"]);
      expect(email?.raw).toContain(`From: ${setup.alias.address}\r\n`);
      expect(email?.raw).toContain(Buffer.from("First message from my alias.").toString("base64"));
      // Nothing names the owner: not their username, not the service's accounts.
      expect(email?.raw).not.toMatch(/ada/i);

      const contacts = yield* setup.ada.browser.get(`${setup.path}/contacts`);
      expect(contacts.body).toMatchObject([
        { address: "grace@elsewhere.example", isBlocked: false },
      ]);
      // Writing again goes to the same contact.
      yield* setup.ada.browser.post("/v1/outbox", mail(setup, "grace@elsewhere.example"));
      expect((yield* setup.ada.browser.get(`${setup.path}/contacts`)).body).toHaveLength(1);
      expect(yield* sentMail(setup)).toHaveLength(2);
    }),
  );

  it.effect("refuses other users' aliases, inactive ones, bad addresses and blocked contacts", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const grace = yield* TestApi.signedIn(setup.api.browser, "grace");
      expect(
        yield* grace.browser.post("/v1/outbox", mail(setup, "x@elsewhere.example")),
      ).toMatchObject({
        status: 422,
        body: { _tag: "ComposeRefused", reason: "unknown-alias" },
      });
      expect(
        yield* setup.ada.browser.post("/v1/outbox", mail(setup, "not an address")),
      ).toMatchObject({
        status: 422,
        body: { reason: "invalid-address" },
      });
      expect(
        (yield* setup.ada.browser.post("/v1/outbox", {
          ...mail(setup, "x@elsewhere.example"),
          subject: "",
        })).status,
      ).toBe(400);

      yield* setup.ada.browser.post("/v1/outbox", mail(setup, "spam@elsewhere.example"));
      const [contact] = Schema.decodeUnknownSync(Schema.Array(Created))(
        (yield* setup.ada.browser.get(`${setup.path}/contacts`)).body,
      );
      yield* setup.ada.browser.patch(`${setup.path}/contacts/${contact?.id}`, { isBlocked: true });
      expect(
        yield* setup.ada.browser.post("/v1/outbox", mail(setup, "spam@elsewhere.example")),
      ).toMatchObject({
        status: 422,
        body: { reason: "blocked-contact" },
      });

      yield* setup.ada.browser.patch(setup.path, { isActive: false });
      expect(
        yield* setup.ada.browser.post("/v1/outbox", mail(setup, "x@elsewhere.example")),
      ).toMatchObject({
        status: 422,
        body: { reason: "inactive-alias" },
      });
      expect(yield* sentMail(setup)).toHaveLength(1);
    }),
  );

  it.effect("refuses a suppressed address and leaves the draft pending", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const { url } = yield* Effect.provide(Effect.service(FakeCloud.FakeCloud), setup.api.context);
      yield* SESV2.putSuppressedDestination({
        EmailAddress: "gone@elsewhere.example",
        Reason: "BOUNCE",
      }).pipe(Effect.provide(AwsClient.emulator(url)));
      const refused = yield* setup.ada.browser.post(
        "/v1/outbox",
        mail(setup, "gone@elsewhere.example"),
      );
      expect(refused).toMatchObject({
        status: 422,
        body: { _tag: "SendFailed", reason: "suppressed", isRetryable: false },
      });
      const { draftId } = Schema.decodeUnknownSync(Schema.Struct({ draftId: Schema.String }))(
        refused.body,
      );
      expect((yield* setup.ada.browser.get(`/v1/outbox/${draftId}`)).body).toMatchObject({
        status: "pending",
        clientName: "you, in Alias",
      });
      expect(yield* sentMail(setup)).toEqual([]);
    }),
  );

  it.effect("caps new recipients and sends per day; known contacts spend no new recipient", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      yield* setup.ada.browser.post("/v1/outbox", mail(setup, "known@elsewhere.example"));
      const now = yield* DateTime.now;
      yield* inContext(
        setup,
        OutboxRepo.OutboxRepo.use((repo) =>
          Effect.forEach(
            Arr.range(2, OutboxRepo.NEW_RECIPIENTS_PER_DAY),
            () => repo.reserveRecipient(setup.ada.userId, now, OutboxRepo.NEW_RECIPIENTS_PER_DAY),
            { concurrency: 4 },
          ),
        ),
      );
      expect(
        yield* setup.ada.browser.post("/v1/outbox", mail(setup, "new@elsewhere.example")),
      ).toMatchObject({
        status: 422,
        body: { reason: "recipient-limit" },
      });
      expect(
        yield* setup.ada.browser.post(`${setup.path}/contacts`, {
          address: "new@elsewhere.example",
        }),
      ).toMatchObject({ status: 422, body: { _tag: "InvalidContact", reason: "recipient-limit" } });
      expect(
        (yield* setup.ada.browser.post("/v1/outbox", mail(setup, "known@elsewhere.example")))
          .status,
      ).toBe(200);

      // Sends share one allowance with replies and drafts.
      yield* inContext(
        setup,
        OutboxRepo.OutboxRepo.use((repo) =>
          Effect.forEach(
            Arr.range(3, OutboxRepo.SENDS_PER_DAY),
            () => repo.reserveSend(setup.ada.userId, now, OutboxRepo.SENDS_PER_DAY),
            { concurrency: 10 },
          ),
        ),
      );
      expect(
        yield* setup.ada.browser.post("/v1/outbox", mail(setup, "known@elsewhere.example")),
      ).toMatchObject({
        status: 422,
        body: { reason: "limit-reached" },
      });
      expect(yield* sentMail(setup)).toHaveLength(2);
    }),
  );

  // The blocklist (PLAN.md §20.32) drops mail from an address and replies to it; mail the owner
  // writes to it is refused as well, also to a contact it was before.
  it.effect("refuses addresses the owner's blocklist names, new or known", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      expect(
        (yield* setup.ada.browser.post("/v1/blocklist", { kind: "domain", value: "spam.example" }))
          .status,
      ).toBeLessThan(300);
      expect(
        yield* setup.ada.browser.post("/v1/outbox", mail(setup, "x@spam.example")),
      ).toMatchObject({
        status: 422,
        body: { _tag: "ComposeRefused", reason: "blocked-address" },
      });
      expect(
        yield* setup.ada.browser.post(`${setup.path}/contacts`, { address: "y@spam.example" }),
      ).toMatchObject({ status: 422, body: { _tag: "InvalidContact", reason: "blocked-address" } });
      // A contact written to before it was blocked gets nothing more.
      yield* setup.ada.browser.post("/v1/outbox", mail(setup, "z@later.example"));
      yield* setup.ada.browser.post("/v1/blocklist", { kind: "address", value: "z@later.example" });
      const refused = yield* setup.ada.browser.post("/v1/outbox", mail(setup, "z@later.example"));
      expect(refused).toMatchObject({ status: 422, body: { reason: "blocked-address" } });
      expect(Arr.map(yield* sentMail(setup), (email) => email.to)).toEqual([["z@later.example"]]);
    }),
  );

  it.effect("is session-only: no token sends, whatever its scopes", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const created = yield* setup.ada.browser.post("/v1/tokens", {
        name: "everything",
        scopes: ["aliases:write", "contacts:write", "mail:send"],
      });
      const token = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(created.body);
      const client = setup.api.withToken(token.token);
      expect(yield* client.post("/v1/outbox", mail(setup, "x@elsewhere.example"))).toMatchObject({
        status: 403,
      });
      expect(yield* sentMail(setup)).toEqual([]);
    }),
  );
});

describe("contacts the owner adds (API handler on fakecloud)", () => {
  it.effect("adds a contact once and returns its reverse alias, signed for that contact", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const first = yield* setup.ada.browser.post(`${setup.path}/contacts`, {
        address: "Grace@Elsewhere.example",
      });
      expect(first.status).toBe(200);
      const added = Schema.decodeUnknownSync(Added)(first.body);
      expect(added.address).toBe("grace@elsewhere.example");
      const [local = "", domain = ""] = setup.alias.address.split("@");
      expect(added.replyAddress).toMatch(
        new RegExp(`^${local}\\+r\\.[a-z2-7]+@${domain.replace(".", "\\.")}$`),
      );
      const token = added.replyAddress.slice(local.length + 3, added.replyAddress.indexOf("@"));
      const claims = yield* ReverseToken.verify(
        yield* Keyring.parse(TestApi.reverseKeys).pipe(Effect.provide(NodeCrypto.layer)),
        { local, domain },
        token,
      ).pipe(Effect.provide(NodeCrypto.layer));
      expect(claims.contactId).toBe(added.id);
      // Again: the same contact and address, and no second contact.
      const again = Schema.decodeUnknownSync(Added)(
        (yield* setup.ada.browser.post(`${setup.path}/contacts`, {
          address: "grace@elsewhere.example",
        })).body,
      );
      expect(again).toEqual(added);
      expect((yield* setup.ada.browser.get(`${setup.path}/contacts`)).body).toHaveLength(1);
      // Nothing is sent by adding.
      expect(yield* sentMail(setup)).toEqual([]);
    }),
  );

  it.effect("needs contacts:write, the caller's alias and a real address", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const mint = (scopes: ReadonlyArray<string>) =>
        Effect.map(setup.ada.browser.post("/v1/tokens", { name: "t", scopes }), (created) =>
          setup.api.withToken(
            Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(created.body).token,
          ),
        );
      const reader = yield* mint(["contacts:read"]);
      expect(
        (yield* reader.post(`${setup.path}/contacts`, { address: "a@elsewhere.example" })).status,
      ).toBe(403);
      const writer = yield* mint(["contacts:write"]);
      expect(
        (yield* writer.post(`${setup.path}/contacts`, { address: "a@elsewhere.example" })).status,
      ).toBe(200);
      expect(yield* writer.post(`${setup.path}/contacts`, { address: "nope" })).toMatchObject({
        status: 422,
        body: { reason: "invalid-address" },
      });
      const grace = yield* TestApi.signedIn(setup.api.browser, "grace");
      expect(
        (yield* grace.browser.post(`${setup.path}/contacts`, { address: "a@elsewhere.example" }))
          .status,
      ).toBe(404);
    }),
  );
});
