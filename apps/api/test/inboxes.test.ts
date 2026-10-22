import { AwsClient, Objects } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { AliasRepo } from "@alias/db";
import { Inbox } from "@alias/inbox";
import { TestInbox } from "@alias/inbox/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { TEMPORARY_PER_DAY } from "../src/inboxes.ts";
import * as TestApi from "./support/TestApi.ts";

const Created = Schema.Struct({ id: Schema.String, address: Schema.String });
const Token = Schema.Struct({ token: Schema.String });

const otpMail = (code: string) =>
  new TextEncoder().encode(
    [
      "From: Example Login <no-reply@login.example>",
      `Subject: ${code} is your sign-in code`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      `<p onclick="x()">Your verification code is <b>${code}</b>.</p><img src="https://track.example/p.gif"><script>alert(1)</script>`,
      "",
    ].join("\r\n"),
  );

/** The API on fakecloud, with the inbox store and table it uses, as the inbound Lambda sees them. */
const api = Effect.map(TestApi.make, (handler) => {
  const deliver = (address: string, raw: Uint8Array) =>
    Effect.gen(function* () {
      const [localPart = "", domain = ""] = address.split("@");
      const aliases = yield* AliasRepo.make();
      const alias = yield* Effect.fromOption(yield* aliases.findByAddress(domain, localPart));
      return yield* (yield* Inbox.Inbox).store(alias, raw);
    }).pipe(Effect.provide(handler.context));
  const objects = Effect.gen(function* () {
    const { bucket } = yield* TestInbox;
    const { url } = yield* FakeCloud.FakeCloud;
    return yield* Objects.keys(bucket, "inbox/").pipe(Effect.provide(AwsClient.emulator(url)));
  }).pipe(Effect.provide(handler.context));
  return { ...handler, deliver, objects };
});

/**
 * Moves the test clock forward in half-second steps, letting real time pass between them: a
 * waiting request does real I/O (fakecloud) between its sleeps, and only a sleep that has
 * started when the clock moves wakes up.
 */
const advance = (seconds: number) =>
  Effect.forEach(
    Arr.range(1, seconds * 2),
    () =>
      TestClock.withLive(Effect.sleep("50 millis")).pipe(
        Effect.andThen(TestClock.adjust("500 millis")),
      ),
    { concurrency: 1, discard: true },
  );

describe("inboxes API (handler on fakecloud)", () => {
  it.effect("creates a temporary inbox on the temp domain, listed apart from aliases", () =>
    Effect.gen(function* () {
      const handler = yield* api;
      const { browser } = yield* TestApi.signedIn(handler.browser, "ada");
      const created = yield* browser.post("/v1/inboxes", {});
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        address: expect.stringMatching(/^[2-9a-z]{10}@tmp\.test$/),
        mode: "inbox",
        isTemporary: true,
        retentionDays: 1,
        // The test clock stands at the epoch: one day from then.
        expiresAt: "1970-01-02T00:00:00.000Z",
      });
      const other = yield* browser.post("/v1/inboxes", { domain: "TMP2.test", lifetimeHours: 1 });
      expect(other.body).toMatchObject({ expiresAt: "1970-01-01T01:00:00.000Z" });
      expect((yield* browser.get("/v1/inboxes")).body).toHaveLength(2);
      expect((yield* browser.get("/v1/aliases")).body).toEqual([]);

      // An inbox-mode alias is an inbox too, kept a week unless its owner chooses otherwise.
      yield* browser.post("/v1/aliases", { _tag: "Random", domain: "alias.test", mode: "inbox" });
      const inboxes = (yield* browser.get("/v1/inboxes")).body;
      expect(inboxes).toContainEqual(
        expect.objectContaining({ isTemporary: false, retentionDays: 7, mode: "inbox" }),
      );

      expect(yield* browser.post("/v1/inboxes", { domain: "alias.test" })).toMatchObject({
        status: 400,
        body: { _tag: "InvalidTemporaryInbox", reason: "unknown-domain" },
      });
      expect((yield* browser.post("/v1/inboxes", { lifetimeHours: 169 })).status).toBe(400);
    }).pipe(Effect.scoped),
  );

  it.effect("lists stored mail with the code, reads it sanitized, deletes it", () =>
    Effect.gen(function* () {
      const handler = yield* api;
      const { browser } = yield* TestApi.signedIn(handler.browser, "ada");
      const { address } = Schema.decodeUnknownSync(Created)(
        (yield* browser.post("/v1/inboxes", {})).body,
      );
      const stored = yield* handler.deliver(address, otpMail("482913"));
      const path = `/v1/inboxes/${address.split("@")[1]}/${address.split("@")[0]}/messages`;

      const listed = yield* browser.get(path);
      expect(listed.body).toEqual([
        {
          id: stored.messageId,
          receivedAt: expect.any(String),
          expiresAt: expect.any(String),
          size: expect.any(Number),
          from: "Example Login <no-reply@login.example>",
          subject: "482913 is your sign-in code",
          preview: "Your verification code is 482913.",
          code: "482913",
          attachmentCount: 0,
        },
      ]);
      const read = yield* browser.get(`${path}/${stored.messageId}`);
      expect(read.body).toMatchObject({ code: "482913", blockedImageCount: 1 });
      const { html } = Schema.decodeUnknownSync(Schema.Struct({ html: Schema.String }))(read.body);
      expect(html).toContain("<b>482913</b>");
      expect(html).not.toMatch(/script|onclick|track\.example/);

      expect((yield* browser.delete(`${path}/${stored.messageId}`)).status).toBe(204);
      expect((yield* browser.delete(`${path}/${stored.messageId}`)).status).toBe(404);
      expect((yield* browser.get(`${path}/${stored.messageId}`)).status).toBe(404);
      expect((yield* browser.get(path)).body).toEqual([]);
      expect(yield* handler.objects).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("long poll: waits for the next message after the last one seen", () =>
    Effect.gen(function* () {
      const handler = yield* api;
      const { browser } = yield* TestApi.signedIn(handler.browser, "ada");
      const { address } = Schema.decodeUnknownSync(Created)(
        (yield* browser.post("/v1/inboxes", {})).body,
      );
      const path = `/v1/inboxes/tmp.test/${address.split("@")[0]}/messages`;
      const first = yield* handler.deliver(address, otpMail("111111"));

      // Nothing new after the first: the poll waits.
      const waiting = yield* Effect.forkChild(
        browser.get(`${path}?after=${first.messageId}&wait=20`),
      );
      yield* advance(1);
      const second = yield* handler.deliver(address, otpMail("222222"));
      yield* advance(3);
      const answer = yield* Fiber.join(waiting);
      expect(answer.body).toMatchObject([{ id: second.messageId, code: "222222" }]);

      // Nothing arrives: an empty list once the wait is over.
      const empty = yield* Effect.forkChild(
        browser.get(`${path}?after=${second.messageId}&wait=5`),
      );
      yield* advance(6);
      expect((yield* Fiber.join(empty)).body).toEqual([]);
      // Without `wait`, at once; and never longer than 25 s.
      expect((yield* browser.get(path)).body).toHaveLength(2);
      expect((yield* browser.get(`${path}?wait=26`)).status).toBe(400);
    }).pipe(Effect.scoped),
  );

  it.effect("drops expired temporary inboxes from the list; their addresses stay taken", () =>
    Effect.gen(function* () {
      const handler = yield* api;
      const { browser } = yield* TestApi.signedIn(handler.browser, "ada");
      const { address } = Schema.decodeUnknownSync(Created)(
        (yield* browser.post("/v1/inboxes", { lifetimeHours: 1 })).body,
      );
      yield* handler.deliver(address, otpMail("482913"));
      yield* TestClock.adjust("61 minutes");
      expect((yield* browser.get("/v1/inboxes")).body).toEqual([]);
      expect(yield* handler.objects).toEqual([]);
      const [localPart = "", domain = ""] = address.split("@");
      const isDeleted = yield* AliasRepo.make().pipe(
        Effect.flatMap((repo) => repo.isDeleted(domain, localPart)),
        Effect.provide(handler.context),
      );
      expect(isDeleted).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("deletes a temporary inbox with its mail; other people's inboxes look missing", () =>
    Effect.gen(function* () {
      const handler = yield* api;
      const ada = yield* TestApi.signedIn(handler.browser, "ada");
      const grace = yield* TestApi.signedIn(handler.browser, "grace");
      const { address } = Schema.decodeUnknownSync(Created)(
        (yield* ada.browser.post("/v1/inboxes", {})).body,
      );
      yield* handler.deliver(address, otpMail("482913"));
      const [local = ""] = address.split("@");
      expect((yield* grace.browser.get(`/v1/inboxes/tmp.test/${local}/messages`)).status).toBe(404);
      expect((yield* grace.browser.delete(`/v1/inboxes/tmp.test/${local}`)).status).toBe(404);
      // A forward-only alias is no inbox.
      const forward = Schema.decodeUnknownSync(Created)(
        (yield* ada.browser.post("/v1/aliases", {
          _tag: "Random",
          domain: "alias.test",
          mode: "forward",
        })).body,
      );
      const [forwardLocal = ""] = forward.address.split("@");
      expect(
        (yield* ada.browser.get(`/v1/inboxes/alias.test/${forwardLocal}/messages`)).status,
      ).toBe(404);
      expect((yield* ada.browser.delete(`/v1/inboxes/alias.test/${forwardLocal}`)).status).toBe(
        404,
      );

      expect((yield* ada.browser.delete(`/v1/inboxes/tmp.test/${local}`)).status).toBe(204);
      expect(yield* handler.objects).toEqual([]);
      expect((yield* ada.browser.get("/v1/inboxes")).body).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("deleting an inbox alias over the aliases API purges its stored mail too", () =>
    Effect.gen(function* () {
      const handler = yield* api;
      const { browser } = yield* TestApi.signedIn(handler.browser, "ada");
      const { address } = Schema.decodeUnknownSync(Created)(
        (yield* browser.post("/v1/aliases", {
          _tag: "Random",
          domain: "alias.test",
          mode: "inbox",
        })).body,
      );
      yield* handler.deliver(address, otpMail("482913"));
      expect(yield* handler.objects).toHaveLength(1);
      const [local = ""] = address.split("@");
      expect(
        (yield* browser.patch(`/v1/aliases/alias.test/${local}`, { retentionDays: 30 })).body,
      ).toMatchObject({ retentionDays: 30 });
      expect((yield* browser.delete(`/v1/aliases/alias.test/${local}`)).status).toBe(204);
      expect(yield* handler.objects).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("caps temporary inboxes per user and day", () =>
    Effect.gen(function* () {
      const handler = yield* api;
      const { browser } = yield* TestApi.signedIn(handler.browser, "ada");
      yield* Effect.forEach(
        Arr.range(1, TEMPORARY_PER_DAY),
        () => browser.post("/v1/inboxes", {}),
        { concurrency: 8, discard: true },
      );
      expect(yield* browser.post("/v1/inboxes", {})).toMatchObject({
        status: 429,
        body: { _tag: "TemporaryInboxLimit" },
      });
      yield* TestClock.adjust("1 day");
      expect((yield* browser.post("/v1/inboxes", {})).status).toBe(201);
    }).pipe(Effect.scoped),
  );

  it.effect("a temp-only token reaches inboxes and nothing else", () =>
    Effect.gen(function* () {
      const handler = yield* api;
      const { browser } = yield* TestApi.signedIn(handler.browser, "ada");
      const minted = yield* browser.post("/v1/tokens", {
        name: "ci",
        scopes: ["inboxes:read", "inboxes:write"],
      });
      const { token } = Schema.decodeUnknownSync(Token)(minted.body);
      const client = handler.withToken(token);
      const { address } = Schema.decodeUnknownSync(Created)(
        (yield* client.post("/v1/inboxes", {})).body,
      );
      yield* handler.deliver(address, otpMail("482913"));
      const [local = ""] = address.split("@");
      expect((yield* client.get(`/v1/inboxes/tmp.test/${local}/messages`)).body).toMatchObject([
        { code: "482913" },
      ]);
      expect(yield* client.get("/v1/aliases")).toMatchObject({
        status: 403,
        body: { scope: "aliases:read" },
      });

      const aliasesOnly = Schema.decodeUnknownSync(Token)(
        (yield* browser.post("/v1/tokens", { name: "x", scopes: ["aliases:read"] })).body,
      );
      expect(yield* handler.withToken(aliasesOnly.token).get("/v1/inboxes")).toMatchObject({
        status: 403,
        body: { scope: "inboxes:read" },
      });
    }).pipe(Effect.scoped),
  );
});
