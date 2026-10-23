import { Transport } from "@alias/aws";
import { Dynamo, RecipientRepo, SentRepo } from "@alias/db";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Hex } from "effect/encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { NodeCrypto } from "@effect/platform-node";
import * as openpgp from "openpgp";
import { CONFIRMATION_MAILS_PER_DAY, MAX_PENDING_RECIPIENTS } from "../src/recipients.ts";
import * as Browser from "./support/Browser.ts";
import { TestAuthenticator } from "./support/index.ts";
import {
  add,
  addRecipient,
  addVerified,
  confirm,
  lastMailTo,
  mailsTo,
  Recipient,
} from "./support/Recipients.ts";
import * as TestApi from "./support/TestApi.ts";

type Api = Effect.Success<typeof TestApi.make>;

const Me = Schema.Struct({ userId: Schema.String, username: Schema.String });

/** A signed-in browser for a new user. */
const signedIn = Effect.fn("signedIn")(function* (api: Api, username: string) {
  const browser = api.browser();
  const registered = yield* TestApi.signUp(
    browser,
    TestAuthenticator.make(Browser.origin),
    username,
  );
  return { browser, me: Schema.decodeUnknownSync(Me)(registered.body) };
});

const list = (browser: Browser.Client) =>
  Effect.map(browser.get("/v1/recipients"), (response) =>
    Schema.decodeUnknownSync(Schema.Array(Recipient))(response.body),
  );

describe("forwarding addresses (recipients) on the API handler, fakecloud DynamoDB and SES", () => {
  it.effect(
    "mails a confirmation link that arrives in fakecloud SES and verifies the address",
    () =>
      Effect.gen(function* () {
        const api = yield* TestApi.make;
        const { browser } = yield* signedIn(api, "ada");

        const added = yield* addRecipient(browser, "Ada@Example.com");
        expect(added).toEqual({
          id: expect.stringMatching(/^rcp_[0-9a-z]{26}$/),
          address: "ada@example.com",
          isVerified: false,
          isDefault: false,
          createdAt: "1970-01-01T00:00:00.000Z",
        });

        const mails = yield* mailsTo(api, "ada@example.com");
        expect(mails).toHaveLength(1);
        const [mail] = mails;
        if (mail === undefined) return;
        // Sent from the shared domain the SES dev setup verifies, to the new address only.
        expect(mail.email.from).toBe("no-reply@alias.test");
        expect(mail.email.to).toEqual(["ada@example.com"]);
        expect(mail.text).toContain("From: Alias <no-reply@alias.test>\r\n");
        expect(mail.text).toContain("To: <ada@example.com>\r\n");
        expect(mail.text).toContain("Subject: Confirm your forwarding address\r\n");
        expect(mail.text).toContain('The Alias account "ada" wants to forward mail');
        expect(mail.text).toContain("within 24 hours");
        expect(mail.recipientId).toBe(added.id);
        expect(mail.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const confirmed = yield* confirm(browser, added.id, mail.token);
        expect(confirmed).toMatchObject({
          status: 200,
          body: { id: added.id, isVerified: true, isDefault: true },
        });
        expect(yield* list(browser)).toMatchObject([{ id: added.id, isVerified: true }]);
      }).pipe(Effect.scoped),
  );

  it.effect("stores only a hash of the token, and each token works once", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "grace");
      const added = yield* addRecipient(browser, "grace@example.com");
      const { token } = yield* lastMailTo(api, "grace@example.com");

      const { name } = yield* Effect.provide(Effect.service(Dynamo.DynamoTable), api.context);
      const table = JSON.stringify(
        yield* DynamoDB.scan({ TableName: name }).pipe(Effect.provide(api.context)),
      );
      const crypto = yield* Crypto.Crypto;
      const hash = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(token)));
      expect(table).not.toContain(token);
      expect(table).toContain(hash);

      const rejected = { status: 400, body: { _tag: "ConfirmationRejected" } };
      expect(yield* confirm(browser, added.id, "not-the-token")).toMatchObject(rejected);
      expect((yield* confirm(browser, added.id, token)).status).toBe(200);
      expect(yield* confirm(browser, added.id, token)).toMatchObject(rejected);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("expires a link after 24 hours; a resend replaces it", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "edsger");
      const added = yield* addRecipient(browser, "edsger@example.com");
      const first = yield* lastMailTo(api, "edsger@example.com");

      yield* TestClock.adjust("24 hours");
      expect(yield* confirm(browser, added.id, first.token)).toMatchObject({
        status: 400,
        body: { _tag: "ConfirmationRejected" },
      });

      expect((yield* browser.post(`/v1/recipients/${added.id}/resend`)).status).toBe(204);
      const second = yield* lastMailTo(api, "edsger@example.com");
      expect(second.token).not.toBe(first.token);
      expect((yield* confirm(browser, added.id, first.token)).status).toBe(400);
      expect((yield* confirm(browser, added.id, second.token)).status).toBe(200);
      expect(yield* browser.post(`/v1/recipients/${added.id}/resend`)).toMatchObject({
        status: 409,
        body: { _tag: "RecipientAlreadyVerified" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("rate-limits mail: one resend a minute, and a daily allowance per user", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "barbara");
      const added = yield* addRecipient(browser, "barbara@example.com");
      const resend = browser.post(`/v1/recipients/${added.id}/resend`);

      expect(yield* resend).toMatchObject({
        status: 429,
        body: { _tag: "ConfirmationRateLimited", retryAfterSeconds: 60 },
      });
      yield* TestClock.adjust("59 seconds");
      expect(yield* resend).toMatchObject({ status: 429, body: { retryAfterSeconds: 1 } });
      yield* TestClock.adjust("1 second");
      expect((yield* resend).status).toBe(204);

      // The add and that resend were two mails; use up the rest of today's allowance.
      yield* Effect.forEach(
        Arr.range(3, CONFIRMATION_MAILS_PER_DAY),
        () =>
          TestClock.adjust("1 minute").pipe(
            Effect.andThen(resend),
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(204))),
          ),
        { concurrency: 1 },
      );
      expect(yield* mailsTo(api, "barbara@example.com")).toHaveLength(CONFIRMATION_MAILS_PER_DAY);
      yield* TestClock.adjust("1 minute");
      const elapsedSeconds = 60 * CONFIRMATION_MAILS_PER_DAY;
      expect(yield* resend).toMatchObject({
        status: 429,
        body: { retryAfterSeconds: 24 * 60 * 60 - elapsedSeconds },
      });
      // Adding another address counts too, and leaves nothing behind.
      expect((yield* add(browser, "other@example.com")).status).toBe(429);
      expect(yield* list(browser)).toHaveLength(1);

      yield* TestClock.adjust("1 day");
      expect((yield* resend).status).toBe(204);
    }).pipe(Effect.scoped),
  );

  it.effect(`allows at most ${MAX_PENDING_RECIPIENTS} unverified addresses at a time`, () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "linus");
      const pending = yield* Effect.forEach(
        Arr.range(1, MAX_PENDING_RECIPIENTS),
        (n) => addRecipient(browser, `linus${n}@example.com`),
        { concurrency: 1 },
      );
      expect(yield* add(browser, "one-more@example.com")).toMatchObject({
        status: 409,
        body: { _tag: "TooManyPendingRecipients", limit: MAX_PENDING_RECIPIENTS },
      });

      // Confirming one frees its slot.
      const first = yield* Effect.fromOption(Arr.head(pending));
      const { token } = yield* lastMailTo(api, first.address);
      expect((yield* confirm(browser, first.id, token)).status).toBe(200);
      expect((yield* add(browser, "one-more@example.com")).status).toBe(201);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects malformed addresses, our own domains and duplicates", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "alan");
      expect(yield* add(browser, "not an address")).toMatchObject({
        status: 400,
        body: { _tag: "InvalidRecipientAddress", reason: "invalid" },
      });
      // Forwarding to an alias would loop: the shared domain and every user subdomain.
      const own = yield* Effect.forEach(
        ["shop@alias.test", "x@alan.alias.test"],
        (address) => add(browser, address),
        { concurrency: 1 },
      );
      expect(own).toMatchObject([
        { status: 400, body: { reason: "alias-domain" } },
        { status: 400, body: { reason: "alias-domain" } },
      ]);
      yield* addRecipient(browser, "alan@example.com");
      expect(yield* add(browser, " ALAN@example.COM ")).toMatchObject({
        status: 409,
        body: { _tag: "RecipientExists", address: "alan@example.com" },
      });
      expect(yield* mailsTo(api, "alan@example.com")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps nothing when SES refuses the confirmation mail or can't send now", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "margaret");
      // SES refuses to send as an identity that isn't verified (any more).
      yield* SESV2.deleteEmailIdentity({ EmailIdentity: "alias.test" }).pipe(
        Effect.provide(api.context),
      );
      expect(yield* add(browser, "margaret@example.com")).toMatchObject({
        status: 422,
        body: { _tag: "ConfirmationUndeliverable", address: "margaret@example.com" },
      });

      yield* Transport.ensureIdentity("alias.test").pipe(Effect.provide(api.context));
      yield* SESV2.putAccountSendingAttributes({ SendingEnabled: false }).pipe(
        Effect.provide(api.context),
      );
      expect(yield* add(browser, "margaret@example.com")).toMatchObject({
        status: 503,
        body: { _tag: "MailUnavailable" },
      });
      expect(yield* list(browser)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("takes a bounced address off the suppression list when it is added again", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "grace");
      yield* SESV2.putSuppressedDestination({
        EmailAddress: "bounced@example.com",
        Reason: "BOUNCE",
      }).pipe(Effect.provide(api.context));

      expect(yield* add(browser, "bounced@example.com")).toMatchObject({ status: 201 });
      const gone = yield* Effect.flip(
        SESV2.getSuppressedDestination({ EmailAddress: "bounced@example.com" }),
      ).pipe(Effect.provide(api.context));
      expect(gone._tag).toBe("NotFoundException");
      const [listed] = yield* list(browser);
      expect(listed).not.toHaveProperty("bouncedAt");
    }).pipe(Effect.scoped),
  );

  it.effect("resumes a paused destination once the owner confirms a new link", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser, me } = yield* signedIn(api, "barbara");
      const added = yield* addVerified(api, browser, "barbara@example.com");
      const resend = () => browser.post(`/v1/recipients/${added.id}/resend`);
      // Each confirmation mail is recorded, so its bounces can be traced to this recipient.
      const first = yield* lastMailTo(api, "barbara@example.com");
      expect(
        yield* SentRepo.SentRepo.use((repo) => repo.find(me.userId, first.email.messageId)).pipe(
          Effect.provide(SentRepo.layer.pipe(Layer.provide(Layer.succeedContext(api.context)))),
        ),
      ).toEqual(
        Option.some({
          messageId: first.email.messageId,
          userId: me.userId,
          kind: "confirmation",
          recipientId: Option.some(added.id),
          sentAt: expect.anything(),
        }),
      );

      // The feedback Lambda paused it, and SES has the address suppressed.
      yield* RecipientRepo.RecipientRepo.use((repo) =>
        repo.markBounced(
          me.userId,
          "barbara@example.com",
          DateTime.makeUnsafe(0),
          "address-unknown",
        ),
      ).pipe(
        Effect.provide(RecipientRepo.layer.pipe(Layer.provide(Layer.succeedContext(api.context)))),
      );
      yield* SESV2.putSuppressedDestination({
        EmailAddress: "barbara@example.com",
        Reason: "BOUNCE",
      }).pipe(Effect.provide(api.context));
      expect((yield* browser.get("/v1/recipients")).body).toMatchObject([
        { isVerified: true, bouncedAt: expect.any(String), bounceReason: "address-unknown" },
      ]);

      yield* TestClock.adjust("1 minute");
      expect((yield* resend()).status).toBe(204);
      const mail = yield* lastMailTo(api, "barbara@example.com");
      expect(mail.token).not.toBe(first.token);
      // Off the suppression list for the new link, but still paused until it is opened.
      const gone = yield* Effect.flip(
        SESV2.getSuppressedDestination({ EmailAddress: "barbara@example.com" }),
      ).pipe(Effect.provide(api.context));
      expect(gone._tag).toBe("NotFoundException");
      expect((yield* browser.get("/v1/recipients")).body).toMatchObject([
        { bouncedAt: expect.any(String) },
      ]);

      expect(yield* confirm(browser, added.id, mail.token)).toMatchObject({
        status: 200,
        body: { id: added.id, isVerified: true, isDefault: true },
      });
      expect((yield* browser.get("/v1/recipients")).body).toEqual([
        expect.not.objectContaining({ bouncedAt: expect.anything() }),
      ]);
      expect((yield* browser.get("/v1/recipients")).body).toEqual([
        expect.not.objectContaining({ bounceReason: expect.anything() }),
      ]);
      yield* TestClock.adjust("1 minute");
      expect(yield* resend()).toMatchObject({
        status: 409,
        body: { _tag: "RecipientAlreadyVerified" },
      });
    }).pipe(Effect.scoped),
  );

  it.effect("picks the oldest verified address as default until the user chooses", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "ken");
      const first = yield* addVerified(api, browser, "ken@example.com");
      yield* TestClock.adjust("1 second");
      const second = yield* addVerified(api, browser, "ken@example.org");
      yield* TestClock.adjust("1 second");
      const pending = yield* addRecipient(browser, "ken@example.net");
      const defaults = Effect.map(list(browser), (rows) =>
        Arr.map(
          Arr.filter(rows, (row) => row.isDefault),
          (row) => row.id,
        ),
      );
      expect(yield* defaults).toEqual([first.id]);

      expect((yield* browser.post(`/v1/recipients/${second.id}/default`)).status).toBe(204);
      expect(yield* defaults).toEqual([second.id]);
      expect(yield* browser.post(`/v1/recipients/${pending.id}/default`)).toMatchObject({
        status: 409,
        body: { _tag: "RecipientNotVerified" },
      });

      expect((yield* browser.delete(`/v1/recipients/${second.id}`)).status).toBe(204);
      expect(yield* defaults).toEqual([first.id]);
      expect(Arr.map(yield* list(browser), (row) => row.address)).toEqual([
        "ken@example.com",
        "ken@example.net",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("hides other users' addresses and requires a session", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const owner = yield* signedIn(api, "dennis");
      const added = yield* addRecipient(owner.browser, "dennis@example.com");
      const { token } = yield* lastMailTo(api, "dennis@example.com");

      const { browser: stranger } = yield* signedIn(api, "mallory");
      const attempts = yield* Effect.all(
        [
          confirm(stranger, added.id, token),
          stranger.post(`/v1/recipients/${added.id}/resend`),
          stranger.post(`/v1/recipients/${added.id}/default`),
          stranger.delete(`/v1/recipients/${added.id}`),
        ],
        { concurrency: 1 },
      );
      expect(Arr.map(attempts, (response) => response.body)).toEqual(
        Arr.replicate({ _tag: "RecipientNotFound", recipientId: added.id }, 4),
      );
      expect(Arr.map(attempts, (response) => response.status)).toEqual([404, 404, 404, 404]);
      expect(yield* list(stranger)).toEqual([]);

      const anonymous = api.browser();
      expect(yield* anonymous.get("/v1/recipients")).toMatchObject({
        status: 401,
        body: { _tag: "Unauthenticated" },
      });
      expect((yield* add(anonymous, "x@example.com")).status).toBe(401);

      // The owner's link still works after all that.
      expect((yield* confirm(owner.browser, added.id, token)).status).toBe(200);
    }).pipe(Effect.scoped),
  );
});

describe("OpenPGP keys on forwarding addresses (PLAN.md §20.21)", () => {
  const now = DateTime.makeUnsafe("2026-10-22T09:00:00Z");

  /** `keyExpirationTime` in seconds; 0 never expires. */
  const generate = (keyExpirationTime = 0) =>
    Effect.promise(() =>
      openpgp.generateKey({
        userIDs: [{ name: "Ada", email: "ada@example.com" }],
        type: "curve25519",
        date: DateTime.toDate(DateTime.subtract(now, { days: 1 })),
        keyExpirationTime,
        format: "object",
      }),
    );

  const setKey = (browser: Browser.Client, recipientId: string, body: Schema.Json) =>
    browser.put(`/v1/recipients/${recipientId}/encryption`, body);

  it.effect("stores a valid key, shows its fingerprint, replaces and removes it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "ada");
      const added = yield* addVerified(api, browser, "ada@example.com");
      const { publicKey } = yield* generate(365 * 24 * 3600);

      const stored = yield* setKey(browser, added.id, {
        publicKey: `My key:\n${publicKey.armor()}`,
        isSubjectHidden: false,
      });
      expect(stored).toMatchObject({
        status: 200,
        body: {
          id: added.id,
          encryption: {
            fingerprint: publicKey.getFingerprint().toUpperCase(),
            userIds: ["Ada <ada@example.com>"],
            expiresAt: "2027-10-21T09:00:00.000Z",
            isUsable: true,
            isSubjectHidden: false,
          },
        },
      });
      // Only the key itself is kept, not the text around it.
      expect(stored.body).toMatchObject({ encryption: { publicKey: publicKey.armor() } });
      const { name } = yield* Effect.provide(Effect.service(Dynamo.DynamoTable), api.context);
      const item = yield* DynamoDB.scan({ TableName: name }).pipe(
        Effect.provide(api.context),
        Effect.map(({ Items = [] }) =>
          Arr.findFirst(Items, (row) => row.sk?.S === "RECIPIENT#ada@example.com"),
        ),
      );
      expect(Option.map(item, (row) => row.encryption?.M?.publicKey?.S)).toEqual(
        Option.some(publicKey.armor()),
      );

      const other = yield* generate();
      const replaced = yield* setKey(browser, added.id, {
        publicKey: other.publicKey.armor(),
        isSubjectHidden: true,
      });
      expect(replaced.body).toMatchObject({
        encryption: {
          fingerprint: other.publicKey.getFingerprint().toUpperCase(),
          isSubjectHidden: true,
        },
      });
      expect(replaced.body).not.toHaveProperty("encryption.expiresAt");
      expect(yield* browser.get("/v1/recipients")).toMatchObject({
        body: [{ id: added.id, encryption: { isSubjectHidden: true } }],
      });

      // A key that expires: listed as unusable once it has, with nothing uploaded again.
      const shortLived = yield* generate(3 * 24 * 3600);
      yield* setKey(browser, added.id, {
        publicKey: shortLived.publicKey.armor(),
        isSubjectHidden: false,
      });
      expect(yield* browser.get("/v1/recipients")).toMatchObject({
        body: [{ encryption: { isUsable: true } }],
      });
      yield* TestClock.adjust("3 days");
      expect(yield* browser.get("/v1/recipients")).toMatchObject({
        body: [{ encryption: { isUsable: false } }],
      });

      const removed = yield* browser.delete(`/v1/recipients/${added.id}/encryption`);
      expect(removed.status).toBe(200);
      expect(removed.body).not.toHaveProperty("encryption");
      expect((yield* browser.get("/v1/recipients")).body).not.toHaveProperty("0.encryption");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses what can't encrypt, with the reason", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const api = yield* TestApi.make;
      const { browser } = yield* signedIn(api, "grace");
      const added = yield* addRecipient(browser, "grace@example.com");
      const valid = yield* generate();
      const expired = yield* generate(3600);
      const cases = [
        { publicKey: "hello", reason: "malformed" },
        { publicKey: valid.privateKey.armor(), reason: "private-key" },
        { publicKey: expired.publicKey.armor(), reason: "expired" },
        { publicKey: "x".repeat(70_000), reason: "too-large" },
      ];
      const responses = yield* Effect.forEach(
        cases,
        ({ publicKey }) => setKey(browser, added.id, { publicKey, isSubjectHidden: false }),
        { concurrency: 1 },
      );
      expect(Arr.map(responses, (response) => [response.status, response.body])).toEqual(
        Arr.map(cases, ({ reason }) => [400, { _tag: "InvalidPublicKey", reason }]),
      );
      // A pending address may have a key too: mail only goes to it once it is verified.
      expect(
        (yield* setKey(browser, added.id, {
          publicKey: valid.publicKey.armor(),
          isSubjectHidden: false,
        })).status,
      ).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect("only the owner can set or remove a key; tokens need recipients:write", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const api = yield* TestApi.make;
      const owner = yield* signedIn(api, "dennis");
      const added = yield* addRecipient(owner.browser, "dennis@example.com");
      const { publicKey } = yield* generate();
      const body = { publicKey: publicKey.armor(), isSubjectHidden: false };

      const { browser: stranger } = yield* signedIn(api, "mallory");
      const attempts = yield* Effect.all(
        [
          setKey(stranger, added.id, body),
          stranger.delete(`/v1/recipients/${added.id}/encryption`),
          setKey(owner.browser, "rcp_missing", body),
        ],
        { concurrency: 1 },
      );
      expect(Arr.map(attempts, (response) => response.status)).toEqual([404, 404, 404]);
      expect((yield* setKey(api.browser(), added.id, body)).status).toBe(401);

      const minted = yield* owner.browser.post("/v1/tokens", {
        name: "cli",
        scopes: ["recipients:read"],
      });
      const token = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(minted.body);
      expect((yield* setKey(api.withToken(token.token), added.id, body)).status).toBe(403);
      expect(yield* owner.browser.get("/v1/recipients")).not.toHaveProperty("body.0.encryption");
    }).pipe(Effect.scoped),
  );
});
