import { type Inbound, type SesEvent, Transport } from "@alias/aws";
import { Address, Mail, ReverseToken, SharedDomains } from "@alias/core";
import { AliasRepo, type DatabaseError, DeliveryRepo, type Dynamo, RecipientRepo } from "@alias/db";
import { NodeCrypto } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Limits from "./Limits.ts";
import * as Policy from "./Policy.ts";
import { ReverseKeys } from "./ReverseKeys.ts";
import { Route, route } from "./Route.ts";
import { Spool } from "./Spool.ts";

/**
 * The inbound pipeline (PLAN.md §3.2): one SES Lambda event in, for each recipient resolve →
 * policy → rewrite → send, then the spool object is deleted. Nothing about a message is stored
 * except its idempotency claims and the alias counters.
 */

/** What happened to one recipient of one message. Carries no address or content. */
const Outcome = Schema.TaggedUnion({
  Forwarded: {},
  Replied: {},
  Dropped: { reason: Policy.DropReason },
  /** An earlier or concurrent invocation already handled this recipient. */
  Duplicate: {},
  /** SES couldn't take the message now; the event fails so Lambda retries it. */
  Deferred: { code: Schema.String },
});
type Outcome = typeof Outcome.Type;

const forwarded = Outcome.cases.Forwarded.make({});
const replied = Outcome.cases.Replied.make({});
const duplicate = Outcome.cases.Duplicate.make({});
const dropped = (reason: Policy.DropReason) => Outcome.cases.Dropped.make({ reason });
const deferred = (code: string) => Outcome.cases.Deferred.make({ code });

/** Some recipient was deferred. The spool object stays, and Lambda's retry handles the rest. */
class InboundDeferred extends Schema.TaggedError<InboundDeferred>()("InboundDeferred", {
  messageId: Schema.String,
  codes: Schema.Array(Schema.String),
}) {}

type Record = SesEvent.SesEvent["Records"][number];

/** A message to send for one recipient, rewritten from the spooled original when it's read. */
interface Send {
  readonly kind: "forward" | "reply";
  readonly alias: AliasRepo.Alias;
  /**
   * The checks that need the message's header block (loops, auto-replies, bounces) or spend an
   * allowance, run once it is read. None means send it.
   */
  readonly admit: (signals: Mail.Signals) => Effect.Effect<Option.Option<Refusal>, DatabaseError>;
  readonly rewrite: (raw: Uint8Array) => ReturnType<typeof Mail.reply>;
  readonly envelope: Transport.Envelope;
}

type Plan = Data.TaggedEnum<{
  Send: Send;
  /** Refused mail to an existing alias: counted as blocked. */
  Block: { readonly alias: AliasRepo.Alias; readonly reason: Policy.DropReason };
  Drop: { readonly reason: Policy.DropReason };
}>;
const Plan = Data.taggedEnum<Plan>();
type Refusal = Exclude<Plan, { readonly _tag: "Send" }>;

/** The spooled message, read lazily and at most once per record. */
interface Spooled {
  readonly size: Effect.Effect<number, Inbound.MessageGone | Inbound.SpoolError>;
  readonly raw: Effect.Effect<Uint8Array, Inbound.MessageGone | Inbound.SpoolError>;
}

/** Claims outlive Lambda's longest retry window (6 hours) by far, and cost nothing to keep. */
const CLAIM_LIFETIME = Duration.weeks(1);

const aliasAddress = (alias: AliasRepo.Alias): Address.MailAddress => ({
  local: alias.localPart,
  domain: alias.domain,
});

const planForward = Effect.fn("Pipeline.planForward")(function* (
  record: Record,
  alias: AliasRepo.Alias,
) {
  if (alias.mode === "inbox") return Plan.Drop({ reason: "inbox-mode" });
  const recipients = yield* (yield* RecipientRepo.RecipientRepo).list(alias.userId);
  const target = Policy.forwardTarget(recipients);
  if (Option.isNone(target)) return Plan.Drop({ reason: "no-recipient" });
  const sender = Policy.sender(record.ses.mail);
  if (Option.isNone(sender)) return Plan.Drop({ reason: "no-sender" });
  const address = aliasAddress(alias);
  const token = yield* ReverseToken.mint(yield* ReverseKeys, address, {
    sender: Option.some(sender.value.address),
    contactId: Option.none(),
  }).pipe(Effect.option);
  if (Option.isNone(token)) return Plan.Drop({ reason: "unencodable-sender" });
  const aliases = yield* AliasRepo.AliasRepo;
  const { forwardsPerHour } = yield* Limits.Limits;
  const admit = Effect.fn("Pipeline.admitForward")(function* (signals: Mail.Signals) {
    const loop = Policy.forwardLoop(signals, address, record.ses.mail, recipients);
    if (Option.isSome(loop)) return Option.some(Plan.Block({ alias, reason: loop.value }));
    const isReserved = yield* aliases.reserveForward(
      alias.domain,
      alias.localPart,
      yield* DateTime.now,
      forwardsPerHour,
    );
    return isReserved
      ? Option.none<Refusal>()
      : Option.some(Plan.Block({ alias, reason: "rate-limited" }));
  });
  return Plan.Send({
    kind: "forward",
    alias,
    admit,
    rewrite: (raw) =>
      Mail.forward(raw, { alias: address, sender: sender.value, token: token.value }),
    envelope: {
      from: Address.format(Address.reverseAddress(address, token.value)),
      to: [target.value.address],
    },
  });
});

const planReply = Effect.fn("Pipeline.planReply")(function* (
  record: Record,
  alias: AliasRepo.Alias,
  token: string,
) {
  const address = aliasAddress(alias);
  const claims = yield* ReverseToken.verify(yield* ReverseKeys, address, token).pipe(Effect.option);
  // Tokens naming only a contact arrive with the contacts table (roadmap phase 4).
  const contact = Option.flatMap(claims, (verified) => verified.sender);
  if (Option.isNone(contact)) return Plan.Drop({ reason: "bad-token" });
  const recipients = yield* (yield* RecipientRepo.RecipientRepo).list(alias.userId);
  const from = Option.fromUndefinedOr(record.ses.mail.commonHeaders.from).pipe(
    Option.flatMap(Arr.head),
    Option.flatMap(Mail.parseSender),
    Option.map((sender) => sender.address),
  );
  const messageId = yield* Effect.orDie((yield* Crypto.Crypto).randomUUIDv4());
  return Plan.Send({
    kind: "reply",
    alias,
    admit: (signals) =>
      Effect.succeed(
        Policy.automatedReply(signals, record.ses.mail).pipe(
          Option.orElse(() => Policy.rejectReply(record.ses.receipt, from, recipients)),
          Option.map((reason): Refusal => Plan.Drop({ reason })),
        ),
      ),
    rewrite: (raw) => Mail.reply(raw, { alias: address, to: contact.value, messageId }),
    envelope: { from: Address.format(address), to: [contact.value] },
  });
});

/** Decides what to do for one recipient. Reads the table, never the message. */
const plan = Effect.fn("Pipeline.plan")(function* (record: Record, recipient: string) {
  const routed = yield* route(recipient, yield* SharedDomains.SharedDomains);
  if (Route.$is("Unroutable")(routed)) return Plan.Drop({ reason: "unroutable" });
  const found = yield* (yield* AliasRepo.AliasRepo).findByAddress(
    routed.alias.domain,
    routed.alias.local,
  );
  if (Option.isNone(found)) return Plan.Drop({ reason: "unknown-alias" });
  const alias = found.value;
  if (!alias.isActive) return Plan.Block({ alias, reason: "inactive-alias" });
  const screened = Policy.screen(record.ses.receipt, Policy.spamAction(alias));
  if (Option.isSome(screened)) return Plan.Block({ alias, reason: screened.value });
  return Route.$is("Forward")(routed)
    ? yield* planForward(record, alias)
    : yield* planReply(record, alias, routed.token);
});

/** Counters are statistics: an alias deleted meanwhile, or a failed write, loses one count. */
const count = (alias: AliasRepo.Alias, counter: "forwarded" | "blocked") =>
  AliasRepo.AliasRepo.use((aliases) =>
    aliases.increment(alias.domain, alias.localPart, counter),
  ).pipe(
    Effect.catchTags({
      NoSuchAlias: () => Effect.void,
      DatabaseError: (error) => Effect.logWarning("alias counter not updated", error.operation),
    }),
  );

/** Counts a refusal of mail to an existing alias as blocked; plain drops count nothing. */
const refuse = (refusal: Refusal): Effect.Effect<Outcome, never, AliasRepo.AliasRepo> =>
  Plan.$is("Block")(refusal)
    ? Effect.as(count(refusal.alias, "blocked"), dropped(refusal.reason))
    : Effect.succeed(dropped(refusal.reason));

/** Size check, read, header checks, rewrite, send: everything after the claim. */
const send = Effect.fn("Pipeline.send")(function* (planned: Send, message: Spooled) {
  const { maxMessageBytes } = yield* Limits.Limits;
  if ((yield* message.size) > maxMessageBytes) {
    return yield* refuse(Plan.Block({ alias: planned.alias, reason: "too-large" }));
  }
  const raw = yield* message.raw;
  const refused = yield* planned.admit(yield* Mail.signals(raw));
  if (Option.isSome(refused)) return yield* refuse(refused.value);
  const rewritten = yield* planned.rewrite(raw);
  yield* (yield* Transport.Transport).send(rewritten, planned.envelope);
  if (planned.kind === "reply") return replied;
  yield* count(planned.alias, "forwarded");
  return forwarded;
});

/** Carries out one recipient's plan, at most once per message (see `DeliveryRepo`). */
const execute = Effect.fn("Pipeline.execute")(function* (
  delivery: DeliveryRepo.Delivery,
  planned: Plan,
  message: Spooled,
) {
  if (Plan.$is("Drop")(planned)) return dropped(planned.reason);
  const deliveries = yield* DeliveryRepo.DeliveryRepo;
  const expiresAt = DateTime.addDuration(yield* DateTime.now, CLAIM_LIFETIME);
  if (!(yield* deliveries.claim(delivery, expiresAt))) return duplicate;
  if (Plan.$is("Block")(planned)) return yield* refuse(planned);
  // Temporary failures give the claim back so Lambda's retry can send it.
  const defer = (code: string) => Effect.as(deliveries.release(delivery), deferred(code));
  return yield* send(planned, message).pipe(
    Effect.catchTags({
      TransportRejected: () => Effect.succeed(dropped("rejected")),
      MessageGone: () => Effect.succeed(dropped("spool-missing")),
      MalformedMessage: () => Effect.succeed(dropped("malformed-message")),
      TransportRetryable: (error) => defer(error.code),
      SpoolError: (error) => defer(error._tag),
      DatabaseError: (error) => defer(error._tag),
    }),
  );
});

const log = (outcome: Outcome) =>
  Outcome.match(outcome, {
    Forwarded: () => Effect.logInfo("inbound forwarded"),
    Replied: () => Effect.logInfo("inbound replied"),
    Duplicate: () => Effect.logInfo("inbound duplicate"),
    Dropped: ({ reason }) => Effect.logInfo("inbound dropped", reason),
    Deferred: ({ code }) => Effect.logWarning("inbound deferred", code),
  });

/**
 * Handles one received message. Recipients that failed only temporarily fail the whole record so
 * Lambda retries it; the claims make sure the retry sends nothing twice.
 */
const processRecord = Effect.fn("Pipeline.processRecord")(
  function* (record: Record) {
    const messageId = record.ses.mail.messageId;
    const spool = yield* Spool;
    const plans = yield* Effect.forEach(
      record.ses.receipt.recipients,
      (recipient) => Effect.map(plan(record, recipient), (planned) => ({ recipient, planned })),
      { concurrency: 4 },
    );
    // Looked at at most once, and only if something may be sent.
    const message: Spooled = {
      size: yield* Effect.cached(spool.size(messageId)),
      raw: yield* Effect.cached(spool.read(messageId)),
    };
    const outcomes = yield* Effect.forEach(
      plans,
      ({ recipient, planned }) =>
        execute({ messageId, recipient }, planned, message).pipe(Effect.tap(log)),
      { concurrency: 1 },
    );
    const codes = Arr.map(Arr.filter(outcomes, Outcome.guards.Deferred), ({ code }) => code);
    if (Arr.isArrayNonEmpty(codes)) {
      return yield* new InboundDeferred({ messageId, codes });
    }
    yield* spool.delete(messageId);
    return outcomes;
  },
  (effect, record) => Effect.annotateLogs(effect, "messageId", record.ses.mail.messageId),
);

/**
 * The inbound Lambda's work, on an event parsed with `SesEvent.decode`. Returns one outcome per
 * recipient, in event order, for tests and logs.
 */
export const handle = Effect.fn("Pipeline.handle")(function* (event: SesEvent.SesEvent) {
  return Arr.flatten(yield* Effect.forEach(event.Records, processRecord, { concurrency: 1 }));
});

/** What callers provide: the table, SES sending, the spool, the shared domains and the token keys. */
export type Services =
  | Dynamo.Database
  | Transport.Transport
  | Spool
  | SharedDomains.SharedDomains
  | ReverseKeys;

/**
 * Everything {@link handle} needs, from {@link Services}: real AWS in Lambda, emulators elsewhere.
 * Tests pass lower {@link Limits.Limits}.
 */
export const layer = <E, R>(
  services: Layer.Layer<Services, E, R>,
  limits: Limits.Limits["Service"] = Limits.defaults,
) =>
  Layer.mergeAll(
    AliasRepo.layer,
    RecipientRepo.layer,
    DeliveryRepo.layer,
    NodeCrypto.layer,
    Layer.succeed(Limits.Limits, limits),
  ).pipe(Layer.provideMerge(services));
