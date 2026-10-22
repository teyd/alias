import type { AwsClient } from "@alias/aws";
import * as SQS from "@distilled.cloud/aws/sqs";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

/**
 * Lambda's SQS event source mapping: it polls a queue, invokes the function with a batch, and
 * deletes what the function processed. fakecloud's SQS is real (send, receive, visibility,
 * redrive to a dead-letter queue), but it runs Lambda only in Docker, so this emulator plays the
 * poller, as AWS documents it:
 *
 * - the event: https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html
 * - partial batch responses (`ReportBatchItemFailures`):
 *   https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html
 *
 * A batch succeeds when the function returns nothing, an empty object, or a null or empty
 * `batchItemFailures`; then every message is deleted. Listed failures are left on the queue (they
 * reappear after their visibility timeout, or after whatever the function set with
 * ChangeMessageVisibility). A thrown error, or a failure entry whose `itemIdentifier` is empty,
 * missing or not in the batch, fails the whole batch: nothing is deleted.
 *
 * It shares no code with the production schema (`@alias/aws` SqsEvent); contract tests pin both
 * to the documented payloads.
 */

/** The Lambda event for one batch, field for field as the Lambda documentation shows it. */
export const toEvent = (
  messages: ReadonlyArray<SQS.Message>,
  queueArn: string,
  region: string,
) => ({
  Records: Arr.map(messages, (message) => ({
    messageId: message.MessageId ?? "",
    receiptHandle: message.ReceiptHandle ?? "",
    body: message.Body ?? "",
    attributes: R.getSomes(R.map(message.Attributes ?? {}, Option.fromUndefinedOr)),
    messageAttributes: R.map(
      R.getSomes(R.map(message.MessageAttributes ?? {}, Option.fromUndefinedOr)),
      (attribute) => ({
        stringValue: attribute.StringValue,
        stringListValues: attribute.StringListValues ?? [],
        binaryListValues: [],
        dataType: attribute.DataType,
      }),
    ),
    md5OfBody: message.MD5OfBody ?? "",
    eventSource: "aws:sqs",
    eventSourceARN: queueArn,
    awsRegion: region,
  })),
});
export type SqsLambdaEvent = ReturnType<typeof toEvent>;

const FailureList = Schema.NullOr(
  Schema.Array(Schema.Struct({ itemIdentifier: Schema.NullOr(Schema.String) })),
);
const decodeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.NullOr(Schema.Struct({ batchItemFailures: Schema.optionalKey(FailureList) })),
  ),
);

/**
 * Which messages to keep, as Lambda reads a function's response (`json`: the response as the
 * runtime serialised it; None when the function returned nothing): None when the whole batch
 * failed, else the ids listed as failed (possibly none).
 */
export const failedIds = (
  json: Option.Option<string>,
  messageIds: ReadonlyArray<string>,
): Option.Option<ReadonlyArray<string>> =>
  Option.match(json, {
    onNone: () => Option.some([]),
    onSome: (text) =>
      Option.flatMap(decodeResponse(text), (decoded) => {
        const ids = Arr.map(
          decoded?.batchItemFailures ?? [],
          (failure) => failure.itemIdentifier ?? "",
        );
        return Arr.every(ids, (id) => id !== "" && Arr.contains(messageIds, id))
          ? Option.some(ids)
          : Option.none();
      }),
  });

/** What the Lambda runtime sends back for a handler's return value: JSON, or nothing. */
const encodeResponse = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export class EventSourceFailure extends Schema.TaggedError<EventSourceFailure>()(
  "EventSourceFailure",
  { reason: Schema.String },
) {}

export interface SqsEventSourceConfig {
  readonly queueUrl: string;
  /** Up to 10 messages per invocation, Lambda's default. */
  readonly batchSize?: number;
  /** Long-poll wait per receive, in seconds (0 to 20). */
  readonly waitSeconds?: number;
  /** The function. A failed Effect is a thrown error: the whole batch fails. */
  readonly handler: (event: SqsLambdaEvent) => Effect.Effect<object | void, unknown>;
}

/** What one poll did. */
export interface PollResult {
  readonly received: number;
  readonly deleted: number;
}

export class SqsEventSource extends Context.Service<
  SqsEventSource,
  {
    /** Receives one batch, invokes the function if there was one, and deletes what succeeded. */
    readonly poll: Effect.Effect<PollResult, EventSourceFailure>;
  }
>()("@alias/lambda-emulator/SqsEventSource") {}

const failed = (operation: string) =>
  Effect.mapError(
    (error: { readonly _tag: string; readonly message?: string }) =>
      new EventSourceFailure({ reason: `${operation}: ${error._tag} ${error.message ?? ""}` }),
  );

/** Polls `queueUrl` on whatever `AwsClient` points at (fakecloud). */
export const make = Effect.fn("SqsEventSource.make")(function* (config: SqsEventSourceConfig) {
  const client = yield* Effect.context<AwsClient.AwsClient>();
  const attributes = yield* SQS.getQueueAttributes({
    QueueUrl: config.queueUrl,
    AttributeNames: ["QueueArn"],
  }).pipe(failed("GetQueueAttributes"), Effect.provide(client));
  const queueArn = attributes.Attributes?.QueueArn ?? "";
  // arn:aws:sqs:<region>:<account>:<name>
  const region = Option.getOrElse(Arr.get(queueArn.split(":"), 3), () => "");

  const remove = (receiptHandle: string) =>
    SQS.deleteMessage({ QueueUrl: config.queueUrl, ReceiptHandle: receiptHandle }).pipe(
      failed("DeleteMessage"),
      Effect.provide(client),
    );

  const poll = Effect.fn("SqsEventSource.poll")(function* () {
    const received = yield* SQS.receiveMessage({
      QueueUrl: config.queueUrl,
      MaxNumberOfMessages: config.batchSize ?? 10,
      WaitTimeSeconds: config.waitSeconds ?? 0,
      MessageSystemAttributeNames: ["All"],
      MessageAttributeNames: ["All"],
    }).pipe(failed("ReceiveMessage"), Effect.provide(client));
    const messages = received.Messages ?? [];
    if (Arr.isArrayEmpty(messages)) return { received: 0, deleted: 0 };
    const event = toEvent(messages, queueArn, region);
    const outcome = yield* Effect.result(config.handler(event));
    const keep = Result.isFailure(outcome)
      ? Option.none<ReadonlyArray<string>>()
      : failedIds(
          Option.flatMap(Option.fromUndefinedOr(outcome.success), encodeResponse),
          Arr.map(event.Records, (record) => record.messageId),
        );
    if (Option.isNone(keep)) return { received: messages.length, deleted: 0 };
    const done = Arr.filter(event.Records, (record) => !Arr.contains(keep.value, record.messageId));
    yield* Effect.forEach(done, (record) => remove(record.receiptHandle), {
      concurrency: 1,
      discard: true,
    });
    return { received: messages.length, deleted: done.length };
  });

  return SqsEventSource.of({ poll: poll() });
});

/** Polls for as long as the scope lives, as a deployed mapping would (dev). */
export const run = (config: SqsEventSourceConfig) =>
  Effect.flatMap(make(config), (source) =>
    source.poll.pipe(
      Effect.catch((error) => Effect.logError("sqs event source poll failed", error.reason)),
      Effect.repeat(Schedule.spaced("200 millis")),
      Effect.forkScoped,
    ),
  );
