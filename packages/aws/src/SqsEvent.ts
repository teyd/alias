import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";

/**
 * The event an SQS event source mapping passes to a Lambda function, limited to the fields we
 * read. https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html
 *
 * Delivery is at least once. With `ReportBatchItemFailures` on the mapping, the function returns
 * a {@link BatchResponse} naming the records that failed: Lambda deletes the others and the
 * failed ones become visible again when their visibility timeout ends. A thrown error fails the
 * whole batch. https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html
 */
const SqsRecord = Schema.Struct({
  messageId: Schema.String,
  receiptHandle: Schema.String,
  body: Schema.String,
  attributes: Schema.Struct({
    /** How often SQS has handed this message out, this delivery included. */
    ApproximateReceiveCount: Schema.NumberFromString,
  }),
  eventSource: Schema.Literal("aws:sqs"),
  eventSourceARN: Schema.String,
});
export type SqsRecord = typeof SqsRecord.Type;

export const SqsEvent = Schema.Struct({ Records: Schema.Array(SqsRecord) });
export type SqsEvent = typeof SqsEvent.Type;

/** What the function returns: the `messageId`s to try again. An empty list is full success. */
export interface BatchResponse {
  readonly batchItemFailures: ReadonlyArray<{ readonly itemIdentifier: string }>;
}

class InvalidSqsEvent extends Schema.TaggedError<InvalidSqsEvent>()("InvalidSqsEvent", {
  reason: Schema.String,
}) {}

/** Parses what the Lambda runtime passed in. Everything below takes the parsed event. */
export const decode = flow(
  Schema.decodeUnknownEffect(SqsEvent),
  Effect.mapError((error) => new InvalidSqsEvent({ reason: error.message })),
);
