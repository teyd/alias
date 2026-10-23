import { AwsClient, Objects } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { AliasRepo, FailureRepo, RecipientRepo } from "@alias/db";
import { Inbox } from "@alias/inbox";
import { TestInbox } from "@alias/inbox/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as TestApi from "./support/TestApi.ts";

/**
 * Failed deliveries (PLAN.md §20.33) over the API: listed, downloaded, sent again and deleted.
 * The inbound Lambda records them (`apps/inbound` tests); here they are written the way it does,
 * on the API's own table and inbox bucket.
 */

const forwarded = new TextEncoder().encode(
  [
    'From: "Shop (shop@store.example)" <REVERSE>',
    "Reply-To: REVERSE",
    "To: ALIAS",
    "Subject: Order confirmed",
    "",
    "Thanks for your order!",
    "",
  ].join("\r\n"),
);

const Created = Schema.Struct({ id: Schema.String, address: Schema.String });

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
  const envelopeFrom = `${local}+r.token@${domain}`;
  const raw = new TextEncoder().encode(
    new TextDecoder()
      .decode(forwarded)
      .replaceAll("REVERSE", envelopeFrom)
      .replaceAll("ALIAS", alias.address),
  );
  const repos = Layer.mergeAll(FailureRepo.layer, RecipientRepo.layer, AliasRepo.layer);

  /** Records a failure as the inbound pipeline does, with a kept copy unless `isKept` is false. */
  const fail = (id: string, isKept = true) =>
    Effect.gen(function* () {
      const stored = yield* Effect.fromOption(
        yield* (yield* AliasRepo.AliasRepo).findByAddress(domain, local),
      );
      const now = yield* DateTime.now;
      const kept = isKept
        ? Option.some({
            ...(yield* (yield* Inbox.Inbox).keep(stored, id, raw)),
            envelopeFrom,
          })
        : Option.none();
      yield* (yield* FailureRepo.FailureRepo).insert(
        {
          id,
          aliasId: stored.id,
          userId: stored.userId,
          alias: alias.address,
          sender: Option.some("shop@store.example"),
          reason: "recipient-bounced",
          receivedAt: now,
          expiresAt: DateTime.add(now, { days: 7 }),
          size: 1_234,
          kept,
        },
        stored,
      );
    }).pipe(Effect.provide(repos), Effect.provide(api.context));

  /** A verified default forwarding address for Ada. */
  const recipient = (address: string) =>
    Effect.gen(function* () {
      const repo = yield* RecipientRepo.RecipientRepo;
      const now = yield* DateTime.now;
      const added = { id: `rcp_${address}`, userId: ada.userId, address, createdAt: now };
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
    }).pipe(Effect.provide(repos), Effect.provide(api.context));

  const objects = Effect.gen(function* () {
    const { bucket } = yield* TestInbox;
    const { url } = yield* FakeCloud.FakeCloud;
    return yield* Objects.keys(bucket, "inbox/").pipe(Effect.provide(AwsClient.emulator(url)));
  }).pipe(Effect.provide(api.context));

  const sent = FakeCloud.sentEmails().pipe(Effect.provide(api.context));

  return { api, ada, alias, raw, envelopeFrom, fail, recipient, objects, sent, local, domain };
});

describe("failed deliveries (API handler on fakecloud)", () => {
  it.effect("lists the owner's failures with metadata only, and only to them", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      yield* setup.fail("fail_01a", false);
      yield* setup.fail("fail_01b");
      const listed = yield* setup.ada.browser.get("/v1/failed-deliveries");
      expect(listed).toMatchObject({
        status: 200,
        body: [
          {
            alias: setup.alias.address,
            sender: "shop@store.example",
            reason: "recipient-bounced",
            size: 1_234,
          },
          { reason: "recipient-bounced" },
        ],
      });
      const body = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ id: Schema.String, isKept: Schema.Boolean })),
      )(listed.body);
      expect(
        Arr.sort(
          Arr.map(body, (failure) => [failure.id, failure.isKept] as const),
          Order.mapInput(Order.String, ([id]: readonly [string, boolean]) => id),
        ),
      ).toEqual([
        ["fail_01a", false],
        ["fail_01b", true],
      ]);
      // Nothing of the message itself is listed.
      expect(JSON.stringify(listed.body)).not.toContain("Order confirmed");

      const grace = yield* TestApi.signedIn(setup.api.browser, "grace");
      expect((yield* grace.browser.get("/v1/failed-deliveries")).body).toEqual([]);
      expect((yield* grace.browser.get("/v1/failed-deliveries/fail_01b/message")).status).toBe(404);
      expect((yield* grace.browser.post("/v1/failed-deliveries/fail_01b/resend")).status).toBe(404);
      expect((yield* grace.browser.delete("/v1/failed-deliveries/fail_01b")).status).toBe(404);
    }),
  );

  it.effect("downloads the kept copy as message/rfc822; without one there is nothing", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      yield* setup.fail("fail_01a", false);
      yield* setup.fail("fail_01b");
      const download = yield* setup.ada.browser.get("/v1/failed-deliveries/fail_01b/message");
      expect(download.status).toBe(200);
      expect(download.headers["content-type"]).toBe("message/rfc822");
      expect(download.bytes).toEqual(setup.raw);
      expect(yield* setup.ada.browser.get("/v1/failed-deliveries/fail_01a/message")).toMatchObject({
        status: 422,
        body: { _tag: "ResendFailed", reason: "not-kept" },
      });
    }),
  );

  it.effect("sends the kept copy again to the forwarding address, then forgets it", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      yield* setup.fail("fail_01a");
      expect(yield* setup.ada.browser.post("/v1/failed-deliveries/fail_01a/resend")).toMatchObject({
        status: 422,
        body: { reason: "no-recipient" },
      });
      yield* setup.recipient("ada@mail.example");
      expect((yield* setup.ada.browser.post("/v1/failed-deliveries/fail_01a/resend")).status).toBe(
        204,
      );
      const [email, ...more] = yield* setup.sent;
      expect(more).toEqual([]);
      expect(email?.from).toBe(setup.envelopeFrom);
      expect(email?.to).toEqual(["ada@mail.example"]);
      expect(email?.raw).toEqual(Option.some(setup.raw));
      // Delivered: the failure and its copy are gone, and the alias counts the forward.
      expect((yield* setup.ada.browser.get("/v1/failed-deliveries")).body).toEqual([]);
      expect(yield* setup.objects).toEqual([]);
      expect(
        (yield* setup.ada.browser.get(`/v1/aliases/${setup.domain}/${setup.local}`)).body,
      ).toMatchObject({ forwardedCount: 1 });
      expect((yield* setup.ada.browser.post("/v1/failed-deliveries/fail_01a/resend")).status).toBe(
        404,
      );
    }),
  );

  it.effect("refuses to send again while the address is paused or the alias is off", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      yield* setup.fail("fail_01a");
      yield* setup.recipient("ada@mail.example");
      yield* RecipientRepo.RecipientRepo.use((repo) =>
        repo.markBounced(
          setup.ada.userId,
          "ada@mail.example",
          DateTime.makeUnsafe(1),
          "address-unknown",
        ),
      ).pipe(Effect.provide(RecipientRepo.layer), Effect.provide(setup.api.context));
      expect(yield* setup.ada.browser.post("/v1/failed-deliveries/fail_01a/resend")).toMatchObject({
        status: 422,
        body: { reason: "recipient-bounced" },
      });
      yield* setup.ada.browser.patch(`/v1/aliases/${setup.domain}/${setup.local}`, {
        isActive: false,
      });
      expect(yield* setup.ada.browser.post("/v1/failed-deliveries/fail_01a/resend")).toMatchObject({
        status: 422,
        body: { reason: "inactive-alias" },
      });
      expect(yield* setup.sent).toEqual([]);
    }),
  );

  it.effect("deletes a failure with its copy; deleting the alias takes the rest", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      yield* setup.fail("fail_01a");
      yield* setup.fail("fail_01b");
      expect((yield* setup.ada.browser.delete("/v1/failed-deliveries/fail_01a")).status).toBe(204);
      expect((yield* setup.ada.browser.delete("/v1/failed-deliveries/fail_01a")).status).toBe(404);
      expect(yield* setup.objects).toHaveLength(1);
      expect(
        (yield* setup.ada.browser.delete(`/v1/aliases/${setup.domain}/${setup.local}`)).status,
      ).toBe(204);
      expect((yield* setup.ada.browser.get("/v1/failed-deliveries")).body).toEqual([]);
      expect(yield* setup.objects).toEqual([]);
    }),
  );

  it.effect("opens to tokens with deliveries:read and deliveries:write only", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      yield* setup.fail("fail_01a");
      const mint = (scopes: ReadonlyArray<string>) =>
        Effect.map(setup.ada.browser.post("/v1/tokens", { name: "t", scopes }), (created) =>
          setup.api.withToken(
            Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(created.body).token,
          ),
        );
      const other = yield* mint(["aliases:read", "inboxes:read"]);
      expect((yield* other.get("/v1/failed-deliveries")).status).toBe(403);
      const reader = yield* mint(["deliveries:read"]);
      expect((yield* reader.get("/v1/failed-deliveries")).body).toHaveLength(1);
      expect((yield* reader.get("/v1/failed-deliveries/fail_01a/message")).status).toBe(200);
      expect((yield* reader.delete("/v1/failed-deliveries/fail_01a")).status).toBe(403);
      const writer = yield* mint(["deliveries:write"]);
      expect((yield* writer.delete("/v1/failed-deliveries/fail_01a")).status).toBe(204);
    }),
  );
});
