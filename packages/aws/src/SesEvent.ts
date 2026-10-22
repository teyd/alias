import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";

/**
 * The event SES passes to a Lambda receipt-rule action, limited to the fields we read.
 * https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html
 *
 * The event carries no message body; see `Inbound.ts` for where the S3 action stores it.
 */
export const VerdictStatus = Schema.Literals([
  "PASS",
  "FAIL",
  "GRAY",
  "PROCESSING_FAILED",
  "DISABLED",
]);
export type VerdictStatus = typeof VerdictStatus.Type;

const Verdict = Schema.Struct({ status: VerdictStatus });

export const SesMail = Schema.Struct({
  timestamp: Schema.String,
  source: Schema.String,
  messageId: Schema.String,
  destination: Schema.Array(Schema.String),
  headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  commonHeaders: Schema.Struct({
    returnPath: Schema.optionalKey(Schema.String),
    from: Schema.optionalKey(Schema.Array(Schema.String)),
    to: Schema.optionalKey(Schema.Array(Schema.String)),
    date: Schema.optionalKey(Schema.String),
    messageId: Schema.optionalKey(Schema.String),
    subject: Schema.optionalKey(Schema.String),
  }),
});
export type SesMail = typeof SesMail.Type;

const LambdaAction = Schema.Struct({
  type: Schema.Literal("Lambda"),
  functionArn: Schema.String,
  invocationType: Schema.Literals(["Event", "RequestResponse"]),
});

const SesReceipt = Schema.Struct({
  timestamp: Schema.String,
  processingTimeMillis: Schema.Number,
  recipients: Schema.Array(Schema.String),
  spamVerdict: Verdict,
  virusVerdict: Verdict,
  spfVerdict: Verdict,
  dkimVerdict: Verdict,
  dmarcVerdict: Verdict,
  dmarcPolicy: Schema.optionalKey(Schema.Literals(["none", "quarantine", "reject"])),
  action: LambdaAction,
});

const SesRecord = Schema.Struct({
  eventSource: Schema.Literal("aws:ses"),
  eventVersion: Schema.Literal("1.0"),
  ses: Schema.Struct({ mail: SesMail, receipt: SesReceipt }),
});

export const SesEvent = Schema.Struct({ Records: Schema.Array(SesRecord) });
export type SesEvent = typeof SesEvent.Type;

class InvalidSesEvent extends Schema.TaggedError<InvalidSesEvent>()("InvalidSesEvent", {
  reason: Schema.String,
}) {}

/** Parses what the Lambda runtime passed in. Run this first; everything below takes the parsed event. */
export const decode = flow(
  Schema.decodeUnknownEffect(SesEvent),
  Effect.mapError((error) => new InvalidSesEvent({ reason: error.message })),
);
