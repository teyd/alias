import { AwsClient, SendingEvent, SnsEvent, Transport } from "@alias/aws";
import bounceRecord from "@alias/aws/fixtures/ses-event-bounce.json" with { type: "json" };
import snsEvent from "@alias/aws/fixtures/sns-lambda-event.json" with { type: "json" };
import { FakeCloud } from "@alias/aws-emulators";
import { RecipientRepo, SentRepo, WebhookRepo } from "@alias/db";
import { freshTable } from "@alias/db/testing";
import { freshQueue, TestQueue } from "@alias/webhooks/testing";
import { SnsSubscriber } from "@alias/lambda-emulator";
import * as SESV2 from "@distilled.cloud/aws/sesv2";
import * as SNS from "@distilled.cloud/aws/sns";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as R from "effect/Record";
import { Feedback } from "../src/index.ts";

/**
 * The feedback Lambda on fakecloud, fed the way production feeds it: a send through the
 * configuration set to SES's mailbox simulator, the event fakecloud publishes to the SNS topic,
 * and `SnsSubscriber` turning the HTTP notification into the documented Lambda event.
 */
const CONFIGURATION_SET = "alias-events";
const BOUNCE = "bounce@simulator.amazonses.com";
const COMPLAINT = "complaint@simulator.amazonses.com";

const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

const feedback = Layer.unwrap(
  Effect.sync(() => {
    // One queue: the feedback handler publishes to it, tests read it (`TestQueue`).
    const queue = freshQueue();
    return Feedback.layer(
      Layer.mergeAll(
        freshTable(),
        queue,
        Transport.layer({ configurationSet: Option.some(CONFIGURATION_SET) }).pipe(
          Layer.provide(aws),
        ),
      ),
    ).pipe(Layer.provideMerge(queue));
  }),
);

/** The configuration set with an SNS destination, and the emulated Lambda subscription. */
const subscribed = Effect.fn("subscribed")(function* () {
  yield* Transport.ensureIdentity("alias.test");
  const { TopicArn = "" } = yield* SNS.createTopic({ Name: "ses-events" });
  yield* SESV2.createConfigurationSet({ ConfigurationSetName: CONFIGURATION_SET });
  yield* SESV2.createConfigurationSetEventDestination({
    ConfigurationSetName: CONFIGURATION_SET,
    EventDestinationName: "feedback",
    EventDestination: {
      Enabled: true,
      MatchingEventTypes: ["BOUNCE", "COMPLAINT"],
      SnsDestination: { TopicArn },
    },
  });
  return yield* SnsSubscriber.make({ topicArn: TopicArn });
});

const withFeedback = <A, E>(
  effect: (
    subscriber: SnsSubscriber.SnsSubscriber["Service"],
  ) => Effect.Effect<
    A,
    E,
    Layer.Success<typeof feedback> | AwsClient.AwsClient | FakeCloud.FakeCloud
  >,
) =>
  Effect.flatMap(subscribed(), effect).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(feedback, aws).pipe(Layer.provideMerge(FakeCloud.layer()))),
  );

/** A verified recipient of usr_1, added and confirmed the way the API does it. */
const recipient = Effect.fn("recipient")(function* (address: string) {
  const repo = yield* RecipientRepo.RecipientRepo;
  const now = yield* DateTime.now;
  const added = { id: `rcp_${address}`, userId: "usr_1", address, createdAt: now };
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
});

/** Sends to `to` through the configuration set and records the send, as production does. */
const send = Effect.fn("send")(function* (
  to: string,
  kind: SendingEvent.Kind,
  options: { readonly isRecorded?: boolean } = {},
) {
  const transport = yield* Transport.Transport;
  const messageId = yield* transport.send(
    new TextEncoder().encode(`From: shop@alias.test\r\nTo: ${to}\r\n\r\nhi`),
    { from: "shop+r.token@alias.test", to: [to], tags: SendingEvent.tags("usr_1", kind) },
  );
  if (options.isRecorded !== false) {
    yield* SentRepo.remember({
      messageId,
      userId: "usr_1",
      kind,
      recipientId: kind === "reply" ? Option.none() : Option.some(`rcp_${to}`),
    });
  }
  return messageId;
});

const isSuppressed = (address: string) =>
  SESV2.getSuppressedDestination({ EmailAddress: address }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFoundException", () => Effect.succeed(false)),
  );

/** The next event SNS delivers, as the Lambda runtime would pass it (JSON). */
const nextEvent = (subscriber: SnsSubscriber.SnsSubscriber["Service"]) =>
  Queue.take(subscriber.events).pipe(
    Effect.flatMap((event) => SnsEvent.decode(JSON.parse(JSON.stringify(event)))),
  );

const stored = (address: string) =>
  RecipientRepo.RecipientRepo.use((repo) =>
    Effect.flatMap(repo.find("usr_1", `rcp_${address}`), Effect.fromOption),
  );

describe("feedback Lambda (fakecloud SES events → SNS → Lambda event)", () => {
  it.effect("fakecloud's events decode with the production schema and carry the send's tags", () =>
    withFeedback((subscriber) =>
      Effect.gen(function* () {
        yield* send(BOUNCE, "forward");
        const event = yield* nextEvent(subscriber);
        const published = yield* SendingEvent.decode(event.Records[0]?.Sns.Message ?? "");
        expect(SendingEvent.isBounce(published)).toBe(true);
        expect(SendingEvent.isBounce(published) && SendingEvent.origin(published.mail)).toEqual({
          userId: Option.some("usr_1"),
          kind: Option.some("forward"),
        });
      }),
    ),
  );

  it.effect("pauses a recipient whose mailbox doesn't exist (5.1.1) and suppresses it", () =>
    withFeedback((subscriber) =>
      Effect.gen(function* () {
        yield* recipient(BOUNCE);
        yield* WebhookRepo.WebhookRepo.use((repo) =>
          repo.create({
            id: "wh_1",
            userId: "usr_1",
            url: "https://hooks.example.com/",
            eventTypes: ["recipient.bounced"],
            // Producers only enqueue job ids; the sealed secret is never opened here.
            sealedSecret: new TextEncoder().encode("sealed"),
            createdAt: DateTime.makeUnsafe(0),
          }),
        ).pipe(Effect.provide(WebhookRepo.layer));
        yield* send(BOUNCE, "forward");
        const event = yield* nextEvent(subscriber);

        expect(yield* Feedback.handle(event)).toEqual([
          { _tag: "Bounced", suppressed: 1, marked: 1, counted: 0 },
        ]);
        expect(yield* stored(BOUNCE)).toMatchObject({
          bouncedAt: Option.some(expect.anything()),
          bounceReason: Option.some("address-unknown"),
        });
        const suppressed = yield* SESV2.getSuppressedDestination({ EmailAddress: BOUNCE });
        expect(suppressed.SuppressedDestination?.Reason).toBe("BOUNCE");

        // SNS may deliver the same event again; nothing changes.
        expect(yield* Feedback.handle(event)).toEqual([
          { _tag: "Bounced", suppressed: 1, marked: 1, counted: 0 },
        ]);

        // The owner's webhook hears of it, twice with one webhook-id, which receivers dedupe.
        const { queueUrl } = yield* TestQueue;
        const { Messages = [] } = yield* SQS.receiveMessage({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
        });
        const jobs = Arr.map(Messages, (message) => JSON.parse(message.Body ?? "null"));
        expect(Arr.map(jobs, (job) => job.event)).toEqual([
          { type: "recipient.bounced", timestamp: expect.any(String), data: { address: BOUNCE } },
          { type: "recipient.bounced", timestamp: expect.any(String), data: { address: BOUNCE } },
        ]);
        expect(jobs[0]?.id).toBe(jobs[1]?.id);
      }),
    ),
  );

  it.effect("ignores a bounce of a message it has no record of", () =>
    withFeedback((subscriber) =>
      Effect.gen(function* () {
        yield* recipient(BOUNCE);
        yield* send(BOUNCE, "forward", { isRecorded: false });
        expect(yield* Feedback.handle(yield* nextEvent(subscriber))).toEqual([
          { _tag: "Ignored", reason: "uncorrelated" },
        ]);
        expect(Option.isNone((yield* stored(BOUNCE)).bouncedAt)).toBe(true);
        expect(yield* isSuppressed(BOUNCE)).toBe(false);
      }),
    ),
  );

  it.effect("records a complaint about forwarded mail without suppressing anything", () =>
    withFeedback((subscriber) =>
      Effect.gen(function* () {
        yield* recipient(COMPLAINT);
        yield* send(COMPLAINT, "forward");
        expect(yield* Feedback.handle(yield* nextEvent(subscriber))).toEqual([
          { _tag: "Complained", marked: 1 },
        ]);
        const marked = yield* stored(COMPLAINT);
        expect(Option.isSome(marked.complainedAt)).toBe(true);
        expect(Option.isNone(marked.bouncedAt)).toBe(true);
        const notSuppressed = yield* Effect.flip(
          SESV2.getSuppressedDestination({ EmailAddress: COMPLAINT }),
        );
        expect(notSuppressed._tag).toBe("NotFoundException");

        // A contact complaining about a reply has no recipient of ours behind it.
        yield* send(COMPLAINT, "reply");
        expect(yield* Feedback.handle(yield* nextEvent(subscriber))).toEqual([
          { _tag: "Ignored", reason: "untagged" },
        ]);
      }),
    ),
  );
});

describe("feedback Lambda on documented payloads", () => {
  const withMessage = (message: string) =>
    SnsEvent.decode({
      ...snsEvent,
      Records: snsEvent.Records.map((record) => ({
        ...record,
        Sns: { ...record.Sns, Message: message },
      })),
    });

  /** The documented recipient (`recipient@example.com`), verified for usr_1. */
  const ADDRESS = bounceRecord.mail.destination[0] ?? "";

  /**
   * The documented bounce record, about message `messageId` and tagged for usr_1, with the bounce
   * fields replaced: what SES would publish for the cases fakecloud's simulator can't produce.
   */
  const bounceEvent = (
    messageId: string,
    bounce: {
      readonly bounceType?: string;
      readonly bounceSubType?: string;
      readonly status?: string;
      readonly diagnosticCode?: string;
      readonly emailAddress?: string;
      readonly userId?: string;
    } = {},
  ) => {
    const [documented] = bounceRecord.bounce.bouncedRecipients;
    return Effect.flatMap(
      withMessage(
        JSON.stringify({
          ...bounceRecord,
          mail: {
            ...bounceRecord.mail,
            messageId,
            tags: {
              ...bounceRecord.mail.tags,
              ...R.fromEntries(
                Arr.map(
                  SendingEvent.tags(bounce.userId ?? "usr_1", "forward"),
                  (tag) => [tag.name, [tag.value]] as const,
                ),
              ),
            },
          },
          bounce: {
            ...bounceRecord.bounce,
            bounceType: bounce.bounceType ?? "Permanent",
            bounceSubType: bounce.bounceSubType ?? "General",
            bouncedRecipients: [
              {
                ...documented,
                emailAddress: bounce.emailAddress ?? ADDRESS,
                status: bounce.status ?? documented?.status,
                diagnosticCode: bounce.diagnosticCode ?? documented?.diagnosticCode,
              },
            ],
          },
        }),
      ),
      Feedback.handle,
    );
  };

  /** Records a send of `messageId` to the documented recipient (or, for a reply, a contact). */
  const sentAs = (messageId: string, kind: SendingEvent.Kind = "forward") =>
    SentRepo.remember({
      messageId,
      userId: "usr_1",
      kind,
      recipientId: kind === "reply" ? Option.none() : Option.some(`rcp_${ADDRESS}`),
    });

  /** Each test on its own fakecloud: the suppression list is account-wide. */
  const own = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Layer.Success<typeof feedback> | AwsClient.AwsClient | FakeCloud.FakeCloud
    >,
  ) =>
    effect.pipe(
      Effect.provide(Layer.mergeAll(feedback, aws).pipe(Layer.provideMerge(FakeCloud.layer()))),
    );

  const paused = Effect.map(stored(ADDRESS), (found) => ({
    bouncedAt: Option.isSome(found.bouncedAt),
    reason: found.bounceReason,
  }));

  it.effect("does nothing about the address for a message refused for its content", () =>
    own(
      Effect.gen(function* () {
        yield* recipient(ADDRESS);
        const contentRejections = [
          { status: "5.7.1", diagnosticCode: "smtp; 550 5.7.1 Message rejected as spam" },
          { status: "5.6.0", diagnosticCode: "smtp; 554 5.6.0 Message contains bad content" },
          { status: "5.3.4", diagnosticCode: "smtp; 552 5.3.4 Message size exceeds fixed limit" },
          // An address code in `status` doesn't count when the server's reply names the content.
          { status: "5.1.1", diagnosticCode: "smtp; 550 5.7.26 Unauthenticated email (DMARC)" },
          { bounceSubType: "NoEmail", status: "5.7.1", diagnosticCode: "smtp; 550 5.7.1 Blocked" },
        ];
        const outcomes = yield* Effect.forEach(
          contentRejections,
          (rejection, index) =>
            Effect.andThen(
              sentAs(`msg_content_${index}`),
              bounceEvent(`msg_content_${index}`, rejection),
            ),
          { concurrency: 1 },
        );
        expect(Arr.flatten(outcomes)).toEqual(
          Arr.map(contentRejections, () => ({ _tag: "Ignored", reason: "message-bounce" })),
        );
        expect(yield* paused).toEqual({ bouncedAt: false, reason: Option.none() });
        expect(yield* isSuppressed(ADDRESS)).toBe(false);
      }),
    ),
  );

  it.effect("pauses after three unclear hard bounces of distinct messages within a week", () =>
    own(
      Effect.gen(function* () {
        yield* recipient(ADDRESS);
        const unclear = { status: "5.0.0", diagnosticCode: "smtp; 550 Mailbox unavailable" };
        yield* sentAs("msg_1");
        yield* sentAs("msg_2");
        yield* sentAs("msg_3");
        const counted = [{ _tag: "Bounced", suppressed: 0, marked: 0, counted: 1 }];
        expect(yield* bounceEvent("msg_1", unclear)).toEqual(counted);
        // SNS delivering the same bounce again doesn't count it twice.
        expect(yield* bounceEvent("msg_1", unclear)).toEqual(counted);
        expect(yield* bounceEvent("msg_2", { status: "5.2.1" })).toEqual(counted);
        expect(yield* paused).toEqual({ bouncedAt: false, reason: Option.none() });
        expect(yield* isSuppressed(ADDRESS)).toBe(false);

        expect(
          yield* bounceEvent("msg_3", {
            bounceSubType: "NoEmail",
            status: "5.4.4",
            diagnosticCode: "smtp; 550 5.4.4 Unable to route",
          }),
        ).toEqual([{ _tag: "Bounced", suppressed: 1, marked: 1, counted: 0 }]);
        expect(yield* paused).toEqual({
          bouncedAt: true,
          reason: Option.some("repeated-bounces"),
        });
        expect(yield* isSuppressed(ADDRESS)).toBe(true);
      }),
    ),
  );

  it.effect("pauses at once for an address SES has on a suppression list, adding nothing", () =>
    own(
      Effect.gen(function* () {
        yield* recipient(ADDRESS);
        yield* sentAs("msg_listed");
        expect(
          yield* bounceEvent("msg_listed", {
            bounceSubType: "OnAccountSuppressionList",
            status: "5.1.1",
            diagnosticCode: "Amazon SES has suppressed sending to this address",
          }),
        ).toEqual([{ _tag: "Bounced", suppressed: 0, marked: 1, counted: 0 }]);
        expect(yield* paused).toEqual({ bouncedAt: true, reason: Option.some("suppressed") });
        expect(yield* isSuppressed(ADDRESS)).toBe(false);
      }),
    ),
  );

  it.effect("suppresses a contact's gone mailbox after a reply, and marks nothing", () =>
    own(
      Effect.gen(function* () {
        yield* recipient(ADDRESS);
        yield* sentAs("msg_reply", "reply");
        yield* sentAs("msg_reply_spam", "reply");
        expect(
          yield* bounceEvent("msg_reply_spam", {
            status: "5.7.1",
            diagnosticCode: "smtp; 550 5.7.1 Spam",
          }),
        ).toEqual([{ _tag: "Ignored", reason: "message-bounce" }]);
        expect(yield* isSuppressed(ADDRESS)).toBe(false);
        expect(yield* bounceEvent("msg_reply")).toEqual([
          { _tag: "Bounced", suppressed: 1, marked: 0, counted: 0 },
        ]);
        expect(yield* isSuppressed(ADDRESS)).toBe(true);
        expect(yield* paused).toEqual({ bouncedAt: false, reason: Option.none() });
      }),
    ),
  );

  it.effect("ignores bounces it can't trace to a message of ours to that recipient", () =>
    own(
      Effect.gen(function* () {
        yield* recipient(ADDRESS);
        yield* sentAs("msg_ours");
        const outcomes = yield* Effect.forEach(
          [
            // The documented record, untagged and unknown to us.
            Effect.flatMap(withMessage(JSON.stringify(bounceRecord)), Feedback.handle),
            // Our message, but tagged for someone else.
            bounceEvent("msg_ours", { userId: "usr_2" }),
            // Our message, but an address it wasn't sent to.
            bounceEvent("msg_ours", { emailAddress: "someone@example.com" }),
          ],
          (outcome) => outcome,
          { concurrency: 1 },
        );
        expect(Arr.flatten(outcomes)).toEqual([
          { _tag: "Ignored", reason: "uncorrelated" },
          { _tag: "Ignored", reason: "uncorrelated" },
          { _tag: "Ignored", reason: "uncorrelated" },
        ]);
        expect(yield* paused).toEqual({ bouncedAt: false, reason: Option.none() });
        expect(yield* isSuppressed(ADDRESS)).toBe(false);
      }),
    ),
  );

  it.effect("changes nothing for transient bounces, other events and unreadable messages", () =>
    own(
      Effect.gen(function* () {
        const transient = {
          ...bounceRecord,
          bounce: { ...bounceRecord.bounce, bounceType: "Transient" },
        };
        const outcomes = yield* Effect.forEach(
          [JSON.stringify(transient), JSON.stringify({ eventType: "Delivery" }), "Hello from SNS!"],
          (message) => Effect.flatMap(withMessage(message), Feedback.handle),
          { concurrency: 1 },
        );
        expect(outcomes).toEqual([
          [{ _tag: "Ignored", reason: "transient-bounce" }],
          [{ _tag: "Ignored", reason: "other-event" }],
          [{ _tag: "Ignored", reason: "invalid-event" }],
        ]);
      }),
    ),
  );
});
