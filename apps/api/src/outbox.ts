import { SendingEvent, Transport } from "@alias/aws";
import {
  Api,
  ComposeRefused,
  ContactNotFound,
  CurrentUser,
  type Draft,
  DraftClosed,
  DraftNotFound,
  SendFailed,
} from "@alias/contracts";
import { Mail } from "@alias/core";
import { type AliasRepo, ContactRepo, type FilterRepo, OutboxRepo, SentRepo } from "@alias/db";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ownedAlias } from "./aliases.ts";
import * as Contacts from "./contacts.ts";

/**
 * Confirm-gated sending (PLAN.md §20.24). An MCP client with `mail:send` can only draft: mail
 * from one of the user's aliases to one of that alias's contacts, the same people the user can
 * already reply to. The draft goes out when the signed-in user sends it from the web app, which
 * no token can do, so a prompt-injected assistant can at most leave a draft for the user to
 * read and discard.
 *
 * The signed-in owner also composes new mail in the web app (PLAN.md §20.33): to any address,
 * which becomes a contact of the alias, then drafted and sent at once through the same `send`.
 * Every send counts against the owner's daily allowance, shared with replies.
 */

/** How long a draft waits for its user. */
const PENDING_FOR = Duration.hours(1);
/** How long a decided draft stays readable (its status, for the client that drafted it). */
const KEPT_FOR = Duration.days(1);

/** Why a draft can't be made. */
class DraftRefused extends Schema.TaggedError<DraftRefused>()("DraftRefused", {
  reason: Schema.Literals(["inactive-alias", "blocked-contact"]),
}) {}

const status = (draft: OutboxRepo.Draft, now: DateTime.Utc): Draft["status"] =>
  draft.status === "pending" && !DateTime.isGreaterThan(draft.pendingUntil, now)
    ? "expired"
    : draft.status;

export const view = (draft: OutboxRepo.Draft, now: DateTime.Utc): Draft => ({
  id: draft.id,
  from: `${draft.aliasLocal}@${draft.aliasDomain}`,
  to: draft.to,
  contactName: draft.contactName,
  subject: draft.subject,
  text: draft.text,
  clientName: draft.clientName,
  status: status(draft, now),
  createdAt: draft.createdAt,
  expiresAt: draft.pendingUntil,
});

/** The caller's alias at `address` and its contact `contactId`, both still usable. */
const target = Effect.fn("outbox.target")(function* (address: string, contactId: string) {
  const at = address.lastIndexOf("@");
  const alias = yield* ownedAlias({ local: address.slice(0, at), domain: address.slice(at + 1) });
  if (!alias.isActive) return yield* new DraftRefused({ reason: "inactive-alias" });
  const contacts = yield* ContactRepo.ContactRepo;
  const contact = yield* Effect.orDie(contacts.findById(alias.id, contactId));
  if (Option.isNone(contact)) return yield* new ContactNotFound({ contactId });
  if (contact.value.isBlocked) return yield* new DraftRefused({ reason: "blocked-contact" });
  return { alias, contact: contact.value };
});

/** Stores a draft for the caller to send or discard. */
export const draft = Effect.fn("outbox.draft")(function* (request: {
  readonly from: string;
  readonly contactId: string;
  readonly subject: string;
  readonly text: string;
  readonly clientName: string;
}) {
  const user = yield* CurrentUser;
  const crypto = yield* Crypto.Crypto;
  const repo = yield* OutboxRepo.OutboxRepo;
  const { alias, contact } = yield* target(request.from, request.contactId);
  const now = yield* DateTime.now;
  const stored: OutboxRepo.NewDraft = {
    id: `drf_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`,
    userId: user.userId,
    aliasId: alias.id,
    aliasDomain: alias.domain,
    aliasLocal: alias.localPart,
    contactId: contact.id,
    to: contact.address,
    contactName: contact.name,
    subject: request.subject,
    text: request.text,
    clientName: request.clientName,
    createdAt: now,
    pendingUntil: DateTime.addDuration(now, PENDING_FOR),
    expiresAt: DateTime.addDuration(now, KEPT_FOR),
  };
  yield* Effect.orDie(repo.create(stored));
  return view({ ...stored, status: "pending" }, now);
});

/** The caller's draft, as it stands. */
export const find = Effect.fn("outbox.find")(function* (draftId: string) {
  const user = yield* CurrentUser;
  const repo = yield* OutboxRepo.OutboxRepo;
  const found = yield* Effect.orDie(repo.find(user.userId, draftId));
  if (Option.isNone(found)) return yield* new DraftNotFound({ draftId });
  return found.value;
});

const closed = (found: OutboxRepo.Draft, now: DateTime.Utc) =>
  new DraftClosed({ draftId: found.id, status: status(found, now) });

const refused = (draftId: string, reason: SendFailed["reason"], isRetryable = false) =>
  new SendFailed({ draftId, reason, isRetryable });

/**
 * Sends the caller's pending draft, once: the draft leaves `pending` before SES is called, and
 * goes back only if SES didn't take it. Alias and contact are checked again, since either may
 * have changed while the draft waited.
 */
const send = Effect.fn("outbox.send")(function* (draftId: string) {
  const user = yield* CurrentUser;
  const repo = yield* OutboxRepo.OutboxRepo;
  const transport = yield* Transport.Transport;
  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now;
  const found = yield* find(draftId);
  if (status(found, now) !== "pending") return yield* closed(found, now);
  const { alias, contact } = yield* target(
    `${found.aliasLocal}@${found.aliasDomain}`,
    found.contactId,
  ).pipe(
    Effect.catchTags({
      AliasNotFound: () => Effect.fail(refused(draftId, "inactive-alias")),
      ContactNotFound: () => Effect.fail(refused(draftId, "unknown-contact")),
      DraftRefused: (error) => Effect.fail(refused(draftId, error.reason)),
    }),
  );
  if (alias.id !== found.aliasId) return yield* refused(draftId, "inactive-alias");
  // Blocked since it was drafted (PLAN.md §20.32): the owner wants nothing to do with it.
  if (yield* Contacts.isBlocklisted(user.userId, contact.address)) {
    return yield* refused(draftId, "blocked-address");
  }
  // SES would take mail to a suppressed address and drop it; say so instead (PLAN.md §20.33).
  // Unknown is not a reason to refuse: SES still drops what it must.
  const isSuppressed = yield* transport
    .isSuppressed(contact.address)
    .pipe(
      Effect.catchTag("SuppressionError", (error) =>
        Effect.as(Effect.logWarning("outbox suppression check failed", error.reason), false),
      ),
    );
  if (isSuppressed) return yield* refused(draftId, "suppressed");
  if (!(yield* Effect.orDie(repo.reserveSend(user.userId, now, OutboxRepo.SENDS_PER_DAY)))) {
    return yield* refused(draftId, "limit-reached");
  }
  const sent = yield* repo.close(user.userId, draftId, "sent", now).pipe(
    Effect.catchTags({
      DraftNotPending: () =>
        Effect.flatMap(Effect.orDie(repo.find(user.userId, draftId)), (latest) =>
          Effect.fail(
            closed(
              Option.getOrElse(latest, () => found),
              now,
            ),
          ),
        ),
      DatabaseError: Effect.die,
    }),
  );
  const raw = Mail.compose({
    alias: { local: alias.localPart, domain: alias.domain },
    to: contact.address,
    subject: sent.subject,
    text: sent.text,
    messageId: (yield* Effect.orDie(crypto.randomULID)).toLowerCase(),
    date: now,
  });
  // Tagged like a reply: a message to a contact, so only a gone mailbox's bounce suppresses it.
  const messageId = yield* transport
    .send(raw, {
      from: `${alias.localPart}@${alias.domain}`,
      to: [contact.address],
      tags: SendingEvent.tags(user.userId, "reply"),
    })
    .pipe(
      Effect.tapError(() => Effect.orDie(repo.reopen(user.userId, draftId))),
      Effect.catchTags({
        TransportRejected: () => Effect.fail(refused(draftId, "rejected")),
        TransportRetryable: () => Effect.fail(refused(draftId, "unavailable", true)),
      }),
    );
  yield* SentRepo.remember({
    messageId,
    userId: user.userId,
    kind: "reply",
    recipientId: Option.none(),
  });
  yield* Effect.logInfo("outbox sent", draftId);
  return view(sent, now);
});

/** Shown as who drafted mail the owner composed themselves. */
const COMPOSED_BY = "you, in Alias";

/**
 * New mail the owner writes from one of their aliases (PLAN.md §20.33). The recipient becomes a
 * contact of the alias (a new one spends one of the day's new recipients), so it can answer
 * through its reverse alias and the owner can block it; then the mail is drafted and sent like
 * any draft. A send that fails leaves the draft pending, to try again from its page.
 */
const compose = Effect.fn("outbox.compose")(function* (request: {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}) {
  const at = request.from.lastIndexOf("@");
  const alias = yield* ownedAlias({
    local: request.from.slice(0, at),
    domain: request.from.slice(at + 1),
  }).pipe(
    Effect.catchTag("AliasNotFound", () =>
      Effect.fail(new ComposeRefused({ reason: "unknown-alias" })),
    ),
  );
  if (!alias.isActive) return yield* new ComposeRefused({ reason: "inactive-alias" });
  const contact = yield* Contacts.ensure(alias, request.to).pipe(
    Effect.catchTags({
      InvalidContact: (error) => Effect.fail(new ComposeRefused({ reason: error.reason })),
      AliasNotFound: () => Effect.fail(new ComposeRefused({ reason: "unknown-alias" })),
    }),
  );
  if (contact.isBlocked) return yield* new ComposeRefused({ reason: "blocked-contact" });
  const drafted = yield* draft({
    from: `${alias.localPart}@${alias.domain}`,
    contactId: contact.id,
    subject: request.subject,
    text: request.text,
    clientName: COMPOSED_BY,
  }).pipe(
    Effect.catchTags({
      AliasNotFound: () => Effect.fail(new ComposeRefused({ reason: "unknown-alias" })),
      // Only if the contact was deleted in the instant since it was found.
      ContactNotFound: Effect.die,
      DraftRefused: (error) => Effect.fail(new ComposeRefused({ reason: error.reason })),
    }),
  );
  // The draft was made a moment ago: it is there and pending.
  return yield* send(drafted.id).pipe(
    Effect.catchTags({ DraftNotFound: Effect.die, DraftClosed: Effect.die }),
  );
});

const discard = Effect.fn("outbox.discard")(function* (draftId: string) {
  const user = yield* CurrentUser;
  const repo = yield* OutboxRepo.OutboxRepo;
  const now = yield* DateTime.now;
  const found = yield* find(draftId);
  const discarded = yield* repo.close(user.userId, draftId, "discarded", now).pipe(
    Effect.catchTags({
      DraftNotPending: () => Effect.fail(closed(found, now)),
      DatabaseError: Effect.die,
    }),
  );
  return view(discarded, now);
});

/** What the outbox handlers use. The group captures them once, at startup. */
type OutboxServices =
  | Crypto.Crypto
  | AliasRepo.AliasRepo
  | ContactRepo.ContactRepo
  | OutboxRepo.OutboxRepo
  | FilterRepo.FilterRepo
  | SentRepo.SentRepo
  | Transport.Transport;

export const OutboxLive = HttpApiBuilder.group(Api, "outbox", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<OutboxServices>();
    return handlers
      .handle("compose", ({ payload }) => Effect.provide(compose(payload), services))
      .handle("get", ({ params }) =>
        Effect.provide(
          Effect.flatMap(find(params.draftId), (found) =>
            Effect.map(DateTime.now, (now) => view(found, now)),
          ),
          services,
        ),
      )
      .handle("send", ({ params }) => Effect.provide(send(params.draftId), services))
      .handle("discard", ({ params }) => Effect.provide(discard(params.draftId), services));
  }),
);
