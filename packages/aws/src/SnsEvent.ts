import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";

/**
 * The event SNS passes to a Lambda function subscribed to a topic, limited to the fields we read.
 * https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html
 *
 * Lambda is invoked asynchronously and SNS retries failed deliveries, so a handler must be
 * idempotent. `Message` is the published string; for SES event publishing, a JSON event
 * (`SendingEvent`).
 */
const SnsRecord = Schema.Struct({
  EventSource: Schema.Literal("aws:sns"),
  EventVersion: Schema.String,
  EventSubscriptionArn: Schema.String,
  Sns: Schema.Struct({
    Type: Schema.Literal("Notification"),
    MessageId: Schema.String,
    TopicArn: Schema.String,
    Message: Schema.String,
    Timestamp: Schema.String,
  }),
});

export const SnsEvent = Schema.Struct({ Records: Schema.Array(SnsRecord) });
export type SnsEvent = typeof SnsEvent.Type;

class InvalidSnsEvent extends Schema.TaggedError<InvalidSnsEvent>()("InvalidSnsEvent", {
  reason: Schema.String,
}) {}

/** Parses what the Lambda runtime passed in. Everything below takes the parsed event. */
export const decode = flow(
  Schema.decodeUnknownEffect(SnsEvent),
  Effect.mapError((error) => new InvalidSnsEvent({ reason: error.message })),
);
