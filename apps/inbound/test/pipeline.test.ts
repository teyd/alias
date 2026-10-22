import { AwsClient, Inbound, type SesEvent, Transport } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import { SharedDomains } from "@alias/core";
import { AliasRepo, RecipientRepo } from "@alias/db";
import { freshTable } from "@alias/db/testing";
import * as S3 from "@distilled.cloud/aws/s3";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Limits, Pipeline, ReverseKeys, Spool } from "../src/index.ts";

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
    Effect.sync(() =>
      Pipeline.layer(
        Layer.mergeAll(
          freshTable(),
          Transport.ses.pipe(Layer.provide(aws)),
          Spool.layer(bucket).pipe(Layer.provide(aws)),
          SharedDomains.layer("alias.test"),
          ReverseKeys.layer(keys),
        ),
        limits,
      ),
    ),
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
      { ...added, verifiedAt: Option.none(), lastSentAt: now, isDefault: false },
      "hash",
      now,
    );
  }
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

describe("inbound pipeline (fakecloud)", () => {
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
          { _tag: "Dropped", reason: "unroutable" },
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
});
