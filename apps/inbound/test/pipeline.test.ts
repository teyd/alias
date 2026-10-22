import { AwsClient, Inbound, type SesEvent, Transport } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { Pgp, SharedDomains, Username } from "@alias/core";
import {
  AliasRepo,
  ContactRepo,
  DomainRepo,
  RecipientRepo,
  UserRepo,
  WebhookRepo,
} from "@alias/db";
import { freshTable } from "@alias/db/testing";
import { freshQueue, TestQueue } from "@alias/webhooks/testing";
import * as S3 from "@distilled.cloud/aws/s3";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as openpgp from "openpgp";
import { ImageProxySigner, Limits, Pipeline, ReverseKeys, Spool } from "../src/index.ts";

/**
 * The pipeline as the Lambda runs it, on one fakecloud: the real repositories on a fresh table,
 * the S3 spool and SES sending. Events are shaped like the documented SES Lambda event; the
 * end-to-end path from SMTP is in `e2e/test/stack.test.ts`.
 */
const bucket = "alias-spool";
const keys = Redacted.make(`1:${Buffer.alloc(32, 7).toString("base64url")}`);

const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

const pipeline = (limits?: Limits.Limits["Service"]) =>
  Layer.unwrap(
    Effect.sync(() => {
      // One queue: the pipeline publishes to it, tests read it (`TestQueue`).
      const queue = freshQueue();
      return Pipeline.layer(
        Layer.mergeAll(
          freshTable(),
          queue,
          Transport.ses.pipe(Layer.provide(aws)),
          Spool.layer(bucket).pipe(Layer.provide(aws)),
          SharedDomains.layer("alias.test"),
          ReverseKeys.layer(keys),
          ImageProxySigner.layer("https://img.alias.test", keys),
        ),
        limits,
      ).pipe(Layer.provideMerge(queue));
    }),
  );

/** Each test gets its own fakecloud, so sent mail and the spool start empty. */
const withPipeline = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Layer.Success<ReturnType<typeof pipeline>> | AwsClient.AwsClient | FakeCloud.FakeCloud
  >,
  limits?: Limits.Limits["Service"],
) =>
  Effect.gen(function* () {
    yield* Inbound.ensureSpool(bucket);
    // fakecloud only accepts senders on an exactly verified domain; AWS also accepts its
    // subdomains (PLAN.md §20.5), so the user subdomain is verified explicitly here.
    yield* Effect.forEach(["alias.test", "user1.alias.test"], Transport.ensureIdentity, {
      concurrency: 1,
    });
    return yield* effect;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(pipeline(limits), aws).pipe(Layer.provideMerge(FakeCloud.layer())),
    ),
  );

let messages = 0;

type Status = SesEvent.VerdictStatus;

interface Received {
  readonly recipients: ReadonlyArray<string>;
  readonly from?: string;
  readonly source?: string;
  readonly verdicts?: Partial<Record<"spam" | "virus" | "dkim" | "dmarc", Status>>;
  /** Extra header fields, on top of the default message. */
  readonly headers?: ReadonlyArray<string>;
  readonly raw?: Uint8Array;
}

/** Stores a message in the spool the way the SES S3 action does and returns its Lambda event. */
const receive = Effect.fn("receive")(function* (mail: Received) {
  messages += 1;
  const messageId = `msg${messages}`;
  const from = mail.from ?? '"Shop" <shop@store.example>';
  const raw =
    mail.raw ??
    new TextEncoder().encode(
      [
        "Return-Path: <bounce@store.example>",
        "Authentication-Results: amazonses.com; spf=pass; dkim=pass; dmarc=pass",
        ...(mail.headers ?? []),
        `From: ${from}`,
        `To: ${mail.recipients.join(", ")}`,
        "Subject: Order confirmed",
        "Message-ID: <order-1@store.example>",
        "",
        "Thanks for your order!",
        "",
      ].join("\r\n"),
    );
  yield* S3.putObject({
    Bucket: bucket,
    Key: Inbound.objectKey(Inbound.spoolPrefix, messageId),
    Body: raw,
  });
  const verdict = (name: "spam" | "virus" | "dkim" | "dmarc") => ({
    status: mail.verdicts?.[name] ?? "PASS",
  });
  const event: SesEvent.SesEvent = {
    Records: [
      {
        eventSource: "aws:ses",
        eventVersion: "1.0",
        ses: {
          mail: {
            timestamp: "2026-10-22T09:00:00.000Z",
            source: mail.source ?? "bounce@store.example",
            messageId,
            destination: mail.recipients,
            headers: [],
            commonHeaders: { from: [from], subject: "Order confirmed" },
          },
          receipt: {
            timestamp: "2026-10-22T09:00:00.000Z",
            processingTimeMillis: 10,
            recipients: mail.recipients,
            spamVerdict: verdict("spam"),
            virusVerdict: verdict("virus"),
            spfVerdict: { status: "PASS" },
            dkimVerdict: verdict("dkim"),
            dmarcVerdict: verdict("dmarc"),
            action: {
              type: "Lambda",
              functionArn: "arn:aws:lambda:eu-west-1:000000000000:function:inbound",
              invocationType: "Event",
            },
          },
        },
      },
    ],
  };
  return { messageId, event };
});

const alias = (overrides: Partial<AliasRepo.NewAlias> = {}) =>
  AliasRepo.AliasRepo.use((repo) =>
    repo.insert({
      id: "al_shop",
      userId: "usr_1",
      domain: "alias.test",
      localPart: "shop",
      mode: "forward",
      createdAt: 0,
      ...overrides,
    }),
  );

/** Adds a forwarding address the way the API does, confirmed unless `isPending`. */
const recipient = Effect.fn("recipient")(function* (
  address: string,
  options: { readonly userId?: string; readonly isPending?: boolean } = {},
) {
  const repo = yield* RecipientRepo.RecipientRepo;
  const now = yield* DateTime.now;
  const added = {
    id: `rcp_${address}`,
    userId: options.userId ?? "usr_1",
    address,
    createdAt: now,
  };
  const expiresAt = DateTime.add(now, { hours: 1 });
  yield* repo.add(added, { tokenHash: "hash", expiresAt, sentAt: now }, 10);
  if (options.isPending !== true) {
    yield* repo.confirm(
      {
        ...added,
        verifiedAt: Option.none(),
        lastSentAt: now,
        isDefault: false,
        bouncedAt: Option.none(),
        complainedAt: Option.none(),
        encryption: Option.none(),
      },
      "hash",
      now,
    );
  }
});

/** Registers `user1` the way the API does, with on-the-fly aliases on or off. */
const subdomainOwner = Effect.fn("subdomainOwner")(function* (isOnTheFlyEnabled: boolean) {
  const users = yield* UserRepo.UserRepo;
  const createdAt = DateTime.makeUnsafe(0);
  yield* users.register(
    { id: "usr_1", username: yield* Username.parse("user1"), createdAt },
    {
      id: "cred_1",
      userId: "usr_1",
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: [],
      createdAt,
    },
  );
  yield* users.updateSettings("usr_1", { isOnTheFlyEnabled });
  yield* recipient("ada@mail.example");
});

const aliasAt = (domain: string, localPart: string) =>
  AliasRepo.AliasRepo.use((repo) => repo.findByAddress(domain, localPart));

const contacts = ContactRepo.ContactRepo.use((repo) => repo.list("al_shop"));

/** Forwards one message from `from` to shop@alias.test and returns the reverse alias it got. */
const forwardFrom = Effect.fn("forwardFrom")(function* (from: string) {
  const { event } = yield* receive({ from, recipients: ["shop@alias.test"] });
  const outcomes = yield* Pipeline.handle(event);
  return { outcomes, reverse: Arr.last(yield* sent).pipe(Option.map((email) => email.from)) };
});

/** The owner, authenticated, replies to `reverse`. */
const replyTo = Effect.fn("replyTo")(function* (reverse: string) {
  const { event } = yield* receive({ from: "ada@mail.example", recipients: [reverse] });
  return yield* Pipeline.handle(event);
});

const sent = FakeCloud.sentEmails();

const text = (bytes: Option.Option<Uint8Array>) =>
  new TextDecoder().decode(Option.getOrElse(bytes, () => new Uint8Array()));

/** The first field called `name`, unfolded. */
const header = (raw: string, name: string) =>
  Arr.findFirst(
    raw
      .split("\r\n\r\n")[0]
      ?.replace(/\r\n[ \t]/g, " ")
      .split("\r\n") ?? [],
    (line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`),
  ).pipe(Option.map((line) => line.slice(name.length + 1).trim()));

const counters = AliasRepo.AliasRepo.use((repo) => repo.findByAddress("alias.test", "shop")).pipe(
  Effect.map(Option.map((found) => [found.forwardedCount, found.blockedCount])),
);

const spoolHolds = (messageId: string) =>
  Inbound.readMessage(bucket, messageId).pipe(
    Effect.as(true),
    Effect.catchTag("MessageGone", () => Effect.succeed(false)),
  );

/** The webhook jobs on the test's queue: what the delivery Lambda would post. */
const queuedJobs = Effect.fn("queuedJobs")(function* () {
  const { queueUrl } = yield* TestQueue;
  const { Messages = [] } = yield* SQS.receiveMessage({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
  });
  return Arr.map(Messages, (message) => message.Body ?? "");
});

describe("inbound pipeline (fakecloud)", () => {
  it.effect("tells the owner's webhooks what happened, without content or sender addresses", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* subdomainOwner(true);
        yield* alias();
        yield* WebhookRepo.WebhookRepo.use((repo) =>
          repo.create({
            id: "wh_1",
            userId: "usr_1",
            url: "https://hooks.example.com/",
            eventTypes: ["mail.forwarded", "mail.blocked", "alias.created"],
            secret: "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0",
            createdAt: DateTime.makeUnsafe(0),
          }),
        ).pipe(Effect.provide(WebhookRepo.layer));
        const forwarded = yield* receive({ recipients: ["shop@alias.test"] });
        yield* Pipeline.handle(forwarded.event);
        // A redelivery publishes nothing new.
        yield* Pipeline.handle(forwarded.event);
        const spam = yield* receive({
          recipients: ["shop@alias.test"],
          verdicts: { spam: "FAIL" },
        });
        yield* Pipeline.handle(spam.event);
        const onTheFly = yield* receive({ recipients: ["club@user1.alias.test"] });
        yield* Pipeline.handle(onTheFly.event);

        const bodies = yield* queuedJobs();
        const events = Arr.map(bodies, (body) => JSON.parse(body).event);
        const [contact] = yield* contacts;
        expect(
          Arr.sort(
            Arr.map(events, (event) => String(event.type)),
            Order.String,
          ),
        ).toEqual(["alias.created", "mail.blocked", "mail.forwarded", "mail.forwarded"]);
        expect(events).toContainEqual({
          type: "mail.forwarded",
          timestamp: expect.any(String),
          data: { aliasId: "al_shop", address: "shop@alias.test", contactId: contact?.id },
        });
        expect(events).toContainEqual({
          type: "mail.blocked",
          timestamp: expect.any(String),
          data: { aliasId: "al_shop", address: "shop@alias.test", reason: "spam" },
        });
        expect(events).toContainEqual({
          type: "alias.created",
          timestamp: expect.any(String),
          data: {
            aliasId: expect.any(String),
            address: "club@user1.alias.test",
            origin: "on-the-fly",
          },
        });
        expect(bodies.join("\n")).not.toContain("store.example");
        expect(bodies.join("\n")).not.toContain("Order confirmed");
      }),
    ),
  );

  it.effect("forwards to the owner's default recipient through a reverse alias", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const { messageId, event } = yield* receive({ recipients: ["Shop@alias.test"] });

        expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Forwarded" }]);

        const [email] = yield* sent;
        expect(email?.to).toEqual(["ada@mail.example"]);
        expect(email?.from).toMatch(/^shop\+r\.[a-z2-7]+@alias\.test$/);
        const raw = text(email?.raw ?? Option.none());
        expect(header(raw, "From")).toEqual(
          Option.some(`"Shop (shop@store.example)" <${email?.from}>`),
        );
        expect(header(raw, "Reply-To")).toEqual(header(raw, "From"));
        expect(header(raw, "Return-Path")).toEqual(Option.none());
        expect(raw).toContain("\r\n\r\nThanks for your order!");
        expect(yield* counters).toEqual(Option.some([1, 0]));
        expect(yield* spoolHolds(messageId)).toBe(false);
      }),
    ),
  );

  it.effect("drops silently what it can't deliver, and deletes the spooled copy", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* alias({ id: "al_temp", localPart: "temp", mode: "inbox" });
        yield* alias({ id: "al_lone", userId: "usr_2", localPart: "lone" });
        yield* recipient("pending@mail.example", { userId: "usr_2", isPending: true });
        const { messageId, event } = yield* receive({
          recipients: [
            "nobody@alias.test",
            "shop@custom.example",
            "temp@alias.test",
            "lone@alias.test",
          ],
        });

        expect(yield* Pipeline.handle(event)).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
          { _tag: "Dropped", reason: "unknown-domain" },
          { _tag: "Dropped", reason: "inbox-mode" },
          { _tag: "Dropped", reason: "no-recipient" },
        ]);
        expect(yield* sent).toEqual([]);
        expect(yield* spoolHolds(messageId)).toBe(false);
      }),
    ),
  );

  it.effect.each<{
    readonly name: string;
    readonly verdicts: NonNullable<Received["verdicts"]>;
    readonly isActive: boolean;
    readonly reason: string;
  }>([
    { name: "a virus", verdicts: { virus: "FAIL" }, isActive: true, reason: "virus" },
    { name: "spam", verdicts: { spam: "FAIL" }, isActive: true, reason: "spam" },
    { name: "mail to a disabled alias", verdicts: {}, isActive: false, reason: "inactive-alias" },
  ])("blocks $name and counts it on the alias", ({ verdicts, isActive, reason }) =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        if (!isActive) {
          yield* AliasRepo.AliasRepo.use((repo) =>
            repo.update(
              { userId: "usr_1", domain: "alias.test", localPart: "shop" },
              { isActive: false },
            ),
          );
        }
        const { event } = yield* receive({
          recipients: ["shop@alias.test"],
          verdicts,
        });

        expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Dropped", reason }]);
        expect(yield* sent).toEqual([]);
        expect(yield* counters).toEqual(Option.some([0, 1]));
      }),
    ),
  );

  it.effect("rejects reverse aliases with a token we didn't sign for that alias", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* alias({ id: "al_news", localPart: "news" });
        yield* recipient("ada@mail.example");
        const forward = yield* receive({ recipients: ["shop@alias.test"] });
        yield* Pipeline.handle(forward.event);
        const reverse = (yield* sent)[0]?.from ?? "";
        const token = reverse.slice(reverse.indexOf("+r.") + 3, reverse.indexOf("@"));

        const { event } = yield* receive({
          from: "ada@mail.example",
          recipients: [`news+r.${token}@alias.test`, "shop+r.aaaaaaaaaaaaaaaaaaaaaaaa@alias.test"],
        });
        expect(yield* Pipeline.handle(event)).toEqual([
          { _tag: "Dropped", reason: "bad-token" },
          { _tag: "Dropped", reason: "bad-token" },
        ]);
        expect(yield* sent).toHaveLength(1);
      }),
    ),
  );

  it.effect("sends nothing twice when Lambda redelivers an event", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const { messageId, event } = yield* receive({ recipients: ["shop@alias.test"] });
        expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Forwarded" }]);

        // After a clean run the spool is gone; after a crash before the delete it isn't.
        expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Duplicate" }]);
        yield* S3.putObject({
          Bucket: bucket,
          Key: Inbound.objectKey(Inbound.spoolPrefix, messageId),
          Body: new TextEncoder().encode("From: shop@store.example\r\n\r\nagain"),
        });
        const [again, concurrent] = yield* Effect.all(
          [Pipeline.handle(event), Pipeline.handle(event)],
          { concurrency: 2 },
        );
        expect([again, concurrent]).toEqual([[{ _tag: "Duplicate" }], [{ _tag: "Duplicate" }]]);

        expect(yield* sent).toHaveLength(1);
        expect(yield* counters).toEqual(Option.some([1, 0]));
        expect(yield* spoolHolds(messageId)).toBe(false);
      }),
    ),
  );

  it.effect("keeps the mail for Lambda's retry while SES sending is paused", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const { messageId, event } = yield* receive({ recipients: ["shop@alias.test"] });
        yield* SESV2.putAccountSendingAttributes({ SendingEnabled: false });

        const error = yield* Effect.flip(Pipeline.handle(event));
        expect(error).toMatchObject({
          _tag: "InboundDeferred",
          messageId,
          codes: ["SendingPausedException"],
        });
        expect(yield* spoolHolds(messageId)).toBe(true);

        yield* SESV2.putAccountSendingAttributes({ SendingEnabled: true });
        expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Forwarded" }]);
        expect(yield* sent).toHaveLength(1);
        expect(yield* spoolHolds(messageId)).toBe(false);
      }),
    ),
  );

  it.effect("forwards newsletters: Precedence and Auto-Submitted alone drop nothing", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const { event } = yield* receive({
          recipients: ["shop@alias.test"],
          headers: ["Precedence: bulk", "Auto-Submitted: auto-generated", "List-Id: <news.store>"],
        });

        expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Forwarded" }]);
      }),
    ),
  );

  it.effect("drops a forwarded copy that comes back to the alias, and counts it as blocked", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        yield* Pipeline.handle((yield* receive({ recipients: ["shop@alias.test"] })).event);
        const [copy] = yield* sent;
        expect(header(text(copy?.raw ?? Option.none()), "X-Alias-Forwarded")).toEqual(
          Option.some("shop@alias.test"),
        );

        // The owner's mailbox redirects it to the alias again, headers and all.
        const looped = yield* receive({
          recipients: ["shop@alias.test"],
          raw: Option.getOrElse(copy?.raw ?? Option.none(), () => new Uint8Array()),
        });
        expect(yield* Pipeline.handle(looped.event)).toEqual([{ _tag: "Dropped", reason: "loop" }]);
        expect(yield* sent).toHaveLength(1);
        expect(yield* counters).toEqual(Option.some([1, 1]));
        expect(yield* spoolHolds(looped.messageId)).toBe(false);
      }),
    ),
  );

  it.effect("drops mail that made more hops than the limit", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const hops = (count: number) =>
          Arr.makeBy(
            count,
            (i) => `Received: from hop${i}.relay.example by hop${i + 1}.relay.example`,
          );
        const within = yield* receive({ recipients: ["shop@alias.test"], headers: hops(50) });
        const beyond = yield* receive({ recipients: ["shop@alias.test"], headers: hops(51) });

        expect(yield* Pipeline.handle(within.event)).toEqual([{ _tag: "Forwarded" }]);
        expect(yield* Pipeline.handle(beyond.event)).toEqual([{ _tag: "Dropped", reason: "loop" }]);
      }),
    ),
  );

  it.effect("caps forwards per alias and hour, counting the rest as blocked", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* alias({ id: "al_news", localPart: "news" });
        yield* recipient("ada@mail.example");
        const outcomes = yield* Effect.forEach(
          ["shop@alias.test", "shop@alias.test", "shop@alias.test", "news@alias.test"],
          (address) =>
            Effect.flatMap(receive({ recipients: [address] }), ({ event }) =>
              Pipeline.handle(event),
            ),
          { concurrency: 1 },
        );

        expect(Arr.flatten(outcomes)).toEqual([
          { _tag: "Forwarded" },
          { _tag: "Forwarded" },
          { _tag: "Dropped", reason: "rate-limited" },
          { _tag: "Forwarded" },
        ]);
        expect(yield* sent).toHaveLength(3);
        expect(yield* counters).toEqual(Option.some([2, 1]));
      }),
      { ...Limits.defaults, forwardsPerHour: 2 },
    ),
  );

  it.effect("drops oversized mail before reading it, and counts it as blocked", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const small = yield* receive({ recipients: ["shop@alias.test"] });
        const large = yield* receive({
          recipients: ["shop@alias.test"],
          raw: new TextEncoder().encode(`From: shop@store.example\r\n\r\n${"x".repeat(2_000)}`),
        });

        expect(yield* Pipeline.handle(small.event)).toEqual([{ _tag: "Forwarded" }]);
        expect(yield* Pipeline.handle(large.event)).toEqual([
          { _tag: "Dropped", reason: "too-large" },
        ]);
        expect(yield* counters).toEqual(Option.some([1, 1]));
        expect(yield* spoolHolds(large.messageId)).toBe(false);
      }),
      { ...Limits.defaults, maxMessageBytes: 1_000 },
    ),
  );

  it.effect("drops auto-replies and bounces sent to a reverse alias", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        yield* Pipeline.handle((yield* receive({ recipients: ["shop@alias.test"] })).event);
        const reverse = (yield* sent)[0]?.from ?? "";

        const outOfOffice = yield* receive({
          from: "ada@mail.example",
          source: "ada@mail.example",
          recipients: [reverse],
          headers: ["Auto-Submitted: auto-replied"],
        });
        const bounce = yield* receive({
          from: "MAILER-DAEMON@mail.example",
          source: "",
          recipients: [reverse],
          headers: ['Content-Type: multipart/report; report-type=delivery-status; boundary="b"'],
        });
        expect(yield* Pipeline.handle(outOfOffice.event)).toEqual([
          { _tag: "Dropped", reason: "auto-reply" },
        ]);
        expect(yield* Pipeline.handle(bounce.event)).toEqual([
          { _tag: "Dropped", reason: "bounce" },
        ]);
        expect(yield* sent).toHaveLength(1);
        // Only the alias's own mail is counted; refused replies never were.
        expect(yield* counters).toEqual(Option.some([1, 0]));
      }),
    ),
  );

  it.effect("creates an alias on the fly for mail to a new address on an opted-in subdomain", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* subdomainOwner(true);
        const first = yield* receive({ recipients: ["New@User1.alias.test"] });
        const again = yield* receive({ recipients: ["new@user1.alias.test"] });

        expect(yield* Pipeline.handle(first.event)).toEqual([{ _tag: "Forwarded" }]);
        expect(yield* aliasAt("user1.alias.test", "new")).toEqual(
          Option.some(
            expect.objectContaining({
              userId: "usr_1",
              mode: "forward",
              isActive: true,
              forwardedCount: 1,
            }),
          ),
        );
        expect(yield* Pipeline.handle(again.event)).toEqual([{ _tag: "Forwarded" }]);
        const forwardedFrom = Arr.map(yield* sent, (email) => email.from);
        expect(forwardedFrom).toEqual([
          expect.stringMatching(/^new\+r\.[a-z2-7]+@user1\.alias\.test$/),
          expect.stringMatching(/^new\+r\.[a-z2-7]+@user1\.alias\.test$/),
        ]);
        expect(yield* AliasRepo.AliasRepo.use((repo) => repo.listByUser("usr_1"))).toHaveLength(1);
      }),
    ),
  );

  it.effect("creates nothing unless the subdomain's owner opted in", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* subdomainOwner(false);
        const { event } = yield* receive({
          recipients: ["new@user1.alias.test", "new@nobody.alias.test", "new@alias.test"],
        });

        expect(yield* Pipeline.handle(event)).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
          { _tag: "Dropped", reason: "unknown-alias" },
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        expect(yield* aliasAt("user1.alias.test", "new")).toEqual(Option.none());
        expect(yield* sent).toEqual([]);
      }),
    ),
  );

  it.effect("never creates an alias for spam, a virus or a reverse alias", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* subdomainOwner(true);
        const spam = yield* receive({
          recipients: ["spam@user1.alias.test"],
          verdicts: { spam: "FAIL" },
        });
        const virus = yield* receive({
          recipients: ["virus@user1.alias.test"],
          verdicts: { virus: "FAIL" },
        });
        const reply = yield* receive({ recipients: ["reply+r.abcd@user1.alias.test"] });

        expect(yield* Pipeline.handle(spam.event)).toEqual([{ _tag: "Dropped", reason: "spam" }]);
        expect(yield* Pipeline.handle(virus.event)).toEqual([{ _tag: "Dropped", reason: "virus" }]);
        expect(yield* Pipeline.handle(reply.event)).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        expect(yield* AliasRepo.AliasRepo.use((repo) => repo.listByUser("usr_1"))).toEqual([]);
      }),
    ),
  );

  it.effect("caps aliases created on the fly per user and day; existing ones keep working", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* subdomainOwner(true);
        const outcomes = yield* Effect.forEach(
          ["one@user1.alias.test", "two@user1.alias.test", "one@user1.alias.test"],
          (address) =>
            Effect.flatMap(receive({ recipients: [address] }), ({ event }) =>
              Pipeline.handle(event),
            ),
          { concurrency: 1 },
        );

        expect(Arr.flatten(outcomes)).toEqual([
          { _tag: "Forwarded" },
          { _tag: "Dropped", reason: "creation-limited" },
          { _tag: "Forwarded" },
        ]);
        expect(yield* aliasAt("user1.alias.test", "two")).toEqual(Option.none());
      }),
      { ...Limits.defaults, aliasesCreatedPerDay: 1 },
    ),
  );

  it.effect("creates one alias when two messages to a new address arrive at once", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* subdomainOwner(true);
        const first = yield* receive({ recipients: ["race@user1.alias.test"] });
        const second = yield* receive({ recipients: ["race@user1.alias.test"] });

        const outcomes = yield* Effect.all(
          [Pipeline.handle(first.event), Pipeline.handle(second.event)],
          { concurrency: 2 },
        );
        expect(outcomes).toEqual([[{ _tag: "Forwarded" }], [{ _tag: "Forwarded" }]]);
        expect(yield* AliasRepo.AliasRepo.use((repo) => repo.listByUser("usr_1"))).toHaveLength(1);
        expect(yield* sent).toHaveLength(2);
      }),
    ),
  );

  it.effect("drops mail to a deleted alias and to its reverse aliases like unknown mail", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const { reverse } = yield* forwardFrom("orders@store.example");
        yield* AliasRepo.AliasRepo.use((repo) =>
          repo.delete({ userId: "usr_1", domain: "alias.test", localPart: "shop" }),
        );

        expect((yield* forwardFrom("orders@store.example")).outcomes).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        expect(yield* replyTo(Option.getOrElse(reverse, () => ""))).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        expect(yield* contacts).toEqual([]);
        expect(yield* sent).toHaveLength(1);
      }),
    ),
  );

  it.effect("never brings a deleted alias back on the fly, nor spends the daily cap on it", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* subdomainOwner(true);
        const deliver = (address: string) =>
          Effect.flatMap(receive({ recipients: [address] }), ({ event }) => Pipeline.handle(event));
        expect(yield* deliver("club@user1.alias.test")).toEqual([{ _tag: "Forwarded" }]);
        yield* AliasRepo.AliasRepo.use((repo) =>
          repo.delete({ userId: "usr_1", domain: "user1.alias.test", localPart: "club" }),
        );

        const outcomes = yield* Effect.forEach(
          ["club@user1.alias.test", "Club@user1.alias.test", "fresh@user1.alias.test"],
          deliver,
          { concurrency: 1 },
        );
        expect(Arr.flatten(outcomes)).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
          { _tag: "Dropped", reason: "unknown-alias" },
          { _tag: "Forwarded" },
        ]);
        expect(yield* aliasAt("user1.alias.test", "club")).toEqual(Option.none());
      }),
      { ...Limits.defaults, aliasesCreatedPerDay: 2 },
    ),
  );

  it.effect("creates a contact on a sender's first message and keeps its reverse alias", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const first = yield* forwardFrom('"Shop" <Orders@Store.example>');
        const second = yield* forwardFrom("orders@store.example");

        expect([first.outcomes, second.outcomes]).toEqual([
          [{ _tag: "Forwarded" }],
          [{ _tag: "Forwarded" }],
        ]);
        expect(second.reverse).toEqual(first.reverse);
        expect(yield* contacts).toEqual([
          expect.objectContaining({
            address: "Orders@Store.example",
            name: Option.some("Shop"),
            isBlocked: false,
          }),
        ]);

        expect(yield* replyTo(Option.getOrElse(first.reverse, () => ""))).toEqual([
          { _tag: "Replied" },
        ]);
        expect(Arr.last(yield* sent).pipe(Option.map((email) => email.to))).toEqual(
          Option.some(["Orders@Store.example"]),
        );
      }),
    ),
  );

  it.effect("drops a blocked contact's mail as blocked, and replies to it", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const { reverse } = yield* forwardFrom("spammy@store.example");
        const [contact] = yield* contacts;
        yield* ContactRepo.ContactRepo.use((repo) =>
          repo.setBlocked("al_shop", contact?.id ?? "", true),
        );

        expect((yield* forwardFrom("spammy@store.example")).outcomes).toEqual([
          { _tag: "Dropped", reason: "blocked-contact" },
        ]);
        expect(yield* replyTo(Option.getOrElse(reverse, () => ""))).toEqual([
          { _tag: "Dropped", reason: "blocked-contact" },
        ]);
        expect(yield* sent).toHaveLength(1);
        expect(yield* counters).toEqual(Option.some([1, 1]));

        // Unblocked, both directions work again.
        yield* ContactRepo.ContactRepo.use((repo) =>
          repo.setBlocked("al_shop", contact?.id ?? "", false),
        );
        expect(yield* replyTo(Option.getOrElse(reverse, () => ""))).toEqual([{ _tag: "Replied" }]);
      }),
    ),
  );

  it.effect("drops replies to a deleted contact, even after the sender writes again", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const old = yield* forwardFrom("orders@store.example");
        const [contact] = yield* contacts;
        yield* ContactRepo.ContactRepo.use((repo) => repo.delete("al_shop", contact?.id ?? ""));

        expect(yield* replyTo(Option.getOrElse(old.reverse, () => ""))).toEqual([
          { _tag: "Dropped", reason: "unknown-contact" },
        ]);
        const fresh = yield* forwardFrom("orders@store.example");
        expect(fresh.reverse).not.toEqual(old.reverse);
        expect(yield* replyTo(Option.getOrElse(old.reverse, () => ""))).toEqual([
          { _tag: "Dropped", reason: "unknown-contact" },
        ]);
        expect(yield* replyTo(Option.getOrElse(fresh.reverse, () => ""))).toEqual([
          { _tag: "Replied" },
        ]);
      }),
    ),
  );

  it.effect("gives long sender addresses a short reverse alias that replies reach", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        const long = `${"newsletter.".repeat(18)}x@bounces.mail.store.example`;
        expect(long.length).toBeGreaterThan(200);
        const { outcomes, reverse } = yield* forwardFrom(long);

        expect(outcomes).toEqual([{ _tag: "Forwarded" }]);
        // Within RFC 5321's 64-octet local part, which a sender-carrying token couldn't be.
        expect(Option.getOrElse(reverse, () => "").split("@")[0]?.length).toBeLessThanOrEqual(64);
        expect(yield* replyTo(Option.getOrElse(reverse, () => ""))).toEqual([{ _tag: "Replied" }]);
        expect(Arr.last(yield* sent).pipe(Option.map((email) => email.to))).toEqual(
          Option.some([long]),
        );
        // Longer than any real address: nothing to key a contact by.
        const absurd = yield* forwardFrom(`${"x".repeat(250)}@store.example`);
        expect(absurd.outcomes).toEqual([{ _tag: "Dropped", reason: "unencodable-sender" }]);
      }),
    ),
  );

  it.effect("scrubs every one of the owner's addresses and their name from quoted text", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        yield* recipient("ada.work@office.example");
        const { reverse } = yield* forwardFrom("orders@store.example");
        const raw = [
          "From: Ada Lovelace <ada@mail.example>",
          `To: ${Option.getOrElse(reverse, () => "")}`,
          "Subject: Re: Order",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "See below. Ada Lovelace",
          "",
          "On Mon, Ada Lovelace <ada.work@office.example> wrote:",
          "> Sent from ada@mail.example",
          "",
        ].join("\r\n");
        const { event } = yield* receive({
          from: "Ada Lovelace <ada@mail.example>",
          recipients: [Option.getOrElse(reverse, () => "")],
          raw: new TextEncoder().encode(raw),
        });

        expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Replied" }]);
        const out = text(Arr.last(yield* sent).pipe(Option.flatMap((email) => email.raw)));
        expect(out).toContain(
          [
            "See below. Ada Lovelace",
            "",
            "On Mon, shop@alias.test <shop@alias.test> wrote:",
            "> Sent from shop@alias.test",
          ].join("\r\n"),
        );
        expect(out).not.toMatch(/ada@mail|ada\.work/);
      }),
    ),
  );

  it.effect(
    "removes tracking pixels by default and follows the owner's tracker settings, proxy included",
    () =>
      withPipeline(
        Effect.gen(function* () {
          yield* alias();
          yield* recipient("ada@mail.example");
          const newsletter = new TextEncoder().encode(
            [
              'From: "Shop" <shop@store.example>',
              "To: shop@alias.test",
              "Subject: Fall sale",
              "MIME-Version: 1.0",
              "Content-Type: text/html; charset=utf-8",
              "",
              '<a href="https://store.example/sale?utm_source=mail&amp;id=7">Sale</a>',
              '<img src="https://store.us1.list-manage.com/track/open.php?u=1" width="1" height="1">',
              "",
            ].join("\r\n"),
          );
          const forwarded = Effect.fn("forwarded")(function* () {
            const { event } = yield* receive({ recipients: ["shop@alias.test"], raw: newsletter });
            expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Forwarded" }]);
            return text(Arr.last(yield* sent).pipe(Option.flatMap((email) => email.raw)));
          });

          const blocked = yield* forwarded();
          expect(blocked).not.toContain("list-manage.com");
          expect(blocked).toContain("utm_source=mail");
          expect(header(blocked, "X-Alias-Trackers-Removed")).toEqual(Option.some("1"));

          yield* UserRepo.UserRepo.use((users) =>
            users.updateSettings("usr_1", { imageProtection: "off", isLinkCleaningEnabled: true }),
          );
          const cleaned = yield* forwarded();
          expect(cleaned).toContain("list-manage.com/track/open.php");
          expect(cleaned).toContain('<a href="https://store.example/sale?id=7">');
          expect(header(cleaned, "X-Alias-Trackers-Removed")).toEqual(Option.none());
          expect(header(cleaned, "X-Alias-Links-Cleaned")).toEqual(Option.some("1"));

          // Proxy mode: the pixel goes, and the newsletter's own images load through the proxy.
          yield* UserRepo.UserRepo.use((users) =>
            users.updateSettings("usr_1", { imageProtection: "proxy-images" }),
          );
          const withHero = new TextEncoder().encode(
            new TextDecoder()
              .decode(newsletter)
              .replace(
                "<a href",
                '<img src="https://img.store.example/hero.jpg" width="600"><a href',
              ),
          );
          const { event } = yield* receive({ recipients: ["shop@alias.test"], raw: withHero });
          expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Forwarded" }]);
          const proxied = text(Arr.last(yield* sent).pipe(Option.flatMap((email) => email.raw)));
          expect(proxied).toMatch(
            /<img src="https:\/\/img\.alias\.test\/img\/1\/[\w-]{22}\/[\w-]+" width="600">/,
          );
          expect(proxied).not.toContain("img.store.example");
          expect(proxied).not.toContain("list-manage.com");
          expect(header(proxied, "X-Alias-Images-Proxied")).toEqual(Option.some("1"));
        }),
      ),
  );

  it.effect("stops forwarding to a recipient SES reported as hard-bouncing", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        yield* RecipientRepo.RecipientRepo.use((repo) =>
          repo.markBounced("usr_1", "ada@mail.example", DateTime.makeUnsafe(1)),
        );
        const { messageId, event } = yield* receive({ recipients: ["shop@alias.test"] });

        expect(yield* Pipeline.handle(event)).toEqual([
          { _tag: "Dropped", reason: "recipient-bounced" },
        ]);
        expect(yield* sent).toEqual([]);
        expect(yield* spoolHolds(messageId)).toBe(false);
      }),
    ),
  );

  // fakecloud refuses a suppressed recipient; AWS documents accepting and dropping it, with a
  // bounce event (PLAN.md §20.11). Either way the pipeline can't send it again.
  it.effect("drops what SES refuses for the message itself", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* alias();
        yield* recipient("ada@mail.example");
        // A suppressed recipient: SES answers MessageRejected, and a retry would fail alike.
        yield* SESV2.putSuppressedDestination({
          EmailAddress: "ada@mail.example",
          Reason: "BOUNCE",
        });
        const { messageId, event } = yield* receive({ recipients: ["shop@alias.test"] });

        expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Dropped", reason: "rejected" }]);
        expect(yield* spoolHolds(messageId)).toBe(false);
      }),
    ),
  );

  describe("OpenPGP encryption (PLAN.md §20.21)", () => {
    const now = DateTime.makeUnsafe("2026-10-22T09:00:00Z");

    /** `keyExpirationTime` in seconds; 0 never expires. */
    const generate = (keyExpirationTime = 0) =>
      Effect.promise(() =>
        openpgp.generateKey({
          userIDs: [{ email: "ada@mail.example" }],
          type: "curve25519",
          date: DateTime.toDate(DateTime.subtract(now, { days: 1 })),
          keyExpirationTime,
          format: "object",
        }),
      );

    /** Stores the key on ada's recipient the way the API does, at the time the clock shows. */
    const encryptTo = Effect.fn("encryptTo")(function* (
      publicKey: openpgp.PublicKey,
      isSubjectHidden = false,
    ) {
      const repo = yield* RecipientRepo.RecipientRepo;
      const found = yield* Effect.flatMap(
        repo.find("usr_1", "rcp_ada@mail.example"),
        Effect.fromOption,
      );
      const key = yield* Pgp.readKey(publicKey.armor(), yield* DateTime.now);
      yield* repo.setEncryption(found, {
        publicKey: key.armored,
        fingerprint: key.fingerprint,
        userIds: key.userIds,
        expiresAt: key.expiresAt,
        isSubjectHidden,
      });
    });

    const decrypt = (raw: string, privateKey: openpgp.PrivateKey) =>
      Effect.promise(async () => {
        const armored = /-----BEGIN PGP MESSAGE-----[\s\S]*-----END PGP MESSAGE-----/.exec(
          raw,
        )?.[0];
        const { data } = await openpgp.decrypt({
          message: await openpgp.readMessage({ armoredMessage: armored ?? "" }),
          decryptionKeys: privateKey,
          format: "binary",
          date: DateTime.toDate(now),
        });
        return new TextDecoder().decode(data);
      });

    const lastSent = Effect.map(sent, (emails) =>
      text(Option.flatMap(Arr.last(emails), (email) => email.raw)),
    );

    it.effect(
      "forwards PGP/MIME to a recipient with a key, and plain mail once it is removed",
      () =>
        withPipeline(
          Effect.gen(function* () {
            yield* TestClock.setTime(DateTime.toEpochMillis(now));
            yield* alias();
            yield* recipient("ada@mail.example");
            const { publicKey, privateKey } = yield* generate();
            yield* encryptTo(publicKey);

            const { event } = yield* receive({ recipients: ["shop@alias.test"] });
            expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Forwarded" }]);
            const [email] = yield* sent;
            expect(email?.to).toEqual(["ada@mail.example"]);
            const raw = yield* lastSent;
            expect(header(raw, "Content-Type")).toEqual(
              Option.some(
                'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="=_alias_pgp_mime"',
              ),
            );
            // Routing stays outside: the reverse alias, the subject, the loop marker.
            expect(header(raw, "From")).toEqual(header(raw, "Reply-To"));
            expect(Option.getOrElse(header(raw, "From"), () => "")).toContain(email?.from ?? "-");
            expect(header(raw, "Subject")).toEqual(Option.some("Order confirmed"));
            expect(header(raw, "X-Alias-Forwarded")).toEqual(Option.some("shop@alias.test"));
            expect(raw).not.toContain("Thanks for your order!");
            // The body (no MIME headers here) decrypts exactly.
            expect(yield* decrypt(raw, privateKey)).toBe("\r\nThanks for your order!\r\n");
            expect(yield* counters).toEqual(Option.some([1, 0]));

            const repo = yield* RecipientRepo.RecipientRepo;
            yield* repo.removeEncryption(
              yield* Effect.flatMap(repo.find("usr_1", "rcp_ada@mail.example"), Effect.fromOption),
            );
            const again = yield* receive({ recipients: ["shop@alias.test"] });
            yield* Pipeline.handle(again.event);
            expect(yield* lastSent).toContain("Thanks for your order!");
            expect(header(yield* lastSent, "Content-Type")).toEqual(Option.none());
          }),
        ),
    );

    it.effect("hides the subject when the owner asked for it", () =>
      withPipeline(
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(now));
          yield* alias();
          yield* recipient("ada@mail.example");
          const { publicKey, privateKey } = yield* generate();
          yield* encryptTo(publicKey, true);
          const { event } = yield* receive({ recipients: ["shop@alias.test"] });
          yield* Pipeline.handle(event);
          const raw = yield* lastSent;
          expect(header(raw, "Subject")).toEqual(Option.some("[...]"));
          expect(raw).not.toContain("Order confirmed");
          const inner = yield* decrypt(raw, privateKey);
          expect(header(inner, "Subject")).toEqual(Option.some("Order confirmed"));
          expect(header(inner, "Content-Type")).toEqual(
            Option.some('text/plain; charset=us-ascii; protected-headers="v1"; hp="cipher"'),
          );
        }),
      ),
    );

    it.effect("passes mail that is already PGP/MIME encrypted as it is", () =>
      withPipeline(
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(now));
          yield* alias();
          yield* recipient("ada@mail.example");
          yield* encryptTo((yield* generate()).publicKey);
          const body = [
            "--enc",
            "Content-Type: application/pgp-encrypted",
            "",
            "Version: 1",
            "",
            "--enc",
            "Content-Type: application/octet-stream",
            "",
            "-----BEGIN PGP MESSAGE-----",
            "",
            "wV4DZmFrZQ==",
            "-----END PGP MESSAGE-----",
            "--enc--",
            "",
          ].join("\r\n");
          const { event } = yield* receive({
            recipients: ["shop@alias.test"],
            raw: new TextEncoder().encode(
              [
                'From: "Shop" <shop@store.example>',
                "To: shop@alias.test",
                "Subject: ...",
                "MIME-Version: 1.0",
                'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="enc"',
                "",
                body,
              ].join("\r\n"),
            ),
          });
          expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Forwarded" }]);
          const raw = yield* lastSent;
          expect(raw.endsWith(`\r\n\r\n${body}`)).toBe(true);
          expect(raw).not.toContain("alias_pgp_mime");
        }),
      ),
    );

    it.effect("never forwards in the clear once the key has expired: blocked as key-unusable", () =>
      withPipeline(
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(now));
          yield* alias();
          yield* recipient("ada@mail.example");
          // Valid for two days from its creation yesterday, then the clock moves past that.
          yield* encryptTo((yield* generate(2 * 24 * 3600)).publicKey);
          yield* TestClock.adjust("3 days");
          const { messageId, event } = yield* receive({ recipients: ["shop@alias.test"] });
          expect(yield* Pipeline.handle(event)).toEqual([
            { _tag: "Dropped", reason: "key-unusable" },
          ]);
          expect(yield* sent).toEqual([]);
          expect(yield* counters).toEqual(Option.some([0, 1]));
          expect(yield* spoolHolds(messageId)).toBe(false);
        }),
      ),
    );

    it.effect("leaves the owner's replies alone: they go to the contact as written", () =>
      withPipeline(
        Effect.gen(function* () {
          yield* TestClock.setTime(DateTime.toEpochMillis(now));
          yield* alias();
          yield* recipient("ada@mail.example");
          yield* encryptTo((yield* generate()).publicKey);
          const { reverse } = yield* forwardFrom('"Shop" <shop@store.example>');
          expect(yield* replyTo(Option.getOrElse(reverse, () => ""))).toEqual([
            { _tag: "Replied" },
          ]);
          const reply = yield* lastSent;
          expect(reply).toContain("Thanks for your order!");
          expect(header(reply, "Content-Type")).toEqual(Option.none());
        }),
      ),
    );
  });
});

/**
 * Claims `domain` for `usr_1` the way the API does and brings it to `status`. Verified domains
 * are SES identities, so fakecloud lets mail be sent from them.
 */
const customDomain = Effect.fn("customDomain")(function* (
  domain: string,
  status: DomainRepo.DomainStatus,
  options: { readonly userId?: string; readonly isCatchAllEnabled?: boolean } = {},
) {
  const repo = yield* DomainRepo.DomainRepo;
  const userId = options.userId ?? "usr_1";
  const now = DateTime.makeUnsafe(0);
  yield* repo.claim({ domain, userId, verificationToken: "tok", createdAt: now }, 3);
  if (status !== "pending") {
    yield* repo.recordCheck(userId, domain, {
      status,
      checks: [],
      checkedAt: now,
      verifiedAt: Option.some(now),
      nextCheckAt: now,
    });
  }
  if (options.isCatchAllEnabled === true) yield* repo.setCatchAll(userId, domain, true);
  yield* Transport.ensureIdentity(domain);
});

describe("inbound pipeline on custom domains (PLAN.md §20.18.2)", () => {
  it.effect("forwards from and replies as the custom domain once it is verified", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* customDomain("custom.example", "verified");
        yield* alias({ domain: "custom.example" });
        yield* recipient("ada@mail.example");
        const { event } = yield* receive({ recipients: ["Shop@Custom.Example"] });
        expect(yield* Pipeline.handle(event)).toEqual([{ _tag: "Forwarded" }]);
        const reverse = Option.getOrElse(
          Arr.last(yield* sent).pipe(Option.map((email) => email.from)),
          () => "",
        );
        expect(reverse).toMatch(/^shop\+r\.[a-z2-7]+@custom\.example$/);

        expect(yield* replyTo(reverse)).toEqual([{ _tag: "Replied" }]);
        const reply = Arr.last(yield* sent);
        expect(Option.map(reply, (email) => [email.from, email.to])).toEqual(
          Option.some(["shop@custom.example", ["shop@store.example"]]),
        );
        expect(header(text(Option.flatMap(reply, (email) => email.raw)), "Message-ID")).toEqual(
          Option.some(expect.stringMatching(/@custom\.example>$/)),
        );
      }),
    ),
  );

  it.effect("drops mail to pending, failed and unknown custom domains, both ways", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* customDomain("pending.example", "pending");
        yield* customDomain("failed.example", "failed");
        yield* alias({ id: "al_p", domain: "pending.example" });
        yield* alias({ id: "al_f", domain: "failed.example" });
        yield* recipient("ada@mail.example");
        const { event } = yield* receive({
          recipients: [
            "shop@pending.example",
            "shop@failed.example",
            "shop+r.abc@failed.example",
            "shop@nobody.example",
          ],
        });
        expect(yield* Pipeline.handle(event)).toEqual([
          { _tag: "Dropped", reason: "unverified-domain" },
          { _tag: "Dropped", reason: "unverified-domain" },
          { _tag: "Dropped", reason: "unverified-domain" },
          { _tag: "Dropped", reason: "unknown-domain" },
        ]);
        expect(yield* sent).toEqual([]);
      }),
    ),
  );

  it.effect("never delivers to an alias a previous owner of the domain left behind", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* customDomain("custom.example", "verified", { userId: "usr_2" });
        yield* alias({ domain: "custom.example" });
        yield* recipient("ada@mail.example");
        const { event } = yield* receive({ recipients: ["shop@custom.example"] });
        expect(yield* Pipeline.handle(event)).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        expect(yield* sent).toEqual([]);
      }),
    ),
  );

  it.effect("creates aliases for unknown addresses only with catch-all on", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* customDomain("closed.example", "verified");
        yield* customDomain("open.example", "verified", { isCatchAllEnabled: true });
        yield* recipient("ada@mail.example");
        const { event } = yield* receive({
          recipients: ["new@closed.example", "New@open.example"],
        });
        expect(yield* Pipeline.handle(event)).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
          { _tag: "Forwarded" },
        ]);
        expect(Option.map(yield* aliasAt("open.example", "new"), (found) => found.userId)).toEqual(
          Option.some("usr_1"),
        );
        expect(yield* aliasAt("closed.example", "new")).toEqual(Option.none());

        const spam = yield* receive({
          recipients: ["junk@open.example"],
          verdicts: { spam: "FAIL" },
        });
        expect(yield* Pipeline.handle(spam.event)).toEqual([{ _tag: "Dropped", reason: "spam" }]);
        expect(yield* aliasAt("open.example", "junk")).toEqual(Option.none());

        // A deleted alias stays deleted (§20.15): catch-all doesn't bring it back.
        yield* AliasRepo.AliasRepo.use((repo) =>
          repo.delete({ userId: "usr_1", domain: "open.example", localPart: "new" }),
        );
        const again = yield* receive({ recipients: ["new@open.example"] });
        expect(yield* Pipeline.handle(again.event)).toEqual([
          { _tag: "Dropped", reason: "unknown-alias" },
        ]);
        expect(yield* aliasAt("open.example", "new")).toEqual(Option.none());
      }),
    ),
  );

  it.effect("counts catch-all creations against the owner's daily allowance", () =>
    withPipeline(
      Effect.gen(function* () {
        yield* customDomain("open.example", "verified", { isCatchAllEnabled: true });
        yield* recipient("ada@mail.example");
        const { event } = yield* receive({ recipients: ["a@open.example", "b@open.example"] });
        expect(yield* Pipeline.handle(event)).toEqual([
          { _tag: "Forwarded" },
          { _tag: "Dropped", reason: "creation-limited" },
        ]);
      }),
      { ...Limits.defaults, aliasesCreatedPerDay: 1 },
    ),
  );
});
