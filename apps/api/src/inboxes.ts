import { Address, TempDomains } from "@alias/core";
import {
  Api,
  CurrentUser,
  InboxNotFound,
  type InboxView,
  InvalidTemporaryInbox,
  MAX_WAIT_SECONDS,
  type MessageSummary,
  MessageNotFound,
  TemporaryInboxLimit,
} from "@alias/contracts";
import { AliasRepo } from "@alias/db";
import { Inbox } from "@alias/inbox";
import { Publisher } from "@alias/webhooks";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";

/** Temporary inboxes one user may create per UTC day (PLAN.md §20.22). */
export const TEMPORARY_PER_DAY = 50;

/** A temporary inbox takes mail this long unless the caller asks otherwise. */
const DEFAULT_LIFETIME_HOURS = 24;

/** Most messages one list returns. */
const PAGE_SIZE = 50;

/**
 * Long-poll pacing: the first look again after 250 ms, then twice as long each time, at most
 * every 2 s. A 25 s wait costs about 15 strongly consistent Queries (0.5 RCU each) and 25 s of a
 * 256 MB Lambda; the first seconds, when a code usually arrives, are polled closest.
 */
const FIRST_POLL = Duration.millis(250);
const MAX_POLL = Duration.seconds(2);

const isInbox = (alias: AliasRepo.Alias) => alias.mode === "inbox" || alias.mode === "both";

const isExpired = (alias: AliasRepo.Alias, now: DateTime.Utc) =>
  Option.exists(alias.inboxExpiresAt, (at) => at <= DateTime.toEpochMillis(now));

const view = (alias: AliasRepo.Alias): InboxView => ({
  id: alias.id,
  address: `${alias.localPart}@${alias.domain}`,
  mode: alias.mode === "both" ? "both" : "inbox",
  isTemporary: Option.isSome(alias.inboxExpiresAt),
  expiresAt: Option.map(alias.inboxExpiresAt, (at) => DateTime.makeUnsafe(at)),
  retentionDays: Inbox.retentionOf(alias),
});

interface InboxParams {
  readonly domain: string;
  readonly local: string;
}

const notFound = (params: InboxParams) =>
  new InboxNotFound({ address: `${params.local}@${params.domain}`.toLowerCase() });

/** The caller's inbox at this address. Someone else's, or a forward-only alias, looks missing. */
const ownedInbox = Effect.fn("inboxes.ownedInbox")(function* (params: InboxParams) {
  const user = yield* CurrentUser;
  const found = yield* Effect.orDie(
    (yield* AliasRepo.AliasRepo).findByAddress(params.domain, params.local),
  );
  return yield* Option.match(
    Option.filter(found, (alias) => alias.userId === user.userId && isInbox(alias)),
    { onNone: () => Effect.fail(notFound(params)), onSome: Effect.succeed },
  );
});

/**
 * Deletes an alias for good, with its stored mail: the table first (tombstone, metadata and so
 * the data keys), then the bodies in S3. A body left by a failed second step can't be decrypted
 * any more, and its lifecycle rule removes it within its retention.
 */
export const deleteWithMail = Effect.fn("inboxes.deleteWithMail")(function* (
  alias: AliasRepo.Alias,
) {
  yield* (yield* AliasRepo.AliasRepo).delete(alias);
  yield* (yield* Inbox.Inbox)
    .purge(alias.id)
    .pipe(
      Effect.catchTag("InboxUnavailable", (error) =>
        Effect.logWarning("stored mail not purged; lifecycle will expire it", error.reason),
      ),
    );
  yield* (yield* Publisher.Publisher).publish(
    alias.userId,
    {
      type: "alias.deleted",
      timestamp: DateTime.formatIso(yield* DateTime.now),
      data: { aliasId: alias.id, address: `${alias.localPart}@${alias.domain}` },
    },
    alias.id,
  );
});

/**
 * The caller's inboxes. Expired temporary inboxes are deleted on the way (their addresses stay
 * taken for good, as tombstones), so they never pile up in the list or the table.
 */
const list = Effect.fn("inboxes.list")(function* () {
  const user = yield* CurrentUser;
  const now = yield* DateTime.now;
  const aliases = Arr.filter(
    yield* Effect.orDie((yield* AliasRepo.AliasRepo).listByUser(user.userId)),
    isInbox,
  );
  yield* Effect.forEach(
    Arr.filter(aliases, (alias) => isExpired(alias, now)),
    (alias) =>
      deleteWithMail(alias).pipe(
        Effect.catchTag("NoSuchAlias", () => Effect.void),
        Effect.orDie,
      ),
    { concurrency: 4, discard: true },
  );
  return Arr.map(
    Arr.filter(aliases, (alias) => !isExpired(alias, now)),
    view,
  );
});

/** A temporary inbox: a random address on a temp-mail domain, taking mail for a while. */
export const create = Effect.fn("inboxes.create")(function* (payload: {
  readonly domain?: string;
  readonly lifetimeHours?: number;
}) {
  const user = yield* CurrentUser;
  const temp = yield* TempDomains.TempDomains;
  const first = Arr.head(temp);
  if (Option.isNone(first)) {
    return yield* new InvalidTemporaryInbox({ reason: "temp-mail-disabled" });
  }
  const domain = Option.getOrElse(Option.fromUndefinedOr(payload.domain), () => first.value)
    .trim()
    .toLowerCase();
  if (!Arr.contains(temp, domain)) {
    return yield* new InvalidTemporaryInbox({ reason: "unknown-domain" });
  }
  const repo = yield* AliasRepo.AliasRepo;
  const now = yield* DateTime.now;
  if (!(yield* Effect.orDie(repo.reserveTemporary(user.userId, now, TEMPORARY_PER_DAY)))) {
    return yield* new TemporaryInboxLimit();
  }
  const crypto = yield* Crypto.Crypto;
  const createdAt = DateTime.toEpochMillis(now);
  const inboxExpiresAt = DateTime.toEpochMillis(
    DateTime.add(now, { hours: payload.lifetimeHours ?? DEFAULT_LIFETIME_HOURS }),
  );
  const alias = yield* Effect.gen(function* () {
    const local = yield* Effect.orDie(Address.randomLocal());
    const id = `al_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`;
    const created: AliasRepo.NewAlias = {
      id,
      userId: user.userId,
      domain,
      localPart: local,
      mode: "inbox",
      createdAt,
      inboxExpiresAt,
      retentionDays: 1,
    };
    yield* repo.insert(created);
    return created;
  }).pipe(
    // A taken address, deleted ones included, is never handed out again: draw another.
    Effect.retry({ times: 3, while: (error) => P.isTagged(error, "AliasTaken") }),
    Effect.orDie,
  );
  const address = `${alias.localPart}@${alias.domain}`;
  yield* (yield* Publisher.Publisher).publish(
    user.userId,
    {
      type: "alias.created",
      timestamp: DateTime.formatIso(now),
      data: { aliasId: alias.id, address, origin: "api" },
    },
    alias.id,
  );
  const created: InboxView = {
    id: alias.id,
    address,
    mode: "inbox",
    isTemporary: true,
    expiresAt: Option.some(DateTime.makeUnsafe(inboxExpiresAt)),
    retentionDays: 1,
  };
  return created;
});

/**
 * Lists the inbox's messages after `after`; with `wait`, looks again with growing pauses until
 * one arrives or the wait is over. An empty answer means nothing arrived in time.
 */
export const messages = Effect.fn("inboxes.messages")(function* (
  params: InboxParams,
  query: { readonly after?: string; readonly wait?: number },
) {
  const alias = yield* ownedInbox(params);
  const inbox = yield* Inbox.Inbox;
  const page = { after: Option.fromUndefinedOr(query.after), limit: PAGE_SIZE };
  const deadline = DateTime.addDuration(
    yield* DateTime.now,
    Duration.seconds(Math.min(query.wait ?? 0, MAX_WAIT_SECONDS)),
  );
  const poll = (pause: Duration.Duration): Effect.Effect<ReadonlyArray<MessageSummary>> =>
    Effect.gen(function* () {
      const found = yield* Effect.orDie(inbox.list(alias.id, page));
      const left = DateTime.distance(yield* DateTime.now, deadline);
      if (Arr.isReadonlyArrayNonEmpty(found) || Duration.isLessThanOrEqualTo(left, Duration.zero)) {
        return found;
      }
      yield* Effect.sleep(Duration.min(pause, left));
      return yield* poll(Duration.min(Duration.times(pause, 2), MAX_POLL));
    });
  return yield* poll(FIRST_POLL);
});

const message = Effect.fn("inboxes.message")(function* (
  params: InboxParams & { readonly messageId: string },
) {
  const alias = yield* ownedInbox(params);
  const found = yield* Effect.orDie((yield* Inbox.Inbox).read(alias.id, params.messageId));
  return yield* Option.match(found, {
    onNone: () => Effect.fail(new MessageNotFound({ messageId: params.messageId })),
    onSome: Effect.succeed,
  });
});

const removeMessage = Effect.fn("inboxes.removeMessage")(function* (
  params: InboxParams & { readonly messageId: string },
) {
  const alias = yield* ownedInbox(params);
  if (!(yield* Effect.orDie((yield* Inbox.Inbox).remove(alias.id, params.messageId)))) {
    return yield* new MessageNotFound({ messageId: params.messageId });
  }
});

/** Temporary inboxes only; an inbox alias is deleted like any alias (`DELETE /v1/aliases/…`). */
const remove = Effect.fn("inboxes.remove")(function* (params: InboxParams) {
  const alias = yield* ownedInbox(params);
  if (Option.isNone(alias.inboxExpiresAt)) return yield* notFound(params);
  yield* deleteWithMail(alias).pipe(
    Effect.catchTag("NoSuchAlias", () => Effect.fail(notFound(params))),
    Effect.catchTag("DatabaseError", Effect.die),
  );
});

/** What the inbox handlers use. The group captures them once, at startup. */
type InboxServices =
  | Crypto.Crypto
  | AliasRepo.AliasRepo
  | Inbox.Inbox
  | TempDomains.TempDomains
  | Publisher.Publisher;

export const InboxesLive = HttpApiBuilder.group(Api, "inboxes", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<InboxServices>();
    return handlers
      .handle("list", () => Effect.provide(list(), services))
      .handle("create", ({ payload }) => Effect.provide(create(payload), services))
      .handle("remove", ({ params }) => Effect.provide(remove(params), services))
      .handle("messages", ({ params, query }) => Effect.provide(messages(params, query), services))
      .handle("message", ({ params }) => Effect.provide(message(params), services))
      .handle("removeMessage", ({ params }) => Effect.provide(removeMessage(params), services));
  }),
);
