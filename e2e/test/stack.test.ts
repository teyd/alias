import { MailSettings, RelyingParty, makeFunctionUrlHandler } from "@alias/api";
import { TestAuthenticator } from "@alias/api/testing";
import {
  AwsClient,
  Inbound,
  type MessageQueue,
  SesEvent,
  SnsEvent,
  SqsEvent,
  Transport,
} from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { SharedDomains, Username, Webhook } from "@alias/core";
import { Dynamo } from "@alias/db";
import { freshTable } from "@alias/db/testing";
import { Feedback, Pipeline, ReverseKeys, Spool } from "@alias/inbound";
import { FunctionUrlServer, SnsSubscriber, SqsEventSource } from "@alias/lambda-emulator";
import { Delivery, Egress, UrlPolicy } from "@alias/webhooks";
import { Receiver, TestQueue, freshQueue } from "@alias/webhooks/testing";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import * as SNS from "@distilled.cloud/aws/sns";
import * as SSM from "@distilled.cloud/aws/ssm";
import { SesEmulator } from "@alias/ses-emulator";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { createTransport } from "nodemailer";

/**
 * The whole emulated stack, every listener on port 0:
 * - SMTP → SES emulator (receipt rules, verdicts) → S3 spool on fakecloud → SES Lambda event →
 *   the real inbound pipeline → SES sending on fakecloud;
 * - HTTP → function URL emulator → the real API Lambda handler → DynamoDB on fakecloud.
 * One fakecloud process serves S3, DynamoDB, SES, SNS and SSM, as one AWS account would, and both
 * Lambdas share one table.
 */
const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), (fakecloud) => AwsClient.emulator(fakecloud.url)),
);
const spoolBucket = "alias-spool";
const spool = Layer.effectDiscard(Inbound.ensureSpool(spoolBucket)).pipe(Layer.provide(aws));
const database = freshTable();
/** The webhook queue every producer publishes to and the delivery Lambda polls (PLAN.md §20.20). */
const webhookQueue = freshQueue();
/** Webhook receivers in this test listen on 127.0.0.1 over http, which production refuses. */
const urlPolicy = UrlPolicy.layer({ isLoopbackAllowed: true });
const origin = "https://alias.test";
const sharedDomains = SharedDomains.layer("alias.test");
/** Every send names it; its SNS destination reports bounces and complaints (PLAN.md §20.11). */
const configurationSet = "alias-events";
const sending = Transport.layer({ configurationSet: Option.some(configurationSet) }).pipe(
  Layer.provide(aws),
);

/** The configuration set's SNS destination, and the feedback Lambda's subscription to it. */
const feedbackTopic = Layer.effect(
  SnsSubscriber.SnsSubscriber,
  Effect.gen(function* () {
    const { TopicArn = "" } = yield* SNS.createTopic({ Name: "ses-events" });
    yield* SESV2.createConfigurationSet({ ConfigurationSetName: configurationSet });
    yield* SESV2.createConfigurationSetEventDestination({
      ConfigurationSetName: configurationSet,
      EventDestinationName: "feedback",
      EventDestination: {
        Enabled: true,
        MatchingEventTypes: ["BOUNCE", "COMPLAINT"],
        SnsDestination: { TopicArn },
      },
    });
    return yield* SnsSubscriber.make({ topicArn: TopicArn });
  }),
).pipe(Layer.provide(aws));

/** The real API Lambda behind the function URL emulator. */
const api = Layer.unwrap(
  Effect.gen(function* () {
    const context = yield* Effect.context<Dynamo.Database>();
    const fakecloud = yield* FakeCloud.FakeCloud;
    const { handle, dispose } = makeFunctionUrlHandler(
      Layer.mergeAll(
        Layer.succeedContext(context),
        RelyingParty.layer({ id: "alias.test", origin }),
        Transport.layer({ configurationSet: Option.some(configurationSet) }).pipe(
          Layer.provide(AwsClient.emulator(fakecloud.url)),
        ),
        MailSettings.layer(Option.some("no-reply@alias.test")).pipe(
          Layer.provideMerge(sharedDomains),
        ),
        Layer.succeedContext(yield* Effect.context<MessageQueue.MessageQueue>()),
        urlPolicy,
      ),
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    return FunctionUrlServer.layer({ handler: (event) => Effect.runPromise(handle(event)) });
  }),
);

/** The reverse-token keys as production stores them: a SecureString in Parameter Store. */
const reverseKeysParameter = "/alias/e2e/reverse-token-keys";
const reverseKeys = Layer.unwrap(
  SSM.putParameter({
    Name: reverseKeysParameter,
    Type: "SecureString",
    Value: `1:${Buffer.alloc(32, 9).toString("base64url")}`,
  }).pipe(Effect.as(ReverseKeys.fromParameter(reverseKeysParameter))),
).pipe(Layer.provide(aws));

/** The real inbound pipeline on the same table, spool, SES and keys. */
const inbound = Pipeline.layer(
  Layer.mergeAll(
    database,
    webhookQueue,
    sending,
    Spool.layer(spoolBucket).pipe(Layer.provide(aws)),
    sharedDomains,
    reverseKeys,
  ),
);

type Verdicts =
  NonNullable<SesEmulator.SesEmulatorConfig["verdicts"]> extends (
    recipients: ReadonlyArray<string>,
  ) => infer V
    ? V
    : never;

const passing: Verdicts = { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" };

/** What SES will stamp on the next received message; a test sets it before sending. */
const verdicts = { next: passing };

const ses = SesEmulator.layer({
  verifiedDomains: ["alias.test"],
  rules: [
    {
      name: "all-verified",
      enabled: true,
      recipients: [],
      s3: { bucket: spoolBucket, objectKeyPrefix: Inbound.spoolPrefix },
      lambda: {
        functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:inbound",
        invocationType: "Event",
      },
      scanEnabled: true,
    },
  ],
  verdicts: () => verdicts.next,
}).pipe(Layer.provide([aws, spool]));

/** The feedback Lambda on the same table and SES. */
const feedback = Feedback.layer(Layer.mergeAll(database, sending, webhookQueue));

/** The webhook delivery Lambda behind the emulated SQS event source mapping of the queue. */
const delivery = Layer.effect(
  SqsEventSource.SqsEventSource,
  Effect.gen(function* () {
    const { queueUrl } = yield* TestQueue;
    const context = yield* Layer.build(
      Delivery.layer(
        Layer.mergeAll(
          database,
          webhookQueue,
          Delivery.production,
          NodeCrypto.layer,
          Egress.layer,
        ).pipe(Layer.provideMerge(urlPolicy)),
      ),
    );
    return yield* SqsEventSource.make({
      queueUrl,
      handler: (event) =>
        SqsEvent.decode(event).pipe(Effect.flatMap(Delivery.handle), Effect.provide(context)),
    });
  }),
).pipe(Layer.provide(Layer.merge(webhookQueue, aws)));

const stack = Layer.mergeAll(
  api.pipe(Layer.provide(Layer.merge(database, webhookQueue))),
  inbound,
  feedback,
  delivery,
  feedbackTopic,
  ses,
  aws,
).pipe(Layer.provide(NodeCrypto.layer), Layer.provideMerge(FakeCloud.layer()));

/**
 * A browser-ish HTTP call: JSON in and out, the session cookie passed by hand. With `bearer`, a
 * CLI-ish one: an API token in `Authorization` instead.
 */
const call = (
  path: string,
  init: {
    readonly body?: Schema.Json;
    readonly cookie?: string;
    readonly bearer?: string;
    readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  } = {},
) =>
  Effect.gen(function* () {
    const { url } = yield* FunctionUrlServer.FunctionUrlServer;
    const headers = new Headers({ "content-type": "application/json", origin });
    if (init.cookie !== undefined) headers.set("cookie", init.cookie);
    if (init.bearer !== undefined) headers.set("authorization", `Bearer ${init.bearer}`);
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const request: RequestInit = { method, headers };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    const response = yield* Effect.promise(() => fetch(`${url}${path}`, request));
    const text = yield* Effect.promise(() => response.text());
    return {
      status: response.status,
      body: text === "" ? null : JSON.parse(text),
      cookies: response.headers.getSetCookie(),
    };
  });

/** Signs up with a fresh software passkey and returns the session cookie and user ID. */
const signUp = (username: string) =>
  Effect.gen(function* () {
    const authenticator = TestAuthenticator.make(origin);
    const started = yield* call("/v1/auth/register/options", { body: { username } });
    const registered = yield* call("/v1/auth/register", {
      body: {
        challengeId: started.body.challengeId,
        credential: authenticator.create(started.body.options),
      },
    });
    expect(registered.status).toBe(200);
    const cookie = (registered.cookies[0] ?? "").split(";")[0] ?? "";
    return { cookie, userId: String(registered.body.userId), authenticator };
  });

const decoder = new TextDecoder();

/** Mail SES sent to `address`, oldest first, as raw text. */
const sentTo = (address: string) =>
  Effect.map(FakeCloud.sentEmails(), (emails) =>
    Arr.map(
      Arr.filter(emails, (email) => Arr.contains(email.to, address)),
      (email) => ({
        ...email,
        text: decoder.decode(Option.getOrElse(email.raw, () => new Uint8Array())),
      }),
    ),
  );

/** Header fields of a raw message, unfolded, in order. */
const fields = (raw: string) =>
  Arr.map((raw.split("\r\n\r\n")[0] ?? "").replace(/\r\n[ \t]/g, " ").split("\r\n"), (line) => {
    const colon = line.indexOf(":");
    return { name: line.slice(0, colon).toLowerCase(), value: line.slice(colon + 1).trim() };
  });

const field = (raw: string, name: string) =>
  Option.map(
    Arr.findFirst(fields(raw), (found) => found.name === name),
    (found) => found.value,
  );

/**
 * A user as the web app creates one: a passkey account, a forwarding address confirmed with the
 * link from the mailed confirmation, and an alias on their own subdomain.
 */
const owner = (username: string, mailbox = `${username}@mailbox.example`) =>
  Effect.gen(function* () {
    const { cookie, userId, authenticator } = yield* signUp(username);
    const added = yield* call("/v1/recipients", { cookie, body: { address: mailbox } });
    expect(added.status).toBe(201);
    const [confirmation] = yield* sentTo(mailbox);
    const token = new URL(
      /https:\/\/alias\.test\/destinations\?\S+/.exec(confirmation?.text ?? "")?.[0] ?? "x:",
    ).searchParams.get("token");
    const confirmed = yield* call(`/v1/recipients/${added.body.id}/confirm`, {
      cookie,
      body: { token },
    });
    expect(confirmed.status).toBe(200);
    const alias = `shop@${username}.alias.test`;
    const created = yield* call("/v1/aliases", {
      cookie,
      body: { _tag: "Address", address: alias, mode: "forward" },
    });
    expect(created.status).toBe(201);
    // fakecloud only accepts senders on an exactly verified domain; AWS also accepts subdomains
    // of a verified one (PLAN.md §20.5), so the user's subdomain is verified explicitly.
    yield* Transport.ensureIdentity(`${username}.alias.test`);
    return { cookie, userId, authenticator, mailbox, alias };
  });

/** Every item in the shared table whose keys or values mention `text`, as JSON. */
const itemsMentioning = (text: string) =>
  Effect.gen(function* () {
    const table = yield* Dynamo.DynamoTable;
    const { Items } = yield* DynamoDB.scan({ TableName: table.name, ConsistentRead: true });
    return Arr.filter(Items ?? [], (item) => JSON.stringify(item).includes(text));
  });

/** Sends one message over SMTP and returns the Lambda event SES emits for it, as JSON. */
const smtp = (mail: {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly headers?: Record<string, string>;
  readonly verdicts?: Partial<Verdicts>;
}) =>
  Effect.gen(function* () {
    const emulator = yield* SesEmulator.SesEmulator;
    verdicts.next = { ...passing, ...mail.verdicts };
    yield* Effect.tryPromise(() =>
      createTransport({
        host: "127.0.0.1",
        port: emulator.smtpPort,
        secure: false,
        ignoreTLS: true,
      }).sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        headers: mail.headers ?? {},
      }),
    );
    verdicts.next = passing;
    // Lambda passes the event as JSON; the handler parses it as `src/handler.ts` does.
    const json: unknown = JSON.parse(JSON.stringify(yield* Queue.take(emulator.events)));
    return yield* SesEvent.decode(json);
  });

/** Sends a raw message over SMTP as-is (a mailbox's redirect rule) and returns its event. */
const smtpRaw = (mail: { readonly from: string; readonly to: string; readonly raw: string }) =>
  Effect.gen(function* () {
    const emulator = yield* SesEmulator.SesEmulator;
    yield* Effect.tryPromise(() =>
      createTransport({
        host: "127.0.0.1",
        port: emulator.smtpPort,
        secure: false,
        ignoreTLS: true,
      }).sendMail({ envelope: { from: mail.from, to: [mail.to] }, raw: mail.raw }),
    );
    const json: unknown = JSON.parse(JSON.stringify(yield* Queue.take(emulator.events)));
    return yield* SesEvent.decode(json);
  });

const invoke = Pipeline.handle;

const messageIdOf = (event: SesEvent.SesEvent) => event.Records[0]?.ses.mail.messageId ?? "";

describe("emulated stack", () => {
  it.layer(stack, { timeout: 60_000 })((it) => {
    it.effect("serves the API over a function URL", () =>
      Effect.gen(function* () {
        expect(yield* call("/health")).toMatchObject({ status: 200, body: { status: "ok" } });
      }),
    );

    it.effect("creates an alias with a personal API token minted in the browser session", () =>
      Effect.gen(function* () {
        const { cookie } = yield* signUp("cli-user");
        const minted = yield* call("/v1/tokens", {
          cookie,
          body: { name: "laptop CLI", scopes: ["aliases:read", "aliases:write"] },
        });
        expect(minted.status).toBe(201);
        const bearer = String(minted.body.token);
        expect(bearer).toMatch(/^alias_pat_/);

        const created = yield* call("/v1/aliases", {
          bearer,
          body: { _tag: "Random", domain: "alias.test", mode: "forward" },
        });
        expect(created.status).toBe(201);
        expect((yield* call("/v1/aliases", { cookie })).body).toEqual([created.body]);
        expect((yield* call("/v1/aliases", { bearer })).body).toEqual([created.body]);

        // Out of scope, and session-only: the token can't mint itself a stronger one.
        expect((yield* call("/v1/recipients", { bearer })).status).toBe(403);
        const escalate = { name: "more", scopes: ["recipients:write"] };
        expect((yield* call("/v1/tokens", { bearer, body: escalate })).status).toBe(403);

        const revoked = yield* call(`/v1/tokens/${minted.body.id}`, { cookie, method: "DELETE" });
        expect(revoked.status).toBe(204);
        expect((yield* call("/v1/aliases", { bearer })).status).toBe(401);
      }),
    );

    it.effect("posts a signed mail.forwarded event to the owner's webhook endpoint", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const hooked = yield* owner("hooked");
        const receiver = yield* Receiver.make();
        const registered = yield* call("/v1/webhooks", {
          cookie: hooked.cookie,
          body: { url: receiver.url, eventTypes: ["mail.forwarded"] },
        });
        expect(registered.status).toBe(201);
        const secret = String(registered.body.secret);

        const event = yield* smtp({
          from: '"Store" <orders@store.example>',
          to: hooked.alias,
          subject: "Your order",
          text: "Secret order details",
        });
        expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);
        const lambda = yield* SqsEventSource.SqsEventSource;
        expect(yield* lambda.poll).toEqual({ received: 1, deleted: 1 });

        const [request] = receiver.received;
        expect(receiver.received).toHaveLength(1);
        const isAuthentic = yield* Webhook.verify({
          secret,
          id: request?.headers["webhook-id"] ?? "",
          timestamp: Number(request?.headers["webhook-timestamp"]),
          signature: request?.headers["webhook-signature"] ?? "",
          body: request?.body ?? "",
          // The stack runs on the test clock; the receiver checks against the same one.
          nowSeconds: Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000),
        });
        expect(isAuthentic).toBe(true);
        const [contact] = (yield* call(`/v1/aliases/${hooked.alias.split("@")[1]}/shop/contacts`, {
          cookie: hooked.cookie,
        })).body;
        expect(JSON.parse(request?.body ?? "null")).toEqual({
          type: "mail.forwarded",
          timestamp: expect.any(String),
          data: { aliasId: expect.any(String), address: hooked.alias, contactId: contact.id },
        });
        // Metadata only: no content, subject or sender address.
        expect(request?.body).not.toMatch(/store\.example|order/i);
      }),
    );

    it.effect("answers unknown aliases with the typed 404", () =>
      Effect.gen(function* () {
        const { cookie } = yield* signUp("visitor");
        const { status, body } = yield* call("/v1/aliases/alias.test/nobody", { cookie });
        expect(status).toBe(404);
        expect(body).toMatchObject({ _tag: "AliasNotFound" });
      }),
    );

    it.effect(
      "forwards mail to an alias to the owner's verified mailbox, and replies come back out as the alias",
      () =>
        Effect.gen(function* () {
          yield* Transport.ensureIdentity("alias.test");
          const ada = yield* owner("ada");

          // Inbound: a shop writes to the alias.
          const event = yield* smtp({
            from: '"Store" <orders@store.example>',
            to: "Shop@Ada.alias.test",
            subject: "Order confirmed",
            text: "Thanks for your order!",
          });
          expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);

          // The first mail to the mailbox was its confirmation.
          const forwarded = (yield* sentTo(ada.mailbox)).at(-1);
          const reverse = forwarded?.from ?? "";
          expect(reverse).toMatch(/^shop\+r\.[a-z2-7]+@ada\.alias\.test$/);
          const forwardedText = forwarded?.text ?? "";
          expect(field(forwardedText, "from")).toEqual(
            Option.some(`"Store (orders@store.example)" <${reverse}>`),
          );
          expect(field(forwardedText, "reply-to")).toEqual(field(forwardedText, "from"));
          expect(field(forwardedText, "subject")).toEqual(Option.some("Order confirmed"));
          expect(forwardedText).toContain("Thanks for your order!");
          // Forward-only: nothing of the message stays behind.
          const gone = yield* Effect.flip(Inbound.readMessage(spoolBucket, messageIdOf(event)));
          expect(gone._tag).toBe("MessageGone");

          // Reply: the owner answers from their real mailbox through the reverse alias.
          // The client quotes the thread, including the owner's own earlier message.
          const replyBody = [
            "Where is my parcel?",
            "",
            "Ada Lovelace",
            "",
            `On Tue, Store (orders@store.example) <${reverse}> wrote:`,
            "> Thanks for your order!",
            ">",
            `> On Mon, Ada Lovelace <${ada.mailbox}> wrote:`,
            ">> I'd like to order the blue one.",
            ">> -- ",
            `>> Ada Lovelace, ${ada.mailbox.toUpperCase()}`,
            "",
          ].join("\r\n");
          const replyEvent = yield* smtp({
            from: `"Ada Lovelace" <${ada.mailbox}>`,
            to: reverse,
            subject: "Re: Order confirmed",
            text: replyBody,
            headers: {
              "User-Agent": "Thunderbird/128.0",
              "X-Mailer": "Thunderbird",
              "X-Originating-IP": "[198.51.100.7]",
            },
          });
          expect(yield* invoke(replyEvent)).toEqual([{ _tag: "Replied" }]);

          const [reply] = yield* sentTo("orders@store.example");
          expect(reply?.from).toBe("shop@ada.alias.test");
          const replyText = reply?.text ?? "";
          expect(field(replyText, "from")).toEqual(Option.some("shop@ada.alias.test"));
          expect(field(replyText, "to")).toEqual(Option.some("orders@store.example"));
          expect(field(replyText, "message-id")).toEqual(
            Option.some(expect.stringMatching(/^<[\w-]+@ada\.alias\.test>$/)),
          );
          expect(replyText).toContain("Where is my parcel?");

          // Header diff: what the owner's mail client sent (as SES stored it) against what the
          // contact receives. Only the alias's own From and To are new; everything identifying the
          // owner's mailbox, client or network is gone.
          const sentHeaders = yield* Effect.map(SesEvent.decode(replyEvent), (decoded) =>
            Arr.map(decoded.Records[0]?.ses.mail.headers ?? [], (header) =>
              header.name.toLowerCase(),
            ),
          );
          const received = Arr.map(fields(replyText), (found) => found.name);
          expect(Arr.difference(received, sentHeaders)).toEqual([]);
          expect(Arr.difference(sentHeaders, received).toSorted()).toEqual([
            "authentication-results",
            "received",
            "return-path",
            "user-agent",
            "x-mailer",
            "x-originating-ip",
            "x-ses-spam-verdict",
            "x-ses-virus-verdict",
          ]);
          // Body diff: only the owner's name and address in the quoted lines changed. Their own
          // signature line, which they typed, stays.
          // nodemailer sent it quoted-printable; the relay re-encodes it the same way.
          expect(field(replyText, "content-transfer-encoding")).toEqual(
            Option.some("quoted-printable"),
          );
          const body = replyText
            .slice(replyText.indexOf("\r\n\r\n") + 4)
            .replace(/=\r\n/g, "")
            .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            );
          expect(body).toBe(
            replyBody
              .replace(
                `> On Mon, Ada Lovelace <${ada.mailbox}>`,
                "> On Mon, shop@ada.alias.test <shop@ada.alias.test>",
              )
              .replace(
                `>> Ada Lovelace, ${ada.mailbox.toUpperCase()}`,
                ">> shop@ada.alias.test, shop@ada.alias.test",
              ),
          );
          // The owner's real address appears nowhere: not in a header, not in the body, not in
          // the envelope.
          expect(replyText.toLowerCase()).not.toContain(ada.mailbox);
          expect(reply?.to).toEqual(["orders@store.example"]);
        }),
    );

    it.effect("drops spoofed replies: a stranger, or the owner's address without DKIM", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const bob = yield* owner("bob");
        yield* invoke(
          yield* smtp({
            from: "news@shop.example",
            to: bob.alias,
            subject: "Newsletter",
            text: "Deals!",
          }),
        );
        const reverse = (yield* sentTo(bob.mailbox)).at(-1)?.from ?? "";
        expect(reverse).toContain("+r.");

        const stranger = yield* smtp({
          from: "mallory@evil.example",
          to: reverse,
          subject: "Send as Bob",
          text: "spoofed",
        });
        expect(yield* invoke(stranger)).toEqual([
          { _tag: "Dropped", reason: "foreign-reply-sender" },
        ]);

        const forged = yield* smtp({
          from: bob.mailbox,
          to: reverse,
          subject: "Send as Bob",
          text: "forged From",
          verdicts: { dkim: "FAIL", dmarc: "FAIL" },
        });
        expect(yield* invoke(forged)).toEqual([
          { _tag: "Dropped", reason: "unauthenticated-reply" },
        ]);

        expect(yield* sentTo("news@shop.example")).toEqual([]);
      }),
    );

    it.effect("stops a loop through the owner's mailbox and keeps auto-replies from contacts", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const dora = yield* owner("dora");
        expect(
          yield* invoke(
            yield* smtp({
              from: "news@shop.example",
              to: dora.alias,
              subject: "Weekly deals",
              text: "Deals!",
              headers: { Precedence: "bulk", "List-Id": "<deals.shop.example>" },
            }),
          ),
        ).toEqual([{ _tag: "Forwarded" }]);
        const forwarded = (yield* sentTo(dora.mailbox)).at(-1);
        expect(field(forwarded?.text ?? "", "x-alias-forwarded")).toEqual(Option.some(dora.alias));

        // A redirect rule in the mailbox sends the copy back to the alias, headers and all.
        const looped = yield* smtpRaw({
          from: dora.mailbox,
          to: dora.alias,
          raw: forwarded?.text ?? "",
        });
        expect(yield* invoke(looped)).toEqual([{ _tag: "Dropped", reason: "loop" }]);

        // The mailbox's out-of-office reply to the reverse alias never reaches the shop.
        const outOfOffice = yield* smtp({
          from: dora.mailbox,
          to: forwarded?.from ?? "",
          subject: "Out of office",
          text: "I'm away until Monday.",
          headers: { "Auto-Submitted": "auto-replied" },
        });
        expect(yield* invoke(outOfOffice)).toEqual([{ _tag: "Dropped", reason: "auto-reply" }]);

        // The confirmation mail and the one forward; nothing went back to the shop.
        expect(yield* sentTo(dora.mailbox)).toHaveLength(2);
        expect(yield* sentTo("news@shop.example")).toEqual([]);
      }),
    );

    it.effect("removes tracking pixels from forwarded mail, and cleans links when asked", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const hana = yield* owner("hana");
        const newsletter = [
          "DKIM-Signature: v=1; a=rsa-sha256; d=shop.example; s=k1; h=from:subject; bh=x; b=y",
          "From: Shop <news@shop.example>",
          `To: ${hana.alias}`,
          "Subject: Fall sale",
          "Message-ID: <fall-sale@shop.example>",
          "MIME-Version: 1.0",
          'Content-Type: multipart/alternative; boundary="b1"',
          "",
          "--b1",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Sale: https://shop.example/sale?utm_source=mail&id=7",
          "--b1",
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: quoted-printable",
          "",
          '<p>Gr=C3=BC=C3=9Fe! <a href=3D"https://shop.example/sale?utm_source=3Dmail&amp;id=3D7">Sale</a></p>',
          '<img src=3D"https://img.shop.example/hero.jpg" width=3D"600" height=3D"300">',
          '<img src=3D"https://shop.us1.list-manage.com/track/open.php?u=3D1" width=3D"1" height=',
          '=3D"1">',
          "--b1--",
          "",
        ].join("\r\n");
        const forward = Effect.fn("forward")(function* () {
          const event = yield* smtpRaw({
            from: "news@shop.example",
            to: hana.alias,
            raw: newsletter,
          });
          expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);
          return (yield* sentTo(hana.mailbox)).at(-1)?.text ?? "";
        });
        /** The HTML part as the mailbox shows it. */
        const html = (raw: string) =>
          (raw.split("Content-Transfer-Encoding: quoted-printable\r\n\r\n")[1] ?? "")
            .split("\r\n--b1--")[0]
            ?.replace(/=\r\n/g, "")
            .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            );

        // Tracker blocking is on by default.
        const blocked = yield* forward();
        expect(html(blocked)).not.toContain("list-manage.com");
        expect(html(blocked)).toContain('<img src="https://img.shop.example/hero.jpg"');
        expect(html(blocked)).toContain("utm_source=mail");
        expect(field(blocked, "x-alias-trackers-removed")).toEqual(Option.some("1"));

        const changed = yield* call("/v1/settings", {
          cookie: hana.cookie,
          method: "PATCH",
          body: { imageProtection: "off", isLinkCleaningEnabled: true },
        });
        expect(changed).toMatchObject({ status: 200, body: { imageProtection: "off" } });
        const cleaned = yield* forward();
        expect(html(cleaned)).toContain("list-manage.com/track/open.php");
        expect(html(cleaned)).toContain('<a href="https://shop.example/sale?id=7">Sale</a>');
        expect(cleaned).toContain("Sale: https://shop.example/sale?id=7\r\n");
        expect(field(cleaned, "x-alias-links-cleaned")).toEqual(Option.some("2"));

        // Only the body and the counting fields differ: the sender's signature never travels
        // (SES signs the forward for the alias domain), and the MIME fields stay as they came.
        const names = (raw: string) =>
          Arr.filter(
            Arr.map(fields(raw), (found) => found.name),
            (name) => !name.startsWith("x-alias-trackers") && !name.startsWith("x-alias-links"),
          );
        expect(names(cleaned)).toEqual(names(blocked));
        expect(names(blocked)).not.toContain("dkim-signature");
        Arr.map(["mime-version", "content-type", "message-id", "subject"], (name) =>
          expect(field(blocked, name)).toEqual(field(newsletter, name)),
        );
      }),
    );

    it.effect("forwards the first mail to a new address on my subdomain once I opt in", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const erin = yield* owner("erin");
        const mail = (to: string) =>
          smtp({ from: "hello@club.example", to, subject: "Welcome", text: "Glad you joined." });

        expect(yield* invoke(yield* mail("club@erin.alias.test"))).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);

        const enabled = yield* call("/v1/settings", {
          cookie: erin.cookie,
          method: "PATCH",
          body: { isOnTheFlyEnabled: true },
        });
        expect(enabled).toMatchObject({ status: 200, body: { isOnTheFlyEnabled: true } });

        expect(yield* invoke(yield* mail("Club@Erin.alias.test"))).toEqual([{ _tag: "Forwarded" }]);
        const forwarded = (yield* sentTo(erin.mailbox)).at(-1);
        expect(forwarded?.from).toMatch(/^club\+r\.[a-z2-7]+@erin\.alias\.test$/);
        expect(forwarded?.text).toContain("Glad you joined.");

        // The new alias is the user's own, like one made in the web app.
        const listed = yield* call("/v1/aliases", { cookie: erin.cookie });
        expect(listed.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ address: "club@erin.alias.test", isActive: true }),
          ]),
        );

        // Someone else's subdomain is not mine to fill.
        expect(yield* invoke(yield* mail("club@frank.alias.test"))).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
      }),
    );

    it.effect("drops a blocked sender's mail, and replies to a deleted contact", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const gil = yield* owner("gil");
        const write = (from: string) =>
          smtp({ from, to: gil.alias, subject: "Hello", text: `From ${from}` });
        expect(yield* invoke(yield* write("spam@pushy.example"))).toEqual([{ _tag: "Forwarded" }]);
        expect(yield* invoke(yield* write("friend@pal.example"))).toEqual([{ _tag: "Forwarded" }]);
        const friendReverse = (yield* sentTo(gil.mailbox)).at(-1)?.from ?? "";

        const contactsPath = `/v1/aliases/gil.alias.test/shop/contacts`;
        const listed = yield* call(contactsPath, { cookie: gil.cookie });
        const contacts = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ id: Schema.String, address: Schema.String })),
        )(listed.body);
        expect(contacts).toHaveLength(2);
        const idOf = (address: string) =>
          contacts.find((contact) => contact.address === address)?.id ?? "";
        const spammer = { id: idOf("spam@pushy.example") };
        const friend = { id: idOf("friend@pal.example") };

        const blocked = yield* call(`${contactsPath}/${spammer?.id}`, {
          cookie: gil.cookie,
          method: "PATCH",
          body: { isBlocked: true },
        });
        expect(blocked).toMatchObject({ status: 200, body: { isBlocked: true } });
        expect(yield* invoke(yield* write("spam@pushy.example"))).toEqual([
          { _tag: "Dropped", reason: "blocked-contact" },
        ]);

        const deleted = yield* call(`${contactsPath}/${friend?.id}`, {
          cookie: gil.cookie,
          method: "DELETE",
        });
        expect(deleted.status).toBe(204);
        const reply = yield* smtp({
          from: gil.mailbox,
          to: friendReverse,
          subject: "Re: Hello",
          text: "Still there?",
        });
        expect(yield* invoke(reply)).toEqual([{ _tag: "Dropped", reason: "unknown-contact" }]);

        expect(yield* sentTo("friend@pal.example")).toEqual([]);
        // The confirmation mail and the two first forwards.
        expect(yield* sentTo(gil.mailbox)).toHaveLength(3);
      }),
    );

    it.effect("stops forwarding to a mailbox that hard-bounces, and says so in the API", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const bounce = "bounce@simulator.amazonses.com";
        const ivy = yield* owner("ivy", bounce);

        // The confirmation mail bounced: SES published it, SNS invoked the feedback Lambda.
        const subscriber = yield* SnsSubscriber.SnsSubscriber;
        const event = yield* SnsEvent.decode(
          JSON.parse(JSON.stringify(yield* Queue.take(subscriber.events))),
        );
        expect(yield* Feedback.handle(event)).toEqual([
          { _tag: "Bounced", suppressed: 1, marked: 1 },
        ]);
        const listed = yield* call("/v1/recipients", { cookie: ivy.cookie });
        expect(listed.body).toEqual([
          expect.objectContaining({ address: bounce, bouncedAt: expect.any(String) }),
        ]);
        const suppressed = yield* SESV2.getSuppressedDestination({ EmailAddress: bounce });
        expect(suppressed.SuppressedDestination?.Reason).toBe("BOUNCE");

        // Mail to the alias is no longer sent to the bouncing mailbox.
        const forward = yield* smtp({
          from: "orders@store.example",
          to: ivy.alias,
          subject: "Invoice",
          text: "Attached.",
        });
        expect(yield* invoke(forward)).toEqual([{ _tag: "Dropped", reason: "recipient-bounced" }]);
        expect(yield* sentTo(bounce)).toHaveLength(1);
      }),
    );

    it.effect("sends nothing extra when Lambda redelivers an event", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const cleo = yield* owner("cleo");
        const event = yield* smtp({
          from: "orders@store.example",
          to: cleo.alias,
          subject: "Invoice",
          text: "Attached.",
        });
        expect(yield* invoke(event)).toEqual([{ _tag: "Forwarded" }]);
        expect(yield* invoke(event)).toEqual([{ _tag: "Duplicate" }]);
        // The confirmation mail and one forward.
        expect(yield* sentTo(cleo.mailbox)).toHaveLength(2);
      }),
    );

    it.effect("deleting an alias drops its mail and its reverse aliases, and its contacts", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const lin = yield* owner("lin");
        const write = () =>
          smtp({ from: "lin-store@store.example", to: lin.alias, subject: "Hi", text: "Hello" });
        expect(yield* invoke(yield* write())).toEqual([{ _tag: "Forwarded" }]);
        const reverse = (yield* sentTo(lin.mailbox)).at(-1)?.from ?? "";
        const contactsPath = "/v1/aliases/lin.alias.test/shop/contacts";
        expect(yield* call(contactsPath, { cookie: lin.cookie })).toMatchObject({
          body: [{ address: "lin-store@store.example" }],
        });

        const aliasPath = "/v1/aliases/lin.alias.test/shop";
        expect((yield* call(aliasPath, { cookie: lin.cookie, method: "DELETE" })).status).toBe(204);
        // Nothing in the table remembers the contact, a third party's address.
        expect(yield* itemsMentioning("lin-store@store.example")).toEqual([]);
        expect(yield* invoke(yield* write())).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        const reply = yield* smtp({
          from: lin.mailbox,
          to: reverse,
          subject: "Re: Hi",
          text: "Still there?",
        });
        expect(yield* invoke(reply)).toEqual([{ _tag: "Dropped", reason: "unknown-alias" }]);
        expect(yield* sentTo("lin-store@store.example")).toEqual([]);

        // Its owner may create it again: a new alias that knows no one yet.
        const again = yield* call("/v1/aliases", {
          cookie: lin.cookie,
          body: { _tag: "Address", address: lin.alias, mode: "forward" },
        });
        expect(again.status).toBe(201);
        expect(yield* call(contactsPath, { cookie: lin.cookie })).toMatchObject({ body: [] });
        // The old reverse alias stays dead: it named a contact the new alias doesn't have.
        expect(yield* invoke(reply)).toEqual([{ _tag: "Dropped", reason: "unknown-contact" }]);
      }),
    );

    it.effect("erasing an account leaves only tombstones, and its username stays taken", () =>
      Effect.gen(function* () {
        yield* Transport.ensureIdentity("alias.test");
        const moe = yield* owner("moe");
        const write = () =>
          smtp({ from: "moe-pal@pal.example", to: moe.alias, subject: "Hi", text: "Hello" });
        expect(yield* invoke(yield* write())).toEqual([{ _tag: "Forwarded" }]);
        const reverse = (yield* sentTo(moe.mailbox)).at(-1)?.from ?? "";

        const started = yield* call("/v1/me/erase/options", { cookie: moe.cookie, body: {} });
        const erased = yield* call("/v1/me/erase", {
          cookie: moe.cookie,
          body: {
            challengeId: started.body.challengeId,
            credential: moe.authenticator.get(started.body.options),
          },
        });
        expect(erased.status).toBe(204);

        expect((yield* call("/v1/me", { cookie: moe.cookie })).status).toBe(401);
        expect(
          yield* call("/v1/auth/register/options", { body: { username: "moe" } }),
        ).toMatchObject({ status: 409, body: { _tag: "UsernameTaken" } });
        expect(yield* invoke(yield* write())).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        const reply = yield* smtp({
          from: moe.mailbox,
          to: reverse,
          subject: "Re: Hi",
          text: "Still there?",
        });
        expect(yield* invoke(reply)).toEqual([{ _tag: "Dropped", reason: "unknown-alias" }]);

        // Nothing names the user, their mailbox or their contact any more.
        expect(yield* itemsMentioning(moe.userId)).toEqual([]);
        expect(yield* itemsMentioning("moe@mailbox.example")).toEqual([]);
        expect(yield* itemsMentioning("moe-pal@pal.example")).toEqual([]);
        // What is left: the username's tombstone, and the idempotency claim of the one message
        // forwarded, which names the alias address until its one-week TTL (PLAN.md §20.15).
        const left = yield* itemsMentioning("moe.alias.test");
        expect(Arr.map(left, (item) => item.pk?.S?.split("#")[0])).toEqual(["DELIVERY"]);
        expect(yield* itemsMentioning(`USERNAME#${Username.skeleton("moe")}`)).toEqual([
          {
            pk: { S: `USERNAME#${Username.skeleton("moe")}` },
            sk: { S: "USERNAME" },
            deletedAt: expect.anything(),
          },
        ]);
      }),
    );
  });
});
