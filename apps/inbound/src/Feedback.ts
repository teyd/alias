import { type MessageQueue, SendingEvent, type SnsEvent, Transport } from "@alias/aws";
import { type Dynamo, RecipientRepo, SentRepo } from "@alias/db";
import { Publisher } from "@alias/webhooks";
import { NodeCrypto } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Bounces from "./Bounces.ts";

/**
 * Bounces and complaints (PLAN.md §20.11, §20.28). SES publishes them for every send through the
 * configuration set to an SNS topic, which invokes this Lambda.
 *
 * - A bounce counts only if it is about a message we sent (a `SentRepo` record under its SES
 *   message ID, for the user its tags name) and only for an address we sent it to. What it means
 *   for the address is `Bounces.classify`: a mailbox that is gone pauses forwarding to the
 *   user's recipient at once and goes on the account-level suppression list; an unclear hard
 *   bounce counts once per message, and `Bounces.THRESHOLD` of them within `Bounces.WINDOW`
 *   pause it; a rejected message (content, policy, size) changes nothing about the address,
 *   since whoever wrote the message chose its content.
 * - A complaint about forwarded mail is recorded on the recipient. Nothing is suppressed: one
 *   "spam" click on a newsletter must not stop all of a user's forwarding.
 * - Transient and undetermined bounces, and every other event type, change nothing.
 *
 * Every step is idempotent, because SNS retries a failed delivery.
 */

/** What happened to one event. Carries no address. */
const Outcome = Schema.TaggedUnion({
  Bounced: { suppressed: Schema.Number, marked: Schema.Number, counted: Schema.Number },
  Complained: { marked: Schema.Number },
  Ignored: {
    reason: Schema.Literals([
      "transient-bounce",
      "message-bounce",
      "uncorrelated",
      "other-event",
      "invalid-event",
      "untagged",
    ]),
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

/** What one bounced recipient led to. */
interface Effects {
  readonly isSuppressed: boolean;
  readonly isMarked: boolean;
  readonly isCounted: boolean;
}
const none: Effects = { isSuppressed: false, isMarked: false, isCounted: false };

/** One bounced address of a message we sent: what `Bounces.classify` says, carried out. */
const act = Effect.fn("Feedback.act")(function* (
  event: SendingEvent.Bounce,
  sent: SentRepo.Sent,
  bounced: SendingEvent.BouncedRecipient,
) {
  const transport = yield* Transport.Transport;
  const recipients = yield* RecipientRepo.RecipientRepo;
  const address = bounced.emailAddress.toLowerCase();
  const verdict = Bounces.classify(event.bounce, bounced);
  const at = parseTime(event.bounce.timestamp);

  // Mail to a contact (a reply): only a gone mailbox matters, for the shared reputation.
  if (Option.isNone(sent.recipientId)) {
    if (!Bounces.Verdict.guards.AddressUnknown(verdict)) return none;
    yield* transport.suppress(address);
    return { ...none, isSuppressed: true };
  }
  const { recipientId } = sent;
  // The recipient we sent it to, still at that address (not deleted or added again since).
  const recipient = Arr.findFirst(
    yield* recipients.list(sent.userId),
    (candidate) => Option.contains(recipientId, candidate.id) && candidate.address === address,
  );
  if (Option.isNone(recipient)) return none;
  const pause = Effect.fn("Feedback.pause")(function* (
    reason: RecipientRepo.BounceReason,
    isSuppressing: boolean,
  ) {
    if (isSuppressing) yield* transport.suppress(address);
    const isMarked = yield* recipients.markBounced(sent.userId, address, at, reason);
    if (isMarked) yield* announceBounce(sent.userId, address, event);
    return { isSuppressed: isSuppressing, isMarked, isCounted: false };
  });
  return yield* Bounces.Verdict.match(verdict, {
    AddressUnknown: () => pause("address-unknown", true),
    // Already on a suppression list: SES sent nothing, so nothing to add.
    Suppressed: () => pause("suppressed", false),
    AddressSuspect: () =>
      Effect.flatMap(
        recipients.countBounce(recipient.value, event.mail.messageId, at, Bounces.WINDOW),
        (count) =>
          count >= Bounces.THRESHOLD
            ? pause("repeated-bounces", true)
            : Effect.succeed({ ...none, isCounted: true }),
      ),
    MessageOnly: () => Effect.succeed(none),
  });
});

const bounced = Effect.fn("Feedback.bounced")(function* (event: SendingEvent.Bounce) {
  if (event.bounce.bounceType !== "Permanent") return ignored("transient-bounce");
  // Only a message we sent, for the user its tags name, and only the addresses we sent it to.
  const { userId } = SendingEvent.origin(event.mail);
  if (Option.isNone(userId)) return ignored("uncorrelated");
  const sent = yield* (yield* SentRepo.SentRepo).find(userId.value, event.mail.messageId);
  if (Option.isNone(sent)) return ignored("uncorrelated");
  const destination = Arr.map(event.mail.destination, (address) => address.toLowerCase());
  const ours = Arr.filter(event.bounce.bouncedRecipients, (recipient) =>
    Arr.contains(destination, recipient.emailAddress.toLowerCase()),
  );
  if (!Arr.isArrayNonEmpty(ours)) return ignored("uncorrelated");
  const results = yield* Effect.forEach(ours, (recipient) => act(event, sent.value, recipient), {
    concurrency: 1,
  });
  const total = (field: keyof Effects) => Arr.filter(results, (result) => result[field]).length;
  const outcome = Outcome.cases.Bounced.make({
    suppressed: total("isSuppressed"),
    marked: total("isMarked"),
    counted: total("isCounted"),
  });
  return outcome.suppressed + outcome.marked + outcome.counted === 0
    ? ignored("message-bounce")
    : outcome;
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
    Bounced: ({ suppressed, marked, counted }) =>
      Effect.logInfo("feedback bounce", { suppressed, marked, counted }),
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
  Layer.mergeAll(
    RecipientRepo.layer,
    SentRepo.layer,
    Publisher.layer.pipe(Layer.provide(NodeCrypto.layer)),
  ).pipe(Layer.provideMerge(services));
