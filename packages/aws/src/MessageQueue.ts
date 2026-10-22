import * as SQS from "@distilled.cloud/aws/sqs";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AwsClient from "./Client.ts";

/**
 * An SQS standard queue, from both ends: producers `send` message bodies, and the Lambda its event
 * source mapping invokes can push a failed message's next delivery back with `retryIn`
 * (ChangeMessageVisibility, the documented way to back off).
 */
export class MessageQueue extends Context.Service<
  MessageQueue,
  {
    /** Enqueues every body, ten per `SendMessageBatch` call; fails if SQS refused any. */
    readonly send: (bodies: ReadonlyArray<string>) => Effect.Effect<void, QueueUnavailable>;
    /** Hides a received message for `delay` (at most 12 hours, SQS's limit). */
    readonly retryIn: (
      receiptHandle: string,
      delay: Duration.Duration,
    ) => Effect.Effect<void, QueueUnavailable>;
  }
>()("@alias/aws/MessageQueue") {}

/** SQS refused or couldn't be reached. Nothing about the message itself. */
export class QueueUnavailable extends Schema.TaggedError<QueueUnavailable>()("QueueUnavailable", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

/** SQS's cap on a visibility timeout. */
const MAX_VISIBILITY_SECONDS = 43_200;

const make = (queueUrl: string) =>
  Effect.map(Effect.context<AwsClient.AwsClient>(), (client) =>
    MessageQueue.of({
      send: (bodies) =>
        Effect.forEach(
          Arr.chunksOf(bodies, 10),
          (chunk) =>
            SQS.sendMessageBatch({
              QueueUrl: queueUrl,
              Entries: Arr.map(chunk, (body, index) => ({
                Id: String(index),
                MessageBody: body,
              })),
            }).pipe(
              Effect.mapError(
                (error) =>
                  new QueueUnavailable({ operation: "SendMessageBatch", reason: String(error) }),
              ),
              Effect.filterOrFail(
                (result) => Arr.isArrayEmpty(result.Failed ?? []),
                (result) =>
                  new QueueUnavailable({
                    operation: "SendMessageBatch",
                    reason: Arr.join(
                      Arr.map(result.Failed ?? [], (failed) => failed.Code),
                      ", ",
                    ),
                  }),
              ),
            ),
          { concurrency: 1, discard: true },
        ).pipe(Effect.provide(client)),

      retryIn: (receiptHandle, delay) =>
        SQS.changeMessageVisibility({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: Math.min(Math.ceil(Duration.toSeconds(delay)), MAX_VISIBILITY_SECONDS),
        }).pipe(
          Effect.asVoid,
          Effect.mapError(
            (error) =>
              new QueueUnavailable({ operation: "ChangeMessageVisibility", reason: String(error) }),
          ),
          Effect.provide(client),
        ),
    }),
  );

export const layer = (queueUrl: string): Layer.Layer<MessageQueue, never, AwsClient.AwsClient> =>
  Layer.effect(MessageQueue, make(queueUrl));

/**
 * The queue at the URL in `variable`, with `AWS_ENDPOINT_URL_SQS` (the AWS-standard endpoint
 * override) only in emulated runs.
 */
export const config = (variable: string) =>
  Config.all({
    queueUrl: Config.String(variable),
    endpoint: Config.option(Config.String("AWS_ENDPOINT_URL_SQS")),
  }).pipe(
    Config.map(({ queueUrl, endpoint }) =>
      layer(queueUrl).pipe(Layer.provide(AwsClient.layer({ region: AwsClient.region, endpoint }))),
    ),
  );

/** The `RedrivePolicy` queue attribute, a JSON document (SQS `SetQueueAttributes` reference). */
const encodeRedrivePolicy = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ deadLetterTargetArn: Schema.String, maxReceiveCount: Schema.Number }),
  ),
);

/**
 * Creates a queue with a dead-letter queue after `maxReceiveCount` receives, as infra deploys
 * the webhook queue, and returns both URLs. Idempotent. Emulators and dev only; Alchemy deploys
 * real stages.
 */
export const ensure = Effect.fn("MessageQueue.ensure")(function* (
  name: string,
  options: { readonly maxReceiveCount: number; readonly visibilityTimeoutSeconds: number },
) {
  const failed = (operation: string) =>
    Effect.mapError(
      (error: SQS.CreateQueueError | SQS.GetQueueAttributesError) =>
        new QueueUnavailable({ operation, reason: String(error) }),
    );
  const dlq = yield* SQS.createQueue({ QueueName: `${name}-dlq` }).pipe(failed("CreateQueue"));
  const dlqUrl = dlq.QueueUrl ?? "";
  const { Attributes } = yield* SQS.getQueueAttributes({
    QueueUrl: dlqUrl,
    AttributeNames: ["QueueArn"],
  }).pipe(failed("GetQueueAttributes"));
  const queue = yield* SQS.createQueue({
    QueueName: name,
    Attributes: {
      VisibilityTimeout: String(options.visibilityTimeoutSeconds),
      RedrivePolicy: yield* encodeRedrivePolicy({
        deadLetterTargetArn: Attributes?.QueueArn ?? "",
        maxReceiveCount: options.maxReceiveCount,
      }).pipe(
        Effect.mapError(
          (error) => new QueueUnavailable({ operation: "RedrivePolicy", reason: error.message }),
        ),
      ),
    },
  }).pipe(failed("CreateQueue"));
  return { queueUrl: queue.QueueUrl ?? "", dlqUrl };
});
