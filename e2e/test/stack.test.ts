import { MailSettings, RelyingParty, makeFunctionUrlHandler } from "@alias/api";
import { TestAuthenticator } from "@alias/api/testing";
import { AwsClient, Inbound, SesEvent, Transport } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { SharedDomains } from "@alias/core";
import { type Dynamo } from "@alias/db";
import { freshTable } from "@alias/db/testing";
import { Pipeline, ReverseKeys, Spool } from "@alias/inbound";
import { FunctionUrlServer } from "@alias/lambda-emulator";
import { SesEmulator } from "@alias/ses-emulator";
import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { createTransport } from "nodemailer";

/**
 * The whole emulated stack, every listener on port 0:
 * - SMTP → SES emulator (receipt rules, verdicts) → S3 spool on fakecloud → SES Lambda event →
 *   the real inbound pipeline → SES sending on fakecloud;
 * - HTTP → function URL emulator → the real API Lambda handler → DynamoDB on fakecloud.
 * One fakecloud process serves S3, DynamoDB and SES, as one AWS account would, and both Lambdas
 * share one table.
 */
const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), (fakecloud) => AwsClient.emulator(fakecloud.url)),
);
const spoolBucket = "alias-spool";
const spool = Layer.effectDiscard(Inbound.ensureSpool(spoolBucket)).pipe(Layer.provide(aws));
const database = freshTable();
const origin = "https://alias.test";
const sharedDomains = SharedDomains.layer("alias.test");
const sending = Transport.ses.pipe(Layer.provide(aws));

/** The real API Lambda behind the function URL emulator. */
const api = Layer.unwrap(
  Effect.gen(function* () {
    const context = yield* Effect.context<Dynamo.Database>();
    const fakecloud = yield* FakeCloud.FakeCloud;
    const { handle, dispose } = makeFunctionUrlHandler(
      Layer.mergeAll(
        Layer.succeedContext(context),
        RelyingParty.layer({ id: "alias.test", origin }),
        Transport.ses.pipe(Layer.provide(AwsClient.emulator(fakecloud.url))),
        MailSettings.layer(Option.some("no-reply@alias.test")).pipe(
          Layer.provideMerge(sharedDomains),
        ),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    return FunctionUrlServer.layer({ handler: (event) => Effect.runPromise(handle(event)) });
  }),
);

/** The real inbound pipeline on the same table, spool and SES. */
const inbound = Pipeline.layer(
  Layer.mergeAll(
    database,
    sending,
    Spool.layer(spoolBucket).pipe(Layer.provide(aws)),
    sharedDomains,
    ReverseKeys.layer(Redacted.make(`1:${Buffer.alloc(32, 9).toString("base64url")}`)),
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

const stack = Layer.mergeAll(api.pipe(Layer.provide(database)), inbound, ses, aws).pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(FakeCloud.layer()),
);

/** A browser-ish HTTP call: JSON in and out, the session cookie passed by hand. */
const call = (
  path: string,
  init: {
    readonly body?: Schema.Json;
    readonly cookie?: string;
    readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  } = {},
) =>
  Effect.gen(function* () {
    const { url } = yield* FunctionUrlServer.FunctionUrlServer;
    const headers = new Headers({ "content-type": "application/json", origin });
    if (init.cookie !== undefined) headers.set("cookie", init.cookie);
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
    return { cookie, userId: String(registered.body.userId) };
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
const owner = (username: string) =>
  Effect.gen(function* () {
    const { cookie, userId } = yield* signUp(username);
    const mailbox = `${username}@mailbox.example`;
    const added = yield* call("/v1/recipients", { cookie, body: { address: mailbox } });
    expect(added.status).toBe(201);
    const [confirmation] = yield* sentTo(mailbox);
    const token = new URL(
      /https:\/\/alias\.test\/forwarding\?\S+/.exec(confirmation?.text ?? "")?.[0] ?? "x:",
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
    return { cookie, userId, mailbox, alias };
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
  });
});
