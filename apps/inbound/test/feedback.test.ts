import { AwsClient, SendingEvent, SnsEvent, Transport } from "@alias/aws";
import bounceRecord from "@alias/aws/fixtures/ses-event-bounce.json" with { type: "json" };
import snsEvent from "@alias/aws/fixtures/sns-lambda-event.json" with { type: "json" };
import { FakeCloud } from "@alias/aws-emulators";
import { RecipientRepo, WebhookRepo } from "@alias/db";
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
      complainedAt: Option.none(),
    },
    "hash",
    now,
  );
});

const send = (to: string, kind: SendingEvent.Kind) =>
  Effect.flatMap(Transport.Transport, (transport) =>
    transport.send(new TextEncoder().encode(`From: shop@alias.test\r\nTo: ${to}\r\n\r\nhi`), {
      from: "shop+r.token@alias.test",
      to: [to],
      tags: SendingEvent.tags("usr_1", kind),
    }),
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

  it.effect("marks a hard-bounced recipient and suppresses the address", () =>
    withFeedback((subscriber) =>
      Effect.gen(function* () {
        yield* recipient(BOUNCE);
        yield* WebhookRepo.WebhookRepo.use((repo) =>
          repo.create({
            id: "wh_1",
            userId: "usr_1",
            url: "https://hooks.example.com/",
            eventTypes: ["recipient.bounced"],
            secret: "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0",
            createdAt: DateTime.makeUnsafe(0),
          }),
        ).pipe(Effect.provide(WebhookRepo.layer));
        yield* send(BOUNCE, "forward");
        const event = yield* nextEvent(subscriber);

        expect(yield* Feedback.handle(event)).toEqual([
          { _tag: "Bounced", suppressed: 1, marked: 1 },
        ]);
        expect(Option.isSome((yield* stored(BOUNCE)).bouncedAt)).toBe(true);
        const suppressed = yield* SESV2.getSuppressedDestination({ EmailAddress: BOUNCE });
        expect(suppressed.SuppressedDestination?.Reason).toBe("BOUNCE");

        // SNS may deliver the same event again; nothing changes.
        expect(yield* Feedback.handle(event)).toEqual([
          { _tag: "Bounced", suppressed: 1, marked: 1 },
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

  it.layer(feedback.pipe(Layer.provideMerge(aws), Layer.provideMerge(FakeCloud.layer())), {
    timeout: 30_000,
  })((it) => {
    it.effect("suppresses the documented permanent bounce, even untagged", () =>
      Effect.gen(function* () {
        const event = yield* withMessage(JSON.stringify(bounceRecord));
        expect(yield* Feedback.handle(event)).toEqual([
          { _tag: "Bounced", suppressed: 1, marked: 0 },
        ]);
        const suppressed = yield* SESV2.getSuppressedDestination({
          EmailAddress: "recipient@example.com",
        });
        expect(suppressed.SuppressedDestination?.Reason).toBe("BOUNCE");
      }),
    );

    it.effect("changes nothing for transient bounces, other events and unreadable messages", () =>
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
    );
  });
});
