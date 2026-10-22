import { type MessageQueue, SendingEvent, type SnsEvent, Transport } from "@alias/aws";
import { type Dynamo, RecipientRepo } from "@alias/db";
import { Publisher } from "@alias/webhooks";
import { NodeCrypto } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Bounces and complaints (PLAN.md §20.11). SES publishes them for every send through the
 * configuration set to an SNS topic, which invokes this Lambda. Sends carry the user and kind as
 * message tags (`SendingEvent.tags`), so nothing per message is stored to trace them back.
 *
 * - A permanent bounce puts the address on the SESv2 account-level suppression list and marks
 *   the user's recipient with that address as bounced; the pipeline stops forwarding to it.
 * - A complaint about forwarded mail is recorded on the recipient. Nothing is suppressed: one
 *   "spam" click on a newsletter must not stop all of a user's forwarding.
 * - Transient and undetermined bounces, and every other event type, change nothing.
 *
 * Every step is idempotent, because SNS retries a failed delivery.
 */

/** What happened to one event. Carries no address. */
const Outcome = Schema.TaggedUnion({
  Bounced: { suppressed: Schema.Number, marked: Schema.Number },
  Complained: { marked: Schema.Number },
  Ignored: {
    reason: Schema.Literals(["transient-bounce", "other-event", "invalid-event", "untagged"]),
  },
});
type Outcome = typeof Outcome.Type;

const ignored = (reason: Extract<Outcome, { _tag: "Ignored" }>["reason"]) =>
  Outcome.cases.Ignored.make({ reason });

const parseTime = (timestamp: string) =>
  Option.getOrElse(DateTime.make(timestamp), () => DateTime.makeUnsafe(0));

/** Tells the user's webhooks that one of their forwarding addresses bounces. */
const announceBounce = Effect.fn("Feedback.announceBounce")(function* (
  userId: string,
  address: string,
  event: SendingEvent.Bounce,
) {
  yield* (yield* Publisher.Publisher).publish(
    userId,
    {
      type: "recipient.bounced",
      timestamp: DateTime.formatIso(parseTime(event.bounce.timestamp)),
      data: { address },
    },
    `${event.mail.messageId}:${address}`,
  );
});

const bounced = Effect.fn("Feedback.bounced")(function* (event: SendingEvent.Bounce) {
  if (event.bounce.bounceType !== "Permanent") return ignored("transient-bounce");
  const transport = yield* Transport.Transport;
  const recipients = yield* RecipientRepo.RecipientRepo;
  const addresses = Arr.map(event.bounce.bouncedRecipients, (recipient) =>
    recipient.emailAddress.toLowerCase(),
  );
  yield* Effect.forEach(addresses, transport.suppress, { concurrency: 1, discard: true });
  const { userId } = SendingEvent.origin(event.mail);
  const at = parseTime(event.bounce.timestamp);
  const marked = Option.isNone(userId)
    ? []
    : yield* Effect.forEach(
        addresses,
        (address) =>
          Effect.tap(recipients.markBounced(userId.value, address, at), (isMarked) =>
            isMarked ? announceBounce(userId.value, address, event) : Effect.void,
          ),
        { concurrency: 1 },
      );
  return Outcome.cases.Bounced.make({
    suppressed: addresses.length,
    marked: Arr.filter(marked, (isMarked) => isMarked).length,
  });
});

const complained = Effect.fn("Feedback.complained")(function* (event: SendingEvent.Complaint) {
  const { userId, kind } = SendingEvent.origin(event.mail);
  // Only forwarded mail lands in the owner's mailbox; a contact complaining about a reply has no
  // recipient of ours to record it on.
  if (Option.isNone(userId) || !Option.contains(kind, "forward")) return ignored("untagged");
  const recipients = yield* RecipientRepo.RecipientRepo;
  const at = parseTime(event.complaint.timestamp);
  const marked = yield* Effect.forEach(
    event.complaint.complainedRecipients,
    (recipient) => recipients.markComplained(userId.value, recipient.emailAddress, at),
    { concurrency: 1 },
  );
  return Outcome.cases.Complained.make({
    marked: Arr.filter(marked, (isMarked) => isMarked).length,
  });
});

const log = (outcome: Outcome) =>
  Outcome.match(outcome, {
    Bounced: ({ suppressed, marked }) => Effect.logInfo("feedback bounce", { suppressed, marked }),
    Complained: ({ marked }) => Effect.logInfo("feedback complaint", { marked }),
    Ignored: ({ reason }) => Effect.logInfo("feedback ignored", reason),
  });

const processRecord = Effect.fn("Feedback.processRecord")(
  function* (record: SnsEvent.SnsEvent["Records"][number]) {
    const event = yield* SendingEvent.decode(record.Sns.Message).pipe(Effect.option);
    if (Option.isNone(event)) return ignored("invalid-event");
    if (SendingEvent.isBounce(event.value)) return yield* bounced(event.value);
    if (SendingEvent.isComplaint(event.value)) return yield* complained(event.value);
    return ignored("other-event");
  },
  (effect, record) => Effect.annotateLogs(effect, "snsMessageId", record.Sns.MessageId),
);

/**
 * The feedback Lambda's work, on an event parsed with `SnsEvent.decode`. A database or SES
 * failure fails the invocation so SNS delivers it again; an event that doesn't parse is ignored,
 * because a retry can't fix it.
 */
export const handle = Effect.fn("Feedback.handle")(function* (event: SnsEvent.SnsEvent) {
  return yield* Effect.forEach(event.Records, (record) => Effect.tap(processRecord(record), log), {
    concurrency: 1,
  });
});

/** What callers provide: the table, SES (for the suppression list) and the webhook queue. */
export type Services = Dynamo.Database | Transport.Transport | MessageQueue.MessageQueue;

export const layer = <E, R>(services: Layer.Layer<Services, E, R>) =>
  Layer.merge(RecipientRepo.layer, Publisher.layer.pipe(Layer.provide(NodeCrypto.layer))).pipe(
    Layer.provideMerge(services),
  );
