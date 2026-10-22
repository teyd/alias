import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

/**
 * What SES event publishing sends to a configuration set's SNS destination, limited to the
 * fields we read: bounces and complaints. Other event types decode as `Other` and are ignored.
 * https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html
 */
const Mail = Schema.Struct({
  messageId: Schema.String,
  timestamp: Schema.String,
  source: Schema.String,
  destination: Schema.Array(Schema.String),
  /** Message tags (`EmailTags` on the send) and SES's own `ses:` tags, each a list of values. */
  tags: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
});

const Recipient = Schema.Struct({ emailAddress: Schema.String });

/** A bounced recipient. The DSN fields are there only if a DSN was attached to the bounce. */
const BouncedRecipient = Schema.Struct({
  emailAddress: Schema.String,
  /** The DSN's `Status` field, an enhanced status code (RFC 3463) such as `5.1.1`. */
  status: Schema.optionalKey(Schema.String),
  /** The DSN's `Diagnostic-Code` field, e.g. `smtp; 550 5.1.1 user unknown`. */
  diagnosticCode: Schema.optionalKey(Schema.String),
});
export type BouncedRecipient = typeof BouncedRecipient.Type;

const Bounce = Schema.Struct({
  eventType: Schema.Literal("Bounce"),
  mail: Mail,
  bounce: Schema.Struct({
    /** As SES classified it; what the receiving server said is in each recipient's DSN fields. */
    bounceType: Schema.Literals(["Undetermined", "Permanent", "Transient"]),
    /** Documented values per type in the bounce types table; kept a string so new ones decode. */
    bounceSubType: Schema.String,
    bouncedRecipients: Schema.Array(BouncedRecipient),
    timestamp: Schema.String,
  }),
});

const Complaint = Schema.Struct({
  eventType: Schema.Literal("Complaint"),
  mail: Mail,
  complaint: Schema.Struct({
    complainedRecipients: Schema.Array(Recipient),
    timestamp: Schema.String,
  }),
});

export type Bounce = typeof Bounce.Type;
export type Complaint = typeof Complaint.Type;

/** A parsed event: a bounce, a complaint, or any other type, which we don't act on. */
export type SendingEvent =
  | Bounce
  | Complaint
  | { readonly eventType: "Other"; readonly type: string };

class InvalidSendingEvent extends Schema.TaggedError<InvalidSendingEvent>()("InvalidSendingEvent", {
  reason: Schema.String,
}) {}

const invalid = (error: { readonly message: string }) =>
  new InvalidSendingEvent({ reason: error.message });

const decodeType = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ eventType: Schema.String })),
);
const decodeBounce = Schema.decodeUnknownEffect(Schema.fromJsonString(Bounce));
const decodeComplaint = Schema.decodeUnknownEffect(Schema.fromJsonString(Complaint));

/**
 * Parses an SNS message body published by SES. A bounce or complaint must have every field we
 * read; any other event type is passed on as `Other` with its type.
 */
export const decode = Effect.fn("SendingEvent.decode")(function* (message: string) {
  const { eventType } = yield* decodeType(message).pipe(Effect.mapError(invalid));
  if (eventType === "Bounce") {
    return yield* decodeBounce(message).pipe(Effect.mapError(invalid));
  }
  if (eventType === "Complaint") {
    return yield* decodeComplaint(message).pipe(Effect.mapError(invalid));
  }
  const other: SendingEvent = { eventType: "Other", type: eventType };
  return other;
});

export const isBounce = (event: SendingEvent): event is Bounce => event.eventType === "Bounce";

export const isComplaint = (event: SendingEvent): event is Complaint =>
  event.eventType === "Complaint";

/**
 * The tags every send carries (`Transport` `Envelope.tags`), so an event can be traced back to
 * the user and the kind of mail without storing anything per message. Tag names and values may
 * hold only letters, digits, `_` and `-` (SES `MessageTag`).
 */
export type Kind = "forward" | "reply" | "confirmation";

const USER = "alias-user";
const KIND = "alias-kind";

export const tags = (
  userId: string,
  kind: Kind,
): ReadonlyArray<{ readonly name: string; readonly value: string }> => [
  { name: USER, value: userId },
  { name: KIND, value: kind },
];

const tag = (mail: typeof Mail.Type, name: string): Option.Option<string> =>
  Option.flatMap(Option.fromUndefinedOr(mail.tags), (all) =>
    Option.flatMap(R.get(all, name), Arr.head),
  );

/** The user and kind a send was tagged with, if it was. */
export const origin = (mail: typeof Mail.Type) => ({
  userId: tag(mail, USER),
  kind: Option.filter(
    tag(mail, KIND),
    (value): value is Kind => value === "forward" || value === "reply" || value === "confirmation",
  ),
});
