import {
  type Inbound,
  type MessageQueue,
  ReverseKeys,
  SendingEvent,
  type SesEvent,
  Transport,
} from "@alias/aws";
import type { WebhookEvent } from "@alias/contracts";
import {
  Address,
  Blocklist,
  Mail,
  Pgp,
  ReverseToken,
  Rules,
  SharedDomains,
  TempDomains,
} from "@alias/core";
import {
  AliasRepo,
  ContactRepo,
  type DatabaseError,
  DeliveryRepo,
  DomainRepo,
  type Dynamo,
  FailureRepo,
  FilterRepo,
  Forwarding,
  MessageRepo,
  OutboxRepo,
  RecipientRepo,
  SentRepo,
  UserRepo,
  UsernameRepo,
} from "@alias/db";
import { Inbox } from "@alias/inbox";
import { Publisher } from "@alias/webhooks";
import { NodeCrypto } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ImageProxySigner } from "./ImageProxySigner.ts";
import * as Limits from "./Limits.ts";
import * as Policy from "./Policy.ts";
import { Route, route } from "./Route.ts";
import { Spool } from "./Spool.ts";

/**
 * The inbound pipeline (PLAN.md §3.2): one SES Lambda event in, for each recipient resolve →
 * policy → rewrite → send, then the spool object is deleted. Nothing about a forwarded message is
 * stored except its idempotency claims and the alias counters; inbox aliases keep mail encrypted
 * (`Inbox` in `@alias/inbox`, PLAN.md §20.22).
 */

/** What happened to one recipient of one message. Carries no address or content. */
const Outcome = Schema.TaggedUnion({
  Forwarded: {},
  /** Kept in the alias's inbox (inbox mode). */
  Stored: {},
  Replied: {},
  Dropped: { reason: Policy.DropReason },
  /** An earlier or concurrent invocation already handled this recipient. */
  Duplicate: {},
  /** SES couldn't take the message now; the event fails so Lambda retries it. */
  Deferred: { code: Schema.String },
});
type Outcome = typeof Outcome.Type;

const forwarded = Outcome.cases.Forwarded.make({});
const stored = Outcome.cases.Stored.make({});
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

/**
 * How a forward that fails for good is recorded as a failed delivery (PLAN.md §20.33): who wrote,
 * and whether the owner keeps the message. Only forwards to a forward-mode alias are recorded; a
 * `both` alias has the message in its inbox anyway.
 */
interface FailureNote {
  readonly sender: string;
  readonly isKept: boolean;
}

/** A message to send for one recipient, rewritten from the spooled original when it's read. */
interface Send {
  readonly kind: "forward" | "reply";
  readonly alias: AliasRepo.Alias;
  /** Rules whose `webhook` action matched (PLAN.md §20.32), announced once the mail is claimed. */
  readonly notify?: ReadonlyArray<string>;
  readonly failure: Option.Option<FailureNote>;
  /**
   * The checks that need the message's header block (loops, auto-replies, bounces) or spend an
   * allowance, run once it is read, then what goes out. Anything written for the message (a new
   * contact) is written only once it is admitted.
   */
  readonly admit: (
    signals: Mail.Signals,
  ) => Effect.Effect<
    Result.Result<Outgoing, Refusal>,
    DatabaseError,
    ContactRepo.ContactRepo | OutboxRepo.OutboxRepo | Transport.Transport | Crypto.Crypto
  >;
}

type RewriteError = Effect.Error<ReturnType<typeof Pgp.encrypt>>;

/** An admitted message: how it is rewritten and where it goes. */
interface Outgoing {
  /** Who wrote, for a forward: named in the `mail.forwarded` webhook event. */
  readonly contactId: Option.Option<string>;
  /** Header rewrite and scrubbing, the same for every copy. */
  readonly rewrite: (raw: Uint8Array) => Effect.Effect<Uint8Array, RewriteError, Crypto.Crypto>;
  /**
   * One per mailbox it goes to: a reply goes to its contact, a forward to each of the alias's
   * recipients (PLAN.md §20.31).
   */
  readonly copies: Arr.NonEmptyReadonlyArray<Copy>;
  /**
   * Admitted, but it can't go out: every forwarding address is paused. It is still rewritten, so
   * a failed delivery keeps what the owner would have read and can send it again (PLAN.md §20.33).
   */
  readonly undeliverable: Option.Option<Policy.DropReason>;
}

/** One copy of an admitted message, sent on its own. */
interface Copy {
  /** The owner's recipient it goes to, for a forward: its bounces are about that recipient. */
  readonly recipientId: Option.Option<string>;
  /** For a recipient with a key, encryption, after every other rewrite. */
  readonly seal: (rewritten: Uint8Array) => Effect.Effect<Uint8Array, RewriteError, Crypto.Crypto>;
  readonly envelope: Transport.Envelope;
}

type Plan = Data.TaggedEnum<{
  Send: Send;
  /** Keep the message in the alias's inbox, then forward it too when `forward` says so (`both`). */
  Store: {
    readonly alias: AliasRepo.Alias;
    readonly forward: Option.Option<Send>;
    readonly notify?: ReadonlyArray<string>;
  };
  /** Refused mail to an existing alias: counted as blocked. */
  Block: {
    readonly alias: AliasRepo.Alias;
    readonly reason: Policy.DropReason;
    readonly notify?: ReadonlyArray<string>;
  };
  Drop: { readonly reason: Policy.DropReason };
}>;
const Plan = Data.taggedEnum<Plan>();
type Refusal = Exclude<Plan, { readonly _tag: "Send" | "Store" }>;

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
 * Creates the alias's contact for `sender`, on its first admitted message. A concurrent first
 * message creates it only once; both then use the stored one. Fails with `NoSuchAlias` when the
 * alias was deleted since it was read, so its purge can't miss the new contact.
 */
const createContact = Effect.fn("Pipeline.createContact")(function* (
  alias: AliasRepo.Alias,
  sender: Mail.Sender,
) {
  const contacts = yield* ContactRepo.ContactRepo;
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
 * Who a verified reverse alias stands for: the contact its token names, which must still exist on
 * this alias and not be blocked.
 */
const replyTarget = Effect.fn("Pipeline.replyTarget")(function* (
  alias: AliasRepo.Alias,
  claims: ReverseToken.Claims,
) {
  const contacts = yield* ContactRepo.ContactRepo;
  const contact = yield* contacts.findById(alias.id, claims.contactId);
  if (Option.isNone(contact)) return Result.fail<Policy.DropReason>("unknown-contact");
  if (contact.value.isBlocked) return Result.fail<Policy.DropReason>("blocked-contact");
  return Result.succeed(contact.value.address);
});

/** Mail the blocklist or a rule blocks, and the rules whose webhooks still fire. */
interface Filtered {
  readonly reason: Extract<Policy.DropReason, "blocked-sender" | "rule-blocked">;
  readonly notify: ReadonlyArray<string>;
}

/**
 * The owner's blocklist and rules for mail between `sender` and the alias (PLAN.md §20.32): one
 * GetItem. A blocked sender fails with the reason and the rules whose webhooks fire; otherwise
 * the rules' outcome.
 */
const filter = Effect.fn("Pipeline.filter")(function* (
  record: Record,
  alias: AliasRepo.Alias,
  sender: Option.Option<string>,
): Effect.fn.Return<Result.Result<Rules.Outcome, Filtered>, DatabaseError, FilterRepo.FilterRepo> {
  const filters = yield* (yield* FilterRepo.FilterRepo).find(alias.userId);
  const listed = Option.flatMap(sender, (address) =>
    Blocklist.match(HashSet.fromIterable(filters.blocklist), address),
  );
  if (Option.isSome(listed)) {
    return Result.fail({ reason: "blocked-sender", notify: [] });
  }
  const outcome = Rules.evaluate(filters.rules, {
    sender,
    subject: Option.fromUndefinedOr(record.ses.mail.commonHeaders.subject),
    alias: Address.format(aliasAddress(alias)),
    labels: alias.labels,
  });
  return Option.isSome(outcome.blockedBy)
    ? Result.fail({ reason: "rule-blocked", notify: outcome.notify })
    : Result.succeed(outcome);
});

const planForward = Effect.fn("Pipeline.planForward")(function* (
  record: Record,
  alias: AliasRepo.Alias,
  ruled: Rules.Outcome,
) {
  // A rule's destination, while it can take mail, replaces the alias's (PLAN.md §20.32).
  const { recipients, targets: aliasTargets } = yield* Forwarding.targetsOf(alias);
  const targets = Option.match(Policy.ruleTarget(recipients, ruled.recipientId), {
    onSome: (target) => Option.some(Arr.of(target)),
    onNone: () => aliasTargets,
  });
  if (Option.isNone(targets)) return Plan.Drop({ reason: "no-recipient" });
  // Paused recipients get nothing; mail goes on to the others. When all are paused, mail to a
  // forward-mode alias still counts as admitted mail that failed (PLAN.md §20.33), to send again
  // once one is resumed; a `both` alias has it in its inbox.
  const live = Arr.filter(targets.value, (target) => Option.isNone(target.bouncedAt));
  const isPaused = !Arr.isReadonlyArrayNonEmpty(live);
  if (isPaused && alias.mode !== "forward") return Plan.Drop({ reason: "recipient-bounced" });
  const destinations = Arr.isReadonlyArrayNonEmpty(live) ? live : targets.value;
  const sender = Policy.sender(record.ses.mail);
  if (Option.isNone(sender)) return Plan.Drop({ reason: "no-sender" });
  if (!Policy.isStorableAddress(sender.value.address)) {
    return Plan.Drop({ reason: "unencodable-sender" });
  }
  // Only read here. A new sender's contact is written once the message is admitted, after the
  // hourly cap, so a rate-limited flood from changing addresses writes nothing (PLAN.md §20.25).
  const known = yield* (yield* ContactRepo.ContactRepo).findByAddress(
    alias.id,
    sender.value.address,
  );
  if (Option.exists(known, (contact) => contact.isBlocked)) {
    return Plan.Block({ alias, reason: "blocked-contact" });
  }
  const address = aliasAddress(alias);
  const reverseKeys = yield* ReverseKeys.ReverseKeys;
  const settings = yield* (yield* UserRepo.UserRepo).settings(alias.userId);
  const protection: Mail.Protection = ruled.isTrackerRemovalSkipped
    ? { images: "off", isLinkCleaningEnabled: false }
    : { images: settings.imageProtection, isLinkCleaningEnabled: settings.isLinkCleaningEnabled };
  const edits: Mail.Edits = { subject: ruled.subject, displayName: ruled.displayName };
  const imageProxy = yield* ImageProxySigner;
  const aliases = yield* AliasRepo.AliasRepo;
  const { forwardsPerHour } = yield* Limits.Limits;
  // Encryption comes after every other rewrite: what is encrypted is exactly what the owner
  // would otherwise have received.
  const encrypt = (target: RecipientRepo.Recipient) => (forwarded: Uint8Array) =>
    Option.match(ruled.isEncryptionSkipped ? Option.none() : target.encryption, {
      onNone: () => Effect.succeed(forwarded),
      onSome: (key) =>
        Effect.flatMap(DateTime.now, (now) =>
          Pgp.encrypt(forwarded, {
            key: key.publicKey,
            isSubjectHidden: key.isSubjectHidden,
            now,
          }),
        ),
    });
  const admit = Effect.fn("Pipeline.admitForward")(function* (signals: Mail.Signals) {
    const loop = Policy.forwardLoop(signals, address, record.ses.mail, recipients);
    if (Option.isSome(loop)) return Result.fail<Refusal>(Plan.Block({ alias, reason: loop.value }));
    const isReserved = yield* aliases.reserveForward(
      alias.domain,
      alias.localPart,
      yield* DateTime.now,
      forwardsPerHour,
    );
    if (!isReserved) return Result.fail<Refusal>(Plan.Block({ alias, reason: "rate-limited" }));
    const found = yield* Option.match(known, {
      onSome: (contact) => Effect.succeedSome(contact),
      onNone: () =>
        createContact(alias, sender.value).pipe(
          Effect.map(Option.some),
          Effect.catchTag("NoSuchAlias", () => Effect.succeedNone),
        ),
    });
    if (Option.isNone(found)) return Result.fail<Refusal>(Plan.Drop({ reason: "unknown-alias" }));
    const contact = found.value;
    // A concurrent first message may have stored it, and the owner blocked it since.
    if (contact.isBlocked) {
      return Result.fail<Refusal>(Plan.Block({ alias, reason: "blocked-contact" }));
    }
    // The token names the contact, not the sender: short whatever the address, and revoked with
    // the contact.
    const token = yield* ReverseToken.mint(reverseKeys, address, contact.id).pipe(Effect.option);
    if (Option.isNone(token)) {
      return Result.fail<Refusal>(Plan.Drop({ reason: "unencodable-sender" }));
    }
    const from = Address.format(Address.reverseAddress(address, token.value));
    return Result.succeed<Outgoing>({
      contactId: Option.some(contact.id),
      rewrite: (raw) =>
        Mail.forward(raw, {
          alias: address,
          sender: sender.value,
          token: token.value,
          protection,
          // Proxied images spend the alias owner's fetch budget (PLAN.md §20.29).
          imageProxy: { ...imageProxy, owner: { aliasId: alias.id, userId: alias.userId } },
          edits,
          // Signing image URLs needs a working SHA-256; without one nothing can run.
        }).pipe(Effect.catchTag("PlatformError", Effect.die)),
      copies: Arr.map(destinations, (target) => ({
        recipientId: Option.some(target.id),
        seal: encrypt(target),
        envelope: { from, to: [target.address], tags: SendingEvent.tags(alias.userId, "forward") },
      })),
      undeliverable: isPaused ? Option.some("recipient-bounced") : Option.none(),
    });
  });
  return Plan.Send({
    kind: "forward",
    alias,
    failure:
      alias.mode === "forward"
        ? Option.some({ sender: sender.value.address, isKept: settings.isFailedMailKept })
        : Option.none(),
    admit,
    notify: ruled.notify,
  });
});

const planReply = Effect.fn("Pipeline.planReply")(function* (
  record: Record,
  alias: AliasRepo.Alias,
  token: string,
) {
  const address = aliasAddress(alias);
  const claims = yield* ReverseToken.verify(yield* ReverseKeys.ReverseKeys, address, token).pipe(
    Effect.option,
  );
  if (Option.isNone(claims)) return Plan.Drop({ reason: "bad-token" });
  const target = yield* replyTarget(alias, claims.value);
  if (Result.isFailure(target)) return Plan.Drop({ reason: target.failure });
  const contact = target.success;
  // The blocklist and a rule's `block` work both ways, like a blocked contact; nothing else of
  // a rule touches a reply (PLAN.md §20.32).
  const filtered = yield* filter(record, alias, Option.some(contact));
  if (Result.isFailure(filtered)) return Plan.Drop({ reason: filtered.failure.reason });
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
  const outgoing: Outgoing = {
    contactId: Option.none(),
    rewrite: (raw) => Mail.reply(raw, { alias: address, to: contact, messageId, owner }),
    copies: [
      {
        recipientId: Option.none(),
        seal: Effect.succeed,
        envelope: {
          from: Address.format(address),
          to: [contact],
          tags: SendingEvent.tags(alias.userId, "reply"),
        },
      },
    ],
    undeliverable: Option.none(),
  };
  const { sendsPerDay } = yield* Limits.Limits;
  // Mail the owner writes: an answer, or a first message to a contact they added (PLAN.md §20.33).
  const admit = Effect.fn("Pipeline.admitReply")(function* (signals: Mail.Signals) {
    const rejected = Policy.automatedReply(signals, record.ses.mail).pipe(
      Option.orElse(() => Policy.rejectReply(record.ses.receipt, from, recipients)),
      Option.orElse(() => Policy.rejectAmbiguousSender(signals, from)),
    );
    if (Option.isSome(rejected)) return Result.fail<Refusal>(Plan.Drop({ reason: rejected.value }));
    // SES would take it and drop it; unknown is no reason to refuse, SES still drops what it must.
    const isSuppressed = yield* (yield* Transport.Transport)
      .isSuppressed(contact)
      .pipe(
        Effect.catchTag("SuppressionError", (error) =>
          Effect.as(Effect.logWarning("inbound suppression check failed", error.reason), false),
        ),
      );
    if (isSuppressed) return Result.fail<Refusal>(Plan.Drop({ reason: "suppressed-recipient" }));
    const outbox = yield* OutboxRepo.OutboxRepo;
    if (!(yield* outbox.reserveSend(alias.userId, yield* DateTime.now, sendsPerDay))) {
      return Result.fail<Refusal>(Plan.Drop({ reason: "send-limited" }));
    }
    return Result.succeed(outgoing);
  });
  return Plan.Send({ kind: "reply", alias, failure: Option.none(), admit });
});

/**
 * Creates the alias for mail to an unknown address on its owner's domain (PLAN.md §3.2 step 1):
 * a user subdomain or custom domain whose owner opted in. Spam and viruses never create one, and
 * each user may create only `Limits.aliasesCreatedPerDay` this way. A deleted alias stays
 * deleted: mail to it is dropped like mail to any unknown address and spends nothing. A
 * concurrent creation of the same address is fine: both then use the one that was stored.
 */
const createFor = Effect.fn("Pipeline.createFor")(function* (
  record: Record,
  address: Address.MailAddress,
  ownerId: string,
) {
  const aliases = yield* AliasRepo.AliasRepo;
  const screened = Policy.screen(record.ses.receipt, "drop");
  if (Option.isSome(screened)) return Result.fail<Policy.DropReason>(screened.value);
  if (yield* aliases.isDeleted(address.domain, address.local)) {
    return Result.fail<Policy.DropReason>("unknown-alias");
  }
  const now = yield* DateTime.now;
  const { aliasesCreatedPerDay } = yield* Limits.Limits;
  if (!(yield* aliases.reserveCreation(ownerId, now, aliasesCreatedPerDay))) {
    return Result.fail<Policy.DropReason>("creation-limited");
  }
  const ulid = yield* Effect.orDie((yield* Crypto.Crypto).randomULID);
  const aliasId = `al_${ulid.toLowerCase()}`;
  const isCreated = yield* aliases
    .insert({
      id: aliasId,
      userId: ownerId,
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
      ownerId,
      {
        type: "alias.created",
        timestamp: DateTime.formatIso(now),
        data: { aliasId, address: Address.format(address), origin: "on-the-fly" },
      },
      aliasId,
    );
  }
  const created = yield* aliases.findByAddress(address.domain, address.local);
  return Option.match(
    Option.filter(created, (alias) => alias.userId === ownerId),
    {
      onNone: () => Result.fail<Policy.DropReason>("unknown-alias"),
      onSome: Result.succeed,
    },
  );
});

/**
 * On a user subdomain: the subdomain's owner must have turned on-the-fly aliases on, for their
 * primary username in the account's settings, for an additional one on that username (PLAN.md
 * §20.34).
 */
const createOnTheFly = Effect.fn("Pipeline.createOnTheFly")(function* (
  record: Record,
  address: Address.MailAddress,
  username: string,
) {
  // Role mailboxes on a user's subdomain are never aliases (PLAN.md §20.27).
  if (Address.isRoleLocal(address.local)) return Result.fail<Policy.DropReason>("unknown-alias");
  const owner = yield* (yield* UsernameRepo.UsernameRepo).findOwner(username);
  if (Option.isNone(owner)) return Result.fail<Policy.DropReason>("unknown-alias");
  const { userId, additional } = owner.value;
  const isEnabled = yield* Option.match(additional, {
    onNone: () =>
      UserRepo.UserRepo.use((users) =>
        Effect.map(users.settings(userId), (settings) => settings.isOnTheFlyEnabled),
      ),
    onSome: (entry) => Effect.succeed(entry.isOnTheFlyEnabled),
  });
  if (!isEnabled) return Result.fail<Policy.DropReason>("unknown-alias");
  return yield* createFor(record, address, userId);
});

/**
 * The verified custom domain an address is on (PLAN.md §20.18.2). Anything else is dropped: a
 * domain nobody added, or one that is pending or failed, receives nothing and sends nothing.
 */
const customDomain = Effect.fn("Pipeline.customDomain")(function* (domain: string) {
  const found = yield* (yield* DomainRepo.DomainRepo).find(domain);
  if (Option.isNone(found)) return Result.fail<Policy.DropReason>("unknown-domain");
  return found.value.status === "verified"
    ? Result.succeed(found.value)
    : Result.fail<Policy.DropReason>("unverified-domain");
});

/** Decides what to do for one recipient. Reads the table, never the message. */
const plan = Effect.fn("Pipeline.plan")(function* (record: Record, recipient: string) {
  const routed = yield* route(
    recipient,
    yield* SharedDomains.SharedDomains,
    yield* TempDomains.TempDomains,
  );
  if (Route.$is("Unroutable")(routed)) return Plan.Drop({ reason: "unroutable" });
  const domain = routed.isCustomDomain
    ? Result.map(yield* customDomain(routed.alias.domain), Option.some)
    : Result.succeed(Option.none<DomainRepo.Domain>());
  if (Result.isFailure(domain)) return Plan.Drop({ reason: domain.failure });
  const custom = domain.success;
  // On a custom domain only its owner's aliases count; one a previous owner of the domain left
  // behind must never receive mail for the new owner.
  const found = Option.filter(
    yield* (yield* AliasRepo.AliasRepo).findByAddress(routed.alias.domain, routed.alias.local),
    (alias) =>
      Option.match(custom, {
        onNone: () => true,
        onSome: (owned) => owned.userId === alias.userId,
      }),
  );
  const resolved = yield* Option.match(found, {
    onSome: (alias) => Effect.succeed(Result.succeed(alias)),
    onNone: () => {
      if (!Route.$is("Forward")(routed)) {
        return Effect.succeed(Result.fail<Policy.DropReason>("unknown-alias"));
      }
      if (Option.isSome(routed.username)) {
        return createOnTheFly(record, routed.alias, routed.username.value);
      }
      return Option.match(
        Option.filter(custom, (owned) => owned.isCatchAllEnabled),
        {
          onNone: () => Effect.succeed(Result.fail<Policy.DropReason>("unknown-alias")),
          onSome: (owned) => createFor(record, routed.alias, owned.userId),
        },
      );
    },
  });
  if (Result.isFailure(resolved)) return Plan.Drop({ reason: resolved.failure });
  const alias = resolved.success;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (Option.exists(alias.inboxExpiresAt, (at) => at <= now)) {
    return Plan.Drop({ reason: "expired-inbox" });
  }
  if (!alias.isActive) return Plan.Block({ alias, reason: "inactive-alias" });
  const screened = Policy.screen(record.ses.receipt, Policy.spamAction(alias));
  if (Option.isSome(screened)) return Plan.Block({ alias, reason: screened.value });
  if (Route.$is("Reply")(routed)) return yield* planReply(record, alias, routed.token);
  const filtered = yield* filter(
    record,
    alias,
    Option.map(Policy.sender(record.ses.mail), (sender) => sender.address),
  );
  if (Result.isFailure(filtered)) {
    return Plan.Block({ alias, reason: filtered.failure.reason, notify: filtered.failure.notify });
  }
  const ruled = filtered.success;
  // Inbox mode keeps mail as it came: only a rule's block and webhook apply.
  if (alias.mode === "inbox") {
    return Plan.Store({ alias, forward: Option.none(), notify: ruled.notify });
  }
  const forwarding = yield* planForward(record, alias, ruled);
  if (alias.mode === "forward" || Plan.$is("Block")(forwarding)) return forwarding;
  // Both: kept in any case, forwarded when it can be.
  return Plan.Store({
    alias,
    forward: Plan.$is("Send")(forwarding) ? Option.some(forwarding) : Option.none(),
    notify: ruled.notify,
  });
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
    | { readonly type: "mail.blocked"; readonly reason: Policy.DropReason }
    | {
        readonly type: "mail.failed";
        readonly reason: Policy.DropReason;
        readonly failureId: string;
      },
) {
  const timestamp = DateTime.formatIso(yield* DateTime.now);
  const ref = { aliasId: alias.id, address: Address.format(aliasAddress(alias)) };
  const event: WebhookEvent =
    what.type === "mail.forwarded"
      ? { type: what.type, timestamp, data: { ...ref, contactId: what.contactId } }
      : what.type === "mail.failed"
        ? {
            type: what.type,
            timestamp,
            data: { ...ref, failureId: what.failureId, reason: what.reason },
          }
        : { type: what.type, timestamp, data: { ...ref, reason: what.reason } };
  yield* (yield* Publisher.Publisher).publish(
    alias.userId,
    event,
    `${delivery.messageId}:${delivery.recipient}`,
  );
});

/** One `rule.matched` event per rule whose `webhook` action matched, keyed by message and rule. */
const announceRules = (
  delivery: DeliveryRepo.Delivery,
  alias: AliasRepo.Alias,
  ruleIds: ReadonlyArray<string>,
) =>
  Effect.forEach(
    ruleIds,
    Effect.fnUntraced(function* (ruleId) {
      const event: WebhookEvent = {
        type: "rule.matched",
        timestamp: DateTime.formatIso(yield* DateTime.now),
        data: { aliasId: alias.id, address: Address.format(aliasAddress(alias)), ruleId },
      };
      yield* (yield* Publisher.Publisher).publish(
        alias.userId,
        event,
        `${delivery.messageId}:${delivery.recipient}:${ruleId}`,
      );
    }),
    { concurrency: 1, discard: true },
  );

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

/** What became of one copy of a message going to several mailboxes. */
type CopyOutcome = Data.TaggedEnum<{
  /** Sent now, or (`isEarlier`) by an earlier invocation. */
  Sent: { readonly isEarlier: boolean };
  Refused: { readonly reason: "rejected" | "key-unusable" };
  Deferred: { readonly error: Transport.TransportRetryable };
}>;
const CopyOutcome = Data.taggedEnum<CopyOutcome>();

/** Seals one copy for its mailbox, sends it, and remembers it for its bounces. */
const sendCopy = Effect.fn("Pipeline.sendCopy")(function* (
  planned: Send,
  copy: Copy,
  rewritten: Uint8Array,
) {
  const sealed = yield* copy.seal(rewritten);
  const messageId = yield* (yield* Transport.Transport).send(sealed, copy.envelope);
  yield* SentRepo.remember({
    messageId,
    userId: planned.alias.userId,
    kind: planned.kind,
    recipientId: copy.recipientId,
  });
});

/**
 * Sends each copy of a message that goes to several mailboxes once, under its own claim
 * (`<recipient>#TO#<recipientId>`): a retry after one copy failed for now sends only the copies
 * still missing. A copy SES refuses, or whose recipient's key can't encrypt, is dropped alone.
 */
const sendCopies = Effect.fn("Pipeline.sendCopies")(function* (
  delivery: DeliveryRepo.Delivery,
  planned: Send,
  copies: Arr.NonEmptyReadonlyArray<Copy>,
  rewritten: Uint8Array,
) {
  const deliveries = yield* DeliveryRepo.DeliveryRepo;
  const expiresAt = DateTime.addDuration(yield* DateTime.now, CLAIM_LIFETIME);
  return yield* Effect.forEach(
    copies,
    Effect.fnUntraced(function* (copy) {
      const claim: DeliveryRepo.Delivery = {
        messageId: delivery.messageId,
        recipient: `${delivery.recipient}#TO#${Option.getOrElse(copy.recipientId, () => "")}`,
      };
      if (!(yield* deliveries.claim(claim, expiresAt))) {
        return CopyOutcome.Sent({ isEarlier: true });
      }
      return yield* sendCopy(planned, copy, rewritten).pipe(
        Effect.as(CopyOutcome.Sent({ isEarlier: false })),
        Effect.catchTags({
          TransportRejected: () => Effect.succeed(CopyOutcome.Refused({ reason: "rejected" })),
          InvalidKey: () => Effect.succeed(CopyOutcome.Refused({ reason: "key-unusable" })),
          TransportRetryable: (error) =>
            Effect.as(deliveries.release(claim), CopyOutcome.Deferred({ error })),
        }),
      );
    }),
    { concurrency: 1 },
  );
});

/** A forward's rewritten message and the reverse alias it goes out from, to keep and resend. */
interface KeptCopy {
  readonly raw: Uint8Array;
  readonly envelopeFrom: string;
}

/** Failed deliveries are listed, and kept copies kept, for a week (PLAN.md §20.33). */
const FAILURE_LIFETIME = Duration.days(7);

/**
 * Records a forward that failed for good as a failed delivery (PLAN.md §20.33), with the
 * rewritten message sealed in the inbox bucket when the owner keeps failed mail and it fits, and
 * tells the owner's webhooks. At most `failuresPerDay` per user. Best effort: the outcome of the
 * mail stands whatever happens here.
 */
const recordFailure = Effect.fn("Pipeline.recordFailure")(
  function* (
    delivery: DeliveryRepo.Delivery,
    planned: Send,
    reason: Policy.DropReason,
    size: number,
    copy: Option.Option<KeptCopy>,
  ) {
    if (Option.isNone(planned.failure)) return;
    const note = planned.failure.value;
    const alias = planned.alias;
    const { failuresPerDay, maxStoredBytes } = yield* Limits.Limits;
    const failures = yield* FailureRepo.FailureRepo;
    const now = yield* DateTime.now;
    if (!(yield* failures.reserve(alias.userId, now, failuresPerDay))) {
      return yield* Effect.logInfo("inbound failure not recorded", "limit");
    }
    const ulid = yield* Effect.orDie((yield* Crypto.Crypto).randomULID);
    const failureId = `fail_${ulid.toLowerCase()}`;
    const inbox = yield* Inbox.Inbox;
    const toKeep = Option.filter(
      copy,
      (kept) => note.isKept && kept.raw.byteLength <= maxStoredBytes,
    );
    const kept = yield* Option.match(toKeep, {
      onNone: () => Effect.succeedNone,
      onSome: (kept) =>
        Effect.map(inbox.keep(alias, failureId, kept.raw), (body) =>
          Option.some({ ...body, envelopeFrom: kept.envelopeFrom }),
        ),
    });
    yield* failures
      .insert(
        {
          id: failureId,
          aliasId: alias.id,
          userId: alias.userId,
          alias: Address.format(aliasAddress(alias)),
          sender: Option.some(note.sender),
          reason,
          receivedAt: now,
          expiresAt: DateTime.addDuration(now, FAILURE_LIFETIME),
          size,
          kept,
        },
        alias,
      )
      // Without its record a kept copy can't be opened; remove it right away.
      .pipe(
        Effect.tapError(() =>
          Option.match(kept, {
            onNone: () => Effect.void,
            onSome: (body) => Effect.ignore(inbox.discard(body.objectKey)),
          }),
        ),
      );
    yield* Effect.logInfo("inbound failure recorded", reason);
    yield* announce(delivery, alias, { type: "mail.failed", reason, failureId });
  },
  Effect.catch((error) => Effect.logWarning("inbound failure not recorded", error._tag)),
);

/** Size check, read, header checks, rewrite, send: everything after the claim. */
const send = Effect.fn("Pipeline.send")(function* (
  delivery: DeliveryRepo.Delivery,
  planned: Send,
  message: Spooled,
) {
  const { maxMessageBytes } = yield* Limits.Limits;
  const size = yield* message.size;
  if (size > maxMessageBytes) {
    yield* recordFailure(delivery, planned, "too-large", size, Option.none());
    return yield* refuse(delivery, Plan.Block({ alias: planned.alias, reason: "too-large" }));
  }
  const raw = yield* message.raw;
  const admitted = yield* planned.admit(yield* Mail.signals(raw));
  if (Result.isFailure(admitted)) return yield* refuse(delivery, admitted.failure);
  const outgoing = admitted.success;
  const rewritten = yield* outgoing.rewrite(raw);
  const failed = (reason: Policy.DropReason) =>
    recordFailure(
      delivery,
      planned,
      reason,
      size,
      Option.some({ raw: rewritten, envelopeFrom: outgoing.copies[0].envelope.from }),
    );
  if (Option.isSome(outgoing.undeliverable)) {
    yield* failed(outgoing.undeliverable.value);
    return dropped(outgoing.undeliverable.value);
  }
  const [first, ...others] = outgoing.copies;
  if (Arr.isArrayNonEmpty(others)) {
    // Several mailboxes: each copy on its own (one copy's failure is handled like a single one's
    // below, but for that copy alone).
    const outcomes = yield* sendCopies(delivery, planned, outgoing.copies, rewritten);
    const later = Arr.findFirst(outcomes, CopyOutcome.$is("Deferred"));
    if (Option.isSome(later)) return yield* later.value.error;
    const refusals = Arr.filter(outcomes, CopyOutcome.$is("Refused"));
    yield* Effect.forEach(
      refusals,
      ({ reason }) => Effect.logInfo("inbound copy dropped", reason),
      { concurrency: 1, discard: true },
    );
    if (Arr.length(refusals) === Arr.length(outcomes)) {
      const isKeyUnusable = Arr.some(refusals, ({ reason }) => reason === "key-unusable");
      yield* failed(isKeyUnusable ? "key-unusable" : "rejected");
      return yield* refuse(
        delivery,
        isKeyUnusable
          ? Plan.Block({ alias: planned.alias, reason: "key-unusable" })
          : Plan.Drop({ reason: "rejected" }),
      );
    }
  } else {
    const refused = yield* sendCopy(planned, first, rewritten).pipe(
      Effect.as(Option.none<"rejected" | "key-unusable">()),
      // Only the message's own content (or its key) is at fault: sending again fails alike.
      Effect.catchTags({
        TransportRejected: () => Effect.succeedSome("rejected" as const),
        InvalidKey: () => Effect.succeedSome("key-unusable" as const),
      }),
    );
    if (Option.isSome(refused)) {
      yield* failed(refused.value);
      return yield* refuse(
        delivery,
        refused.value === "key-unusable"
          ? Plan.Block({ alias: planned.alias, reason: "key-unusable" })
          : Plan.Drop({ reason: "rejected" }),
      );
    }
  }
  if (planned.kind === "reply") return replied;
  yield* count(planned.alias, "forwarded");
  if (Option.isSome(outgoing.contactId)) {
    yield* announce(delivery, planned.alias, {
      type: "mail.forwarded",
      contactId: outgoing.contactId.value,
    });
  }
  return forwarded;
});

/**
 * Inbox mode: size and daily allowance first, then the message is sealed and stored. For `both`,
 * the forward follows; if it is deferred, Lambda's retry stores the message a second time,
 * which beats forwarding it twice.
 */
const store = Effect.fn("Pipeline.store")(function* (
  delivery: DeliveryRepo.Delivery,
  planned: { readonly alias: AliasRepo.Alias; readonly forward: Option.Option<Send> },
  message: Spooled,
) {
  const { maxStoredBytes, storedPerDay } = yield* Limits.Limits;
  const alias = planned.alias;
  if ((yield* message.size) > maxStoredBytes) {
    return yield* refuse(delivery, Plan.Block({ alias, reason: "too-large" }));
  }
  const messages = yield* MessageRepo.MessageRepo;
  if (!(yield* messages.reserveStorage(alias.userId, yield* DateTime.now, storedPerDay))) {
    return yield* refuse(delivery, Plan.Block({ alias, reason: "storage-limited" }));
  }
  const kept = yield* (yield* Inbox.Inbox).store(alias, yield* message.raw).pipe(
    Effect.as(Option.none<Outcome>()),
    Effect.catchTags({
      NoSuchAlias: () => Effect.succeed(Option.some(dropped("unknown-alias"))),
      UnreadableMessage: () => Effect.succeed(Option.some(dropped("malformed-message"))),
    }),
  );
  if (Option.isSome(kept)) return kept.value;
  yield* Effect.logInfo("inbound stored");
  return yield* Option.match(planned.forward, {
    onNone: () => Effect.succeed(stored),
    onSome: (forward) => send(delivery, forward, message),
  });
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
  yield* announceRules(delivery, planned.alias, planned.notify ?? []);
  if (Plan.$is("Block")(planned)) return yield* refuse(delivery, planned);
  // Temporary failures give the claim back so Lambda's retry can send it.
  const defer = (code: string) => Effect.as(deliveries.release(delivery), deferred(code));
  return yield* (
    Plan.$is("Store")(planned)
      ? store(delivery, planned, message)
      : send(delivery, planned, message)
  ).pipe(
    Effect.catchTags({
      InboxUnavailable: (error) => defer(error._tag),
      MessageGone: () => Effect.succeed(dropped("spool-missing")),
      MalformedMessage: () => Effect.succeed(dropped("malformed-message")),
      // Only from the reply path's rewrite: a forward's key is checked when it is sealed.
      InvalidKey: () =>
        refuse(delivery, Plan.Block({ alias: planned.alias, reason: "key-unusable" })),
      TransportRetryable: (error) => defer(error.code),
      SpoolError: (error) => defer(error._tag),
      DatabaseError: (error) => defer(error._tag),
    }),
  );
});

const log = (outcome: Outcome) =>
  Outcome.match(outcome, {
    Forwarded: () => Effect.logInfo("inbound forwarded"),
    Stored: () => Effect.void,
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
 * What callers provide: the table, SES sending, the spool, the shared domains, the token keys, the
 * webhook queue and the image proxy's signer.
 */
export type Services =
  | Dynamo.Database
  | Transport.Transport
  | MessageQueue.MessageQueue
  | Spool
  | SharedDomains.SharedDomains
  | ReverseKeys.ReverseKeys
  | ImageProxySigner
  | TempDomains.TempDomains
  | Inbox.Inbox;

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
    SentRepo.layer,
    DeliveryRepo.layer,
    DomainRepo.layer,
    FailureRepo.layer,
    FilterRepo.layer,
    MessageRepo.layer,
    OutboxRepo.layer,
    UserRepo.layer,
    UsernameRepo.layer,
    NodeCrypto.layer,
    Publisher.layer.pipe(Layer.provide(NodeCrypto.layer)),
    Layer.succeed(Limits.Limits, limits),
  ).pipe(Layer.provideMerge(services));
