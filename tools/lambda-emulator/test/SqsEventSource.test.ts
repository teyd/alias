import { AwsClient, MessageQueue, SqsEvent } from "@alias/aws";
import documented from "@alias/aws/fixtures/sqs-lambda-event.json" with { type: "json" };
import received from "@alias/aws/fixtures/sqs-receive-message-response.json" with { type: "json" };
import { FakeCloud } from "@alias/aws-emulators";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { SqsEventSource } from "../src/index.ts";

const queueArn = "arn:aws:sqs:eu-west-1:123456789012:webhooks";
/** Field names, sorted: what "has exactly the documented fields" compares. */
const fieldsOf = (json: string) =>
  Arr.sort(
    R.keys(
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
        json,
      ),
    ),
    Order.String,
  );

describe("SqsEventSource.toEvent (contract: AWS documentation payloads)", () => {
  it.effect("turns the documented ReceiveMessage response into an event production decodes", () =>
    Effect.gen(function* () {
      const event = SqsEventSource.toEvent(received.Messages, queueArn, "eu-west-1");
      const decoded = yield* SqsEvent.decode(event);
      const [message] = received.Messages;
      expect(decoded.Records[0]).toMatchObject({
        messageId: message?.MessageId,
        receiptHandle: message?.ReceiptHandle,
        body: message?.Body,
        attributes: { ApproximateReceiveCount: 1 },
        eventSourceARN: queueArn,
      });
    }),
  );

  it("has exactly the fields of the documented Lambda event", () => {
    const [record] = SqsEventSource.toEvent(received.Messages, queueArn, "eu-west-1").Records;
    const [sample] = documented.Records;
    expect(fieldsOf(JSON.stringify(record))).toEqual(fieldsOf(JSON.stringify(sample)));
    expect(fieldsOf(JSON.stringify(record?.attributes))).toEqual(
      fieldsOf(JSON.stringify(sample?.attributes)),
    );
    expect(record?.md5OfBody).toBe("fafb00f5732ab283681e124bf8747ed1");
    // Message attributes map to the documented lower-case shape.
    const [withAttribute] = SqsEventSource.toEvent(
      [{ MessageAttributes: { myAttribute: { StringValue: "myValue", DataType: "String" } } }],
      queueArn,
      "eu-west-1",
    ).Records;
    expect(withAttribute?.messageAttributes).toEqual(sample?.messageAttributes);
  });

  it("reads function responses as Lambda documents them", () => {
    const ids = ["id1", "id2", "id3", "id4"];
    const failed = (response: Schema.Json) =>
      SqsEventSource.failedIds(Option.some(JSON.stringify(response)), ids);
    // Complete success.
    expect(SqsEventSource.failedIds(Option.none(), ids)).toEqual(Option.some([]));
    expect(failed(null)).toEqual(Option.some([]));
    expect(failed({})).toEqual(Option.some([]));
    expect(failed({ batchItemFailures: [] })).toEqual(Option.some([]));
    expect(failed({ batchItemFailures: null })).toEqual(Option.some([]));
    // The documented partial failure.
    expect(
      failed({ batchItemFailures: [{ itemIdentifier: "id2" }, { itemIdentifier: "id4" }] }),
    ).toEqual(Option.some(["id2", "id4"]));
    // Complete failure.
    expect(failed({ batchItemFailures: [{ itemIdentifier: "" }] })).toEqual(Option.none());
    expect(failed({ batchItemFailures: [{ itemIdentifier: null }] })).toEqual(Option.none());
    expect(failed({ batchItemFailures: [{ itemId: "id2" }] })).toEqual(Option.none());
    expect(failed({ batchItemFailures: [{ itemIdentifier: "id9" }] })).toEqual(Option.none());
    expect(failed("not an object")).toEqual(Option.none());
    expect(SqsEventSource.failedIds(Option.some("{not json"), ids)).toEqual(Option.none());
  });
});

const aws = Layer.unwrap(
  Effect.map(Effect.service(FakeCloud.FakeCloud), ({ url }) => AwsClient.emulator(url)),
);

let queues = 0;

/** A fresh queue with a dead-letter queue after `maxReceiveCount` receives, on fakecloud. */
const freshQueue = Effect.fn("freshQueue")(function* (maxReceiveCount = 3) {
  queues += 1;
  const dlq = yield* SQS.createQueue({ QueueName: `dlq-${queues}` });
  const dlqUrl = dlq.QueueUrl ?? "";
  const { Attributes } = yield* SQS.getQueueAttributes({
    QueueUrl: dlqUrl,
    AttributeNames: ["QueueArn"],
  });
  const queue = yield* SQS.createQueue({
    QueueName: `queue-${queues}`,
    Attributes: {
      VisibilityTimeout: "30",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: Attributes?.QueueArn,
        maxReceiveCount,
      }),
    },
  });
  const queueUrl = queue.QueueUrl ?? "";
  const producer = yield* Effect.provide(MessageQueue.MessageQueue, MessageQueue.layer(queueUrl));
  return { queueUrl, dlqUrl, producer };
});

const sleep = (millis: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis)));

describe("SqsEventSource on fakecloud", () => {
  it.layer(aws.pipe(Layer.provideMerge(FakeCloud.layer())), { timeout: 30_000 })((it) => {
    it.effect("hands a batch over as a Lambda event and deletes it after success", () =>
      Effect.gen(function* () {
        const { queueUrl, producer } = yield* freshQueue();
        // The documented event's body, whose MD5 the documentation prints.
        yield* producer.send(["Test message.", "second"]);
        const events: Array<SqsEventSource.SqsLambdaEvent> = [];
        const source = yield* SqsEventSource.make({
          queueUrl,
          handler: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });

        expect(yield* source.poll).toEqual({ received: 2, deleted: 2 });
        const decoded = yield* SqsEvent.decode(events[0]);
        expect(
          Arr.sort(
            Arr.map(decoded.Records, (record) => record.body),
            Order.String,
          ),
        ).toEqual(["Test message.", "second"]);
        expect(decoded.Records[0]?.attributes.ApproximateReceiveCount).toBe(1);
        expect(decoded.Records[0]?.eventSourceARN).toMatch(/^arn:aws:sqs:eu-west-1:\d+:queue-/);
        const record = Arr.findFirst(
          events[0]?.Records ?? [],
          (found) => found.body === "Test message.",
        );
        expect(Option.map(record, (found) => found.md5OfBody)).toEqual(
          Option.some(documented.Records[0]?.md5OfBody),
        );
        expect(Option.map(record, (found) => found.awsRegion)).toEqual(Option.some("eu-west-1"));
        expect(yield* source.poll).toEqual({ received: 0, deleted: 0 });
      }),
    );

    it.effect("keeps reported failures, which come back when their visibility ends", () =>
      Effect.gen(function* () {
        const { queueUrl, producer } = yield* freshQueue();
        yield* producer.send(["keep", "done"]);
        const counts: Array<number> = [];
        const source = yield* SqsEventSource.make({
          queueUrl,
          handler: (event) =>
            Effect.gen(function* () {
              const decoded = yield* SqsEvent.decode(event);
              const failed = Arr.filter(decoded.Records, (record) => record.body === "keep");
              // Back off as the delivery Lambda does: ChangeMessageVisibility, then report.
              yield* Effect.forEach(
                failed,
                (record) => {
                  counts.push(record.attributes.ApproximateReceiveCount);
                  return producer.retryIn(record.receiptHandle, Duration.seconds(1));
                },
                { concurrency: 1 },
              );
              return {
                batchItemFailures: Arr.map(failed, (record) => ({
                  itemIdentifier: record.messageId,
                })),
              };
            }),
        });

        expect(yield* source.poll).toEqual({ received: 2, deleted: 1 });
        // Hidden for the second it was pushed back by, not the queue's 30 s.
        expect(yield* source.poll).toEqual({ received: 0, deleted: 0 });
        yield* sleep(1_200);
        expect(yield* source.poll).toEqual({ received: 1, deleted: 0 });
        expect(counts).toEqual([1, 2]);
      }),
    );

    it.effect("deletes nothing when the function fails", () =>
      Effect.gen(function* () {
        const { queueUrl, producer } = yield* freshQueue();
        yield* producer.send(["a", "b"]);
        const source = yield* SqsEventSource.make({
          queueUrl,
          handler: () => Effect.fail("boom"),
        });
        expect(yield* source.poll).toEqual({ received: 2, deleted: 0 });
        const invalid = yield* SqsEventSource.make({
          queueUrl,
          handler: () => Effect.succeed({ batchItemFailures: [{ itemIdentifier: "nope" }] }),
        });
        // Both still in flight: the first poll's visibility timeout hasn't ended.
        expect(yield* invalid.poll).toEqual({ received: 0, deleted: 0 });
        const { Attributes } = yield* SQS.getQueueAttributes({
          QueueUrl: queueUrl,
          AttributeNames: ["ApproximateNumberOfMessagesNotVisible"],
        });
        expect(Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("2");
      }),
    );

    it.effect("moves a message to the dead-letter queue after maxReceiveCount receives", () =>
      Effect.gen(function* () {
        const { queueUrl, dlqUrl, producer } = yield* freshQueue(2);
        yield* producer.send(["poison"]);
        const source = yield* SqsEventSource.make({
          queueUrl,
          handler: (event) =>
            Effect.gen(function* () {
              const decoded = yield* SqsEvent.decode(event);
              yield* Effect.forEach(
                decoded.Records,
                (record) => producer.retryIn(record.receiptHandle, Duration.zero),
                { concurrency: 1 },
              );
              return {
                batchItemFailures: Arr.map(decoded.Records, (record) => ({
                  itemIdentifier: record.messageId,
                })),
              };
            }),
        });
        expect(yield* source.poll).toEqual({ received: 1, deleted: 0 });
        expect(yield* source.poll).toEqual({ received: 1, deleted: 0 });
        // The third receive exceeds maxReceiveCount: SQS moves it instead of returning it.
        expect(yield* source.poll).toEqual({ received: 0, deleted: 0 });
        const dead = yield* SQS.receiveMessage({ QueueUrl: dlqUrl });
        expect(Arr.map(dead.Messages ?? [], (message) => message.Body)).toEqual(["poison"]);
      }),
    );

    it.effect("caps a backoff at SQS's 12-hour visibility limit", () =>
      Effect.gen(function* () {
        const { queueUrl, producer } = yield* freshQueue();
        yield* producer.send(["later"]);
        const { Messages = [] } = yield* SQS.receiveMessage({ QueueUrl: queueUrl });
        const handle = Messages[0]?.ReceiptHandle ?? "";
        yield* producer.retryIn(handle, Duration.hours(13));
        const failure = yield* Effect.flip(producer.retryIn("not-a-handle", Duration.seconds(1)));
        expect(failure._tag).toBe("QueueUnavailable");
      }),
    );
  });
});
