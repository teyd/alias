import {
  type Inbound,
  type MessageQueue,
  SendingEvent,
  type SesEvent,
  Transport,
} from "@alias/aws";
import type { WebhookEvent } from "@alias/contracts";
import { Address, Mail, ReverseToken, SharedDomains } from "@alias/core";
import {
  AliasRepo,
  ContactRepo,
  type DatabaseError,
  DeliveryRepo,
  type Dynamo,
  RecipientRepo,
  UserRepo,
} from "@alias/db";
import { Publisher } from "@alias/webhooks";
import { NodeCrypto } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
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
  /** Who wrote, for a forward: named in the `mail.forwarded` webhook event. */
  readonly contactId: Option.Option<string>;
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

/**
 * The alias's contact for `sender`, created on its first message. A concurrent first message
 * creates it only once; both then use the stored one. Fails with `NoSuchAlias` when the alias was
 * deleted since it was read, so its purge can't miss the new contact.
 */
const contactFor = Effect.fn("Pipeline.contactFor")(function* (
  alias: AliasRepo.Alias,
  sender: Mail.Sender,
) {
  const contacts = yield* ContactRepo.ContactRepo;
  const found = yield* contacts.findByAddress(alias.id, sender.address);
  if (Option.isSome(found)) return found.value;
  const created: ContactRepo.Contact = {
    id: yield* Effect.orDie(ReverseToken.newContactId()),
    aliasId: alias.id,
    address: sender.address,
    name: sender.name,
    createdAt: yield* DateTime.now,
    isBlocked: false,
  };
  return yield* contacts.create(created, alias).pipe(
    Effect.as(created),
    Effect.catchTag("ContactExists", () =>
      Effect.map(
        contacts.findByAddress(alias.id, sender.address),
        Option.getOrElse(() => created),
      ),
    ),
  );
});

/**
 * Who a verified reverse alias stands for. Tokens name a contact, which must still exist and not
 * be blocked. Tokens minted before contacts existed name the sender's address; they keep
 * working, unless the alias has since blocked a contact with that address.
 */
const replyTarget = Effect.fn("Pipeline.replyTarget")(function* (
  alias: AliasRepo.Alias,
  claims: ReverseToken.Claims,
) {
  const contacts = yield* ContactRepo.ContactRepo;
  const contact = Option.isSome(claims.contactId)
    ? yield* contacts.findById(alias.id, claims.contactId.value)
    : Option.isSome(claims.sender)
      ? yield* contacts.findByAddress(alias.id, claims.sender.value)
      : Option.none();
  if (Option.exists(contact, (found) => found.isBlocked)) {
    return Result.fail<Policy.DropReason>("blocked-contact");
  }
  return Option.match(
    Option.orElse(
      Option.map(contact, (found) => found.address),
      () => claims.sender,
    ),
    {
      onNone: () => Result.fail<Policy.DropReason>("unknown-contact"),
      onSome: Result.succeed,
    },
  );
});

const planForward = Effect.fn("Pipeline.planForward")(function* (
  record: Record,
  alias: AliasRepo.Alias,
) {
  if (alias.mode === "inbox") return Plan.Drop({ reason: "inbox-mode" });
  const recipients = yield* (yield* RecipientRepo.RecipientRepo).list(alias.userId);
  const target = Policy.forwardTarget(recipients);
  if (Option.isNone(target)) return Plan.Drop({ reason: "no-recipient" });
  if (Option.isSome(target.value.bouncedAt)) return Plan.Drop({ reason: "recipient-bounced" });
  const sender = Policy.sender(record.ses.mail);
  if (Option.isNone(sender)) return Plan.Drop({ reason: "no-sender" });
  if (!Policy.isStorableAddress(sender.value.address)) {
    return Plan.Drop({ reason: "unencodable-sender" });
  }
  const found = yield* contactFor(alias, sender.value).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NoSuchAlias", () => Effect.succeedNone),
  );
  if (Option.isNone(found)) return Plan.Drop({ reason: "unknown-alias" });
  const contact = found.value;
  if (contact.isBlocked) return Plan.Block({ alias, reason: "blocked-contact" });
  const address = aliasAddress(alias);
  // The token names the contact, not the sender: short whatever the address, and revoked with
  // the contact.
  const token = yield* ReverseToken.mint(yield* ReverseKeys, address, {
    sender: Option.none(),
    contactId: Option.some(contact.id),
  }).pipe(Effect.option);
  if (Option.isNone(token)) return Plan.Drop({ reason: "unencodable-sender" });
  const settings = yield* (yield* UserRepo.UserRepo).settings(alias.userId);
  const protection: Mail.Protection = {
    images: settings.imageProtection,
    isLinkCleaningEnabled: settings.isLinkCleaningEnabled,
  };
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
    contactId: Option.some(contact.id),
    admit,
    rewrite: (raw) =>
      Mail.forward(raw, { alias: address, sender: sender.value, token: token.value, protection }),
    envelope: {
      from: Address.format(Address.reverseAddress(address, token.value)),
      to: [target.value.address],
      tags: SendingEvent.tags(alias.userId, "forward"),
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
  if (Option.isNone(claims)) return Plan.Drop({ reason: "bad-token" });
  const target = yield* replyTarget(alias, claims.value);
  if (Result.isFailure(target)) return Plan.Drop({ reason: target.failure });
  const contact = target.success;
  const recipients = yield* (yield* RecipientRepo.RecipientRepo).list(alias.userId);
  const sender = Option.fromUndefinedOr(record.ses.mail.commonHeaders.from).pipe(
    Option.flatMap(Arr.head),
    Option.flatMap(Mail.parseSender),
  );
  const from = Option.map(sender, (found) => found.address);
  // What the owner's client may quote: any of their addresses, and the name they write with.
  const owner: Mail.Owner = {
    addresses: Arr.map(recipients, (recipient) => recipient.address),
    name: Option.flatMap(sender, (found) => found.name),
  };
  const messageId = yield* Effect.orDie((yield* Crypto.Crypto).randomUUIDv4());
  return Plan.Send({
    kind: "reply",
    alias,
    contactId: Option.none(),
    admit: (signals) =>
      Effect.succeed(
        Policy.automatedReply(signals, record.ses.mail).pipe(
          Option.orElse(() => Policy.rejectReply(record.ses.receipt, from, recipients)),
          Option.map((reason): Refusal => Plan.Drop({ reason })),
        ),
      ),
    rewrite: (raw) => Mail.reply(raw, { alias: address, to: contact, messageId, owner }),
    envelope: {
      from: Address.format(address),
      to: [contact],
      tags: SendingEvent.tags(alias.userId, "reply"),
    },
  });
});

/**
 * Creates the alias for mail to an unknown address on a user's subdomain, if that user opted in
 * (PLAN.md §3.2 step 1). Spam and viruses never create one, and each user may create only
 * `Limits.aliasesCreatedPerDay` this way. A deleted alias stays deleted: mail to it is dropped
 * like mail to any unknown address and spends nothing. A concurrent creation of the same address
 * is fine: both then use the one that was stored.
 */
const createOnTheFly = Effect.fn("Pipeline.createOnTheFly")(function* (
  record: Record,
  address: Address.MailAddress,
  username: string,
) {
  const users = yield* UserRepo.UserRepo;
  const aliases = yield* AliasRepo.AliasRepo;
  const owner = yield* users.findByUsername(username);
  if (Option.isNone(owner)) return Result.fail<Policy.DropReason>("unknown-alias");
  if (!(yield* users.settings(owner.value.id)).isOnTheFlyEnabled) {
    return Result.fail<Policy.DropReason>("unknown-alias");
  }
  const screened = Policy.screen(record.ses.receipt, "drop");
  if (Option.isSome(screened)) return Result.fail<Policy.DropReason>(screened.value);
  if (yield* aliases.isDeleted(address.domain, address.local)) {
    return Result.fail<Policy.DropReason>("unknown-alias");
  }
  const now = yield* DateTime.now;
  const { aliasesCreatedPerDay } = yield* Limits.Limits;
  if (!(yield* aliases.reserveCreation(owner.value.id, now, aliasesCreatedPerDay))) {
    return Result.fail<Policy.DropReason>("creation-limited");
  }
  const ulid = yield* Effect.orDie((yield* Crypto.Crypto).randomULID);
  const aliasId = `al_${ulid.toLowerCase()}`;
  const isCreated = yield* aliases
    .insert({
      id: aliasId,
      userId: owner.value.id,
      domain: address.domain,
      localPart: address.local,
      mode: "forward",
      createdAt: DateTime.toEpochMillis(now),
    })
    .pipe(
      Effect.as(true),
      Effect.catchTag("AliasTaken", () => Effect.succeed(false)),
    );
  if (isCreated) {
    yield* Effect.logInfo("inbound alias created on the fly");
    yield* (yield* Publisher.Publisher).publish(
      owner.value.id,
      {
        type: "alias.created",
        timestamp: DateTime.formatIso(now),
        data: { aliasId, address: Address.format(address), origin: "on-the-fly" },
      },
      aliasId,
    );
  }
  const created = yield* aliases.findByAddress(address.domain, address.local);
  return Option.match(created, {
    onNone: () => Result.fail<Policy.DropReason>("unknown-alias"),
    onSome: Result.succeed,
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
  const resolved = yield* Option.match(found, {
    onSome: (alias) => Effect.succeed(Result.succeed(alias)),
    onNone: () =>
      Route.$is("Forward")(routed) && Option.isSome(routed.username)
        ? createOnTheFly(record, routed.alias, routed.username.value)
        : Effect.succeed(Result.fail<Policy.DropReason>("unknown-alias")),
  });
  if (Result.isFailure(resolved)) return Plan.Drop({ reason: resolved.failure });
  const alias = resolved.success;
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

/**
 * Tells the alias owner's webhooks what happened to a message (metadata only: no content, no
 * sender address). Keyed by message and recipient, so a retried invocation repeats the
 * `webhook-id`.
 */
const announce = Effect.fn("Pipeline.announce")(function* (
  delivery: DeliveryRepo.Delivery,
  alias: AliasRepo.Alias,
  what:
    | { readonly type: "mail.forwarded"; readonly contactId: string }
    | { readonly type: "mail.blocked"; readonly reason: Policy.DropReason },
) {
  const timestamp = DateTime.formatIso(yield* DateTime.now);
  const ref = { aliasId: alias.id, address: Address.format(aliasAddress(alias)) };
  const event: WebhookEvent =
    what.type === "mail.forwarded"
      ? { type: what.type, timestamp, data: { ...ref, contactId: what.contactId } }
      : { type: what.type, timestamp, data: { ...ref, reason: what.reason } };
  yield* (yield* Publisher.Publisher).publish(
    alias.userId,
    event,
    `${delivery.messageId}:${delivery.recipient}`,
  );
});

/** Counts a refusal of mail to an existing alias as blocked; plain drops count nothing. */
const refuse = (
  delivery: DeliveryRepo.Delivery,
  refusal: Refusal,
): Effect.Effect<Outcome, never, AliasRepo.AliasRepo | Publisher.Publisher> =>
  Plan.$is("Block")(refusal)
    ? count(refusal.alias, "blocked").pipe(
        Effect.andThen(
          announce(delivery, refusal.alias, { type: "mail.blocked", reason: refusal.reason }),
        ),
        Effect.as(dropped(refusal.reason)),
      )
    : Effect.succeed(dropped(refusal.reason));

/** Size check, read, header checks, rewrite, send: everything after the claim. */
const send = Effect.fn("Pipeline.send")(function* (
  delivery: DeliveryRepo.Delivery,
  planned: Send,
  message: Spooled,
) {
  const { maxMessageBytes } = yield* Limits.Limits;
  if ((yield* message.size) > maxMessageBytes) {
    return yield* refuse(delivery, Plan.Block({ alias: planned.alias, reason: "too-large" }));
  }
  const raw = yield* message.raw;
  const refused = yield* planned.admit(yield* Mail.signals(raw));
  if (Option.isSome(refused)) return yield* refuse(delivery, refused.value);
  const rewritten = yield* planned.rewrite(raw);
  yield* (yield* Transport.Transport).send(rewritten, planned.envelope);
  if (planned.kind === "reply") return replied;
  yield* count(planned.alias, "forwarded");
  if (Option.isSome(planned.contactId)) {
    yield* announce(delivery, planned.alias, {
      type: "mail.forwarded",
      contactId: planned.contactId.value,
    });
  }
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
  if (Plan.$is("Block")(planned)) return yield* refuse(delivery, planned);
  // Temporary failures give the claim back so Lambda's retry can send it.
  const defer = (code: string) => Effect.as(deliveries.release(delivery), deferred(code));
  return yield* send(delivery, planned, message).pipe(
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

/**
 * What callers provide: the table, SES sending, the spool, the shared domains, the token keys and
 * the webhook queue.
 */
export type Services =
  | Dynamo.Database
  | Transport.Transport
  | MessageQueue.MessageQueue
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
    ContactRepo.layer,
    RecipientRepo.layer,
    DeliveryRepo.layer,
    UserRepo.layer,
    NodeCrypto.layer,
    Publisher.layer.pipe(Layer.provide(NodeCrypto.layer)),
    Layer.succeed(Limits.Limits, limits),
  ).pipe(Layer.provideMerge(services));
