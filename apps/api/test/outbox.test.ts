import { FakeCloud } from "@alias/aws-emulators";
import { ContactRepo, OutboxRepo } from "@alias/db";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { MAX_SENDS_PER_DAY } from "../src/outbox.ts";
import * as Browser from "./support/Browser.ts";
import * as Mcp from "./support/Mcp.ts";
import * as TestApi from "./support/TestApi.ts";

const scopes = ["aliases:read", "aliases:write", "contacts:write", "mail:send"];
const contactId = "c0ntact00000001x";
const urlCapable = { elicitation: { url: {} } };

const Structured = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Struct(fields) }) });

const InputRequired = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.Literal("input_required"),
    inputRequests: Schema.Struct({
      approve: Schema.Struct({
        method: Schema.Literal("elicitation/create"),
        params: Schema.Struct({
          mode: Schema.Literal("url"),
          message: Schema.String,
          url: Schema.String,
        }),
      }),
    }),
    requestState: Schema.String,
  }),
});

/**
 * Ada, an MCP client she connected with `scopes`, an alias on the shared domain (verified on
 * fakecloud) and one contact, Grace, who wrote to it.
 */
const setUp = Effect.fn("setUp")(function* () {
  const api = yield* TestApi.make;
  const ada = yield* TestApi.signedIn(api.browser, "ada");
  const { access_token: token } = yield* Mcp.connect(api, ada, scopes);
  const created = yield* Mcp.callTool(api, token, "create_alias", { domain: "alias.test" });
  const alias = Schema.decodeUnknownSync(Structured({ id: Schema.String, address: Schema.String }))(
    created.body,
  ).result.structuredContent;
  const [local = "", domain = ""] = alias.address.split("@");
  yield* ContactRepo.layer.pipe(
    Layer.build,
    Effect.flatMap((context) =>
      ContactRepo.ContactRepo.use((repo) =>
        repo.create(
          {
            id: contactId,
            aliasId: alias.id,
            address: "grace@store.example",
            name: Option.some("Grace"),
            createdAt: DateTime.makeUnsafe(0),
          },
          { domain, localPart: local },
        ),
      ).pipe(Effect.provide(context)),
    ),
    Effect.provide(api.context),
  );
  const mail = { from: alias.address, contactId, subject: "Your order", text: "Hello Grace" };
  return { api, ada, token, alias, mail };
});

type Setup = Effect.Success<ReturnType<typeof setUp>>;

/** `send_mail` from a client that can't open URLs: it gets the link and the draft id. */
const draftLink = Effect.fn("draftLink")(function* (setup: Setup) {
  const drafted = yield* Mcp.callTool(setup.api, setup.token, "send_mail", setup.mail);
  return Schema.decodeUnknownSync(
    Structured({ draftId: Schema.String, status: Schema.String, approveAt: Schema.String }),
  )(drafted.body).result.structuredContent;
});

/** Mail fakecloud's SES accepted for Grace, as raw text. */
const sentToGrace = (api: Setup["api"]) =>
  FakeCloud.sentEmails().pipe(
    Effect.map((emails) =>
      Arr.map(
        Arr.filter(emails, (email) => Arr.contains(email.to, "grace@store.example")),
        (email) => ({
          from: email.from,
          raw: Option.match(email.raw, {
            onNone: () => "",
            onSome: (raw) => new TextDecoder().decode(raw),
          }),
        }),
      ),
    ),
    Effect.provide(api.context),
  );

describe("confirm-gated send (API handler on fakecloud)", () => {
  it.effect("drafts without sending, and sends once the user sends it in the web app", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const draft = yield* draftLink(setup);
      expect(draft).toMatchObject({ status: "pending" });
      expect(draft.approveAt).toBe(`${Browser.origin}/outbox/${draft.draftId}`);
      expect(yield* sentToGrace(setup.api)).toEqual([]);

      const shown = yield* setup.ada.browser.get(`/v1/outbox/${draft.draftId}`);
      expect(shown.body).toMatchObject({
        id: draft.draftId,
        from: setup.alias.address,
        to: "grace@store.example",
        contactName: "Grace",
        subject: "Your order",
        text: "Hello Grace",
        clientName: "Test client",
        status: "pending",
      });

      const sent = yield* setup.ada.browser.post(`/v1/outbox/${draft.draftId}/send`);
      expect(sent).toMatchObject({ status: 200, body: { status: "sent" } });
      const mails = yield* sentToGrace(setup.api);
      expect(mails).toHaveLength(1);
      expect(mails[0]?.from).toBe(setup.alias.address);
      expect(mails[0]?.raw).toContain(`From: ${setup.alias.address}\r\n`);
      expect(mails[0]?.raw).toContain("Subject: Your order\r\n");
      expect(mails[0]?.raw).toContain(`@${setup.alias.address.split("@")[1]}>`);

      // Once only.
      expect(yield* setup.ada.browser.post(`/v1/outbox/${draft.draftId}/send`)).toMatchObject({
        status: 409,
        body: { _tag: "DraftClosed", status: "sent" },
      });
      expect((yield* setup.ada.browser.post(`/v1/outbox/${draft.draftId}/discard`)).status).toBe(
        409,
      );
      expect(yield* sentToGrace(setup.api)).toHaveLength(1);
      const status = yield* Mcp.callTool(setup.api, setup.token, "get_send_status", {
        draftId: draft.draftId,
      });
      expect(status.body).toMatchObject({ result: { structuredContent: { status: "sent" } } });
    }),
  );

  it.effect("keeps sending out of reach of every token, mail:send included", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const draft = yield* draftLink(setup);
      const pat = yield* setup.ada.browser.post("/v1/tokens", {
        name: "cli",
        scopes: ["mail:send", "aliases:read"],
      });
      const token = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(pat.body);
      const client = setup.api.withToken(token.token);
      expect((yield* client.post(`/v1/outbox/${draft.draftId}/send`)).status).toBe(403);
      expect((yield* client.get(`/v1/outbox/${draft.draftId}`)).status).toBe(403);
      const oauth = setup.api.withToken(setup.token);
      expect((yield* oauth.post(`/v1/outbox/${draft.draftId}/send`)).status).toBe(401);
      // Someone else's draft looks like a missing one.
      const grace = yield* TestApi.signedIn(setup.api.browser, "grace");
      expect((yield* grace.browser.post(`/v1/outbox/${draft.draftId}/send`)).status).toBe(404);
      expect(yield* sentToGrace(setup.api)).toEqual([]);
    }),
  );

  it.effect("asks a URL-capable client for approval and finishes on its retry", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const call = (extra: Readonly<Record<string, Schema.Json>> = {}) =>
        Mcp.callTool(setup.api, setup.token, "send_mail", setup.mail, extra, urlCapable);
      const first = yield* call();
      const asked = Schema.decodeUnknownSync(InputRequired)(first.body).result;
      const draftId = asked.requestState;
      expect(asked.inputRequests.approve.params.url).toBe(`${Browser.origin}/outbox/${draftId}`);

      // The user said yes in the client but hasn't sent yet: ask again.
      const accepted = { inputResponses: { approve: { action: "accept" } }, requestState: draftId };
      expect(Schema.decodeUnknownSync(InputRequired)((yield* call(accepted)).body).result).toEqual(
        asked,
      );

      yield* setup.ada.browser.post(`/v1/outbox/${draftId}/send`);
      expect((yield* call(accepted)).body).toMatchObject({
        result: {
          resultType: "complete",
          isError: false,
          structuredContent: { draftId, status: "sent" },
        },
      });
      expect(yield* sentToGrace(setup.api)).toHaveLength(1);
    }),
  );

  it.effect("discards the draft when the user declines in the client", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const call = (extra: Readonly<Record<string, Schema.Json>> = {}) =>
        Mcp.callTool(setup.api, setup.token, "send_mail", setup.mail, extra, urlCapable);
      const draftId = Schema.decodeUnknownSync(InputRequired)((yield* call()).body).result
        .requestState;
      const declined = yield* call({
        inputResponses: { approve: { action: "decline" } },
        requestState: draftId,
      });
      expect(declined.body).toMatchObject({
        result: { resultType: "complete", structuredContent: { status: "discarded" } },
      });
      expect((yield* setup.ada.browser.post(`/v1/outbox/${draftId}/send`)).status).toBe(409);
      expect(yield* sentToGrace(setup.api)).toEqual([]);
    }),
  );

  it.effect("treats requestState as untrusted: another request's or user's state fails", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const draftId = Schema.decodeUnknownSync(InputRequired)(
        (yield* Mcp.callTool(setup.api, setup.token, "send_mail", setup.mail, {}, urlCapable)).body,
      ).result.requestState;
      const retry = (args: Readonly<Record<string, Schema.Json>>, state: string) =>
        Mcp.callTool(
          setup.api,
          setup.token,
          "send_mail",
          args,
          { requestState: state },
          urlCapable,
        );
      expect((yield* retry({ ...setup.mail, text: "Wire me money" }, draftId)).body).toMatchObject({
        result: { isError: true, content: [{ text: "requestState is for another email." }] },
      });
      expect((yield* retry(setup.mail, "drf_someone_else")).body).toMatchObject({
        result: { isError: true, content: [{ text: "requestState names no draft of yours." }] },
      });
      // Grace's own client can't use Ada's draft id either.
      const grace = yield* TestApi.signedIn(setup.api.browser, "grace");
      const { access_token: theirs } = yield* Mcp.connect(setup.api, grace, ["mail:send"]);
      const stolen = yield* Mcp.callTool(
        setup.api,
        theirs,
        "send_mail",
        setup.mail,
        { requestState: draftId, inputResponses: { approve: { action: "decline" } } },
        urlCapable,
      );
      expect(stolen.body).toMatchObject({ result: { isError: true } });
      expect((yield* setup.ada.browser.get(`/v1/outbox/${draftId}`)).body).toMatchObject({
        status: "pending",
      });
    }),
  );

  it.effect("refuses drafts to blocked contacts and from deactivated aliases", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const draft = yield* draftLink(setup);
      yield* Mcp.callTool(setup.api, setup.token, "block_contact", {
        address: setup.alias.address,
        contactId,
      });
      expect(
        (yield* Mcp.callTool(setup.api, setup.token, "send_mail", setup.mail)).body,
      ).toMatchObject({
        result: { isError: true, content: [{ text: "DraftRefused, reason: blocked-contact" }] },
      });
      // A draft made before the block can't go out either, and stays pending.
      expect(yield* setup.ada.browser.post(`/v1/outbox/${draft.draftId}/send`)).toMatchObject({
        status: 422,
        body: { _tag: "SendFailed", reason: "blocked-contact", isRetryable: false },
      });
      yield* Mcp.callTool(setup.api, setup.token, "set_alias_active", {
        address: setup.alias.address,
        isActive: false,
      });
      expect(yield* setup.ada.browser.post(`/v1/outbox/${draft.draftId}/send`)).toMatchObject({
        status: 422,
        body: { reason: "inactive-alias" },
      });
      expect(
        (yield* Mcp.callTool(setup.api, setup.token, "send_mail", {
          ...setup.mail,
          contactId: "nobody",
        })).body,
      ).toMatchObject({
        result: { isError: true },
      });
      expect(yield* sentToGrace(setup.api)).toEqual([]);
    }),
  );

  it.effect("lets a draft lapse after an hour", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const draft = yield* draftLink(setup);
      yield* TestClock.adjust("1 hour");
      expect((yield* setup.ada.browser.get(`/v1/outbox/${draft.draftId}`)).body).toMatchObject({
        status: "expired",
      });
      expect(yield* setup.ada.browser.post(`/v1/outbox/${draft.draftId}/send`)).toMatchObject({
        status: 409,
        body: { status: "expired" },
      });
      expect(yield* sentToGrace(setup.api)).toEqual([]);
    }),
  );

  it.effect("caps sends per user and day", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const now = yield* DateTime.now;
      yield* OutboxRepo.layer.pipe(
        Layer.build,
        Effect.flatMap((context) =>
          Effect.forEach(
            Arr.range(1, MAX_SENDS_PER_DAY),
            () =>
              OutboxRepo.OutboxRepo.use((repo) =>
                repo.reserveSend(setup.ada.userId, now, MAX_SENDS_PER_DAY),
              ),
            { concurrency: 10 },
          ).pipe(Effect.provide(context)),
        ),
        Effect.provide(setup.api.context),
      );
      const draft = yield* draftLink(setup);
      expect(yield* setup.ada.browser.post(`/v1/outbox/${draft.draftId}/send`)).toMatchObject({
        status: 422,
        body: { reason: "limit-reached" },
      });
      expect((yield* setup.ada.browser.get(`/v1/outbox/${draft.draftId}`)).body).toMatchObject({
        status: "pending",
      });
    }),
  );

  it.effect("discards from the web app, and tells the client", () =>
    Effect.gen(function* () {
      const setup = yield* setUp();
      const draft = yield* draftLink(setup);
      expect(yield* setup.ada.browser.post(`/v1/outbox/${draft.draftId}/discard`)).toMatchObject({
        status: 200,
        body: { status: "discarded" },
      });
      const status = yield* Mcp.callTool(setup.api, setup.token, "get_send_status", {
        draftId: draft.draftId,
      });
      expect(status.body).toMatchObject({ result: { structuredContent: { status: "discarded" } } });
      expect((yield* setup.ada.browser.post(`/v1/outbox/${draft.draftId}/send`)).status).toBe(409);
    }),
  );

  it.effect("needs the mail:send scope", () =>
    Effect.gen(function* () {
      const api = yield* TestApi.make;
      const ada = yield* TestApi.signedIn(api.browser, "ada");
      const { access_token: token } = yield* Mcp.connect(api, ada, ["aliases:read"]);
      const refused = yield* Mcp.callTool(api, token, "send_mail", {
        from: "x@alias.test",
        contactId,
        subject: "s",
        text: "t",
      });
      expect(refused.status).toBe(403);
      expect(refused.headers["www-authenticate"]).toContain('scope="aliases:read mail:send"');
    }),
  );
});
