import { SendingEvent, Transport } from "@alias/aws";
import {
  Api,
  CurrentUser,
  type FailedDelivery,
  FailureNotFound,
  FailureReason,
  ResendFailed,
} from "@alias/contracts";
import { Pgp, type SharedDomains } from "@alias/core";
import {
  AliasRepo,
  FailureRepo,
  Forwarding,
  RecipientRepo,
  SentRepo,
  UsernameRepo,
} from "@alias/db";
import { Inbox } from "@alias/inbox";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Failed deliveries (PLAN.md §20.33): what the inbound Lambda could not forward for good, listed
 * for a week. With a kept copy the owner can download it, or send it again to their forwarding
 * address once whatever stopped it is fixed (a paused address resumed, a new OpenPGP key).
 */

const view = (failure: FailureRepo.Failure): Option.Option<FailedDelivery> =>
  Option.map(Schema.decodeUnknownOption(FailureReason)(failure.reason), (reason) => ({
    id: failure.id,
    alias: failure.alias,
    sender: failure.sender,
    reason,
    receivedAt: failure.receivedAt,
    expiresAt: failure.expiresAt,
    size: failure.size,
    isKept: Option.isSome(failure.kept),
  }));

const list = Effect.fn("failures.list")(function* () {
  const user = yield* CurrentUser;
  const failures = yield* Effect.orDie((yield* FailureRepo.FailureRepo).list(user.userId));
  return Arr.getSomes(Arr.map(failures, view));
});

const resendFailed = (failureId: string, reason: ResendFailed["reason"], isRetryable = false) =>
  new ResendFailed({ failureId, reason, isRetryable });

/** The caller's failure with its kept copy. */
const kept = Effect.fn("failures.kept")(function* (failureId: string) {
  const user = yield* CurrentUser;
  const found = yield* Effect.orDie((yield* FailureRepo.FailureRepo).find(user.userId, failureId));
  if (Option.isNone(found)) return yield* new FailureNotFound({ failureId });
  if (Option.isNone(found.value.kept)) return yield* resendFailed(failureId, "not-kept");
  return { failure: found.value, kept: found.value.kept.value };
});

/** The kept copy, opened: what the forward would have delivered before any encryption. */
const open = Effect.fn("failures.open")(function* (failureId: string) {
  const { failure, kept: copy } = yield* kept(failureId);
  const raw = yield* (yield* Inbox.Inbox)
    .retrieve(failure.aliasId, failure.id, copy)
    .pipe(Effect.mapError(() => resendFailed(failureId, "unavailable", true)));
  return { failure, copy, raw };
});

const download = Effect.fn("failures.download")(function* (failureId: string) {
  return (yield* open(failureId)).raw;
});

/** Deletes the failure and its kept copy (the object best effort: without its key it is noise). */
const discard = Effect.fn("failures.discard")(function* (userId: string, failureId: string) {
  const deleted = yield* Effect.orDie((yield* FailureRepo.FailureRepo).delete(userId, failureId));
  if (Option.isNone(deleted)) return false;
  if (Option.isSome(deleted.value.kept)) {
    yield* (yield* Inbox.Inbox)
      .discard(deleted.value.kept.value.objectKey)
      .pipe(
        Effect.catchTag("InboxUnavailable", (error) =>
          Effect.logWarning("kept copy not deleted", error.reason),
        ),
      );
  }
  return true;
});

const remove = Effect.fn("failures.remove")(function* (failureId: string) {
  const user = yield* CurrentUser;
  if (!(yield* discard(user.userId, failureId))) return yield* new FailureNotFound({ failureId });
});

/**
 * Sends the kept copy again, the way the pipeline forwards (PLAN.md §20.6): from the reverse
 * alias it was rewritten with, to the mailboxes the alias forwards to now, each encrypted to its
 * key if it has one. Delivered, the failure is gone.
 */
const resend = Effect.fn("failures.resend")(function* (failureId: string) {
  const user = yield* CurrentUser;
  const { failure, copy, raw } = yield* open(failureId);
  const at = failure.alias.lastIndexOf("@");
  const aliases = yield* AliasRepo.AliasRepo;
  const alias = yield* Effect.orDie(
    aliases.findByAddress(failure.alias.slice(at + 1), failure.alias.slice(0, at)),
  );
  const current = Option.filter(alias, (found) => found.id === failure.aliasId && found.isActive);
  if (Option.isNone(current)) return yield* resendFailed(failureId, "inactive-alias");
  // The mailboxes a forward of this alias goes to now (PLAN.md §20.31, §20.34), unpaused ones.
  const { targets } = yield* Effect.orDie(Forwarding.targetsOf(current.value));
  if (Option.isNone(targets)) return yield* resendFailed(failureId, "no-recipient");
  const live = Arr.filter(targets.value, (target) => Option.isNone(target.bouncedAt));
  if (!Arr.isReadonlyArrayNonEmpty(live)) {
    return yield* resendFailed(failureId, "recipient-bounced");
  }
  const now = yield* DateTime.now;
  const transport = yield* Transport.Transport;
  // One copy per mailbox, each encrypted to its own key if it has one. A copy that fails stops
  // the resend; those sent before it stay sent, and the failure stays for another try.
  yield* Effect.forEach(
    live,
    Effect.fnUntraced(function* (target) {
      const outgoing = yield* Option.match(target.encryption, {
        onNone: () => Effect.succeed(raw),
        onSome: (key) =>
          Pgp.encrypt(raw, { key: key.publicKey, isSubjectHidden: key.isSubjectHidden, now }).pipe(
            Effect.catchTag("InvalidKey", () =>
              Effect.fail(resendFailed(failureId, "key-unusable")),
            ),
            // The pipeline parsed this message before keeping it.
            Effect.catchTag("MalformedMessage", Effect.die),
          ),
      });
      const messageId = yield* transport
        .send(outgoing, {
          from: copy.envelopeFrom,
          to: [target.address],
          tags: SendingEvent.tags(user.userId, "forward"),
        })
        .pipe(
          Effect.catchTags({
            TransportRejected: () => Effect.fail(resendFailed(failureId, "rejected")),
            TransportRetryable: () => Effect.fail(resendFailed(failureId, "unavailable", true)),
          }),
        );
      // Its bounces are about that recipient, like any forward's (PLAN.md §20.28).
      yield* SentRepo.remember({
        messageId,
        userId: user.userId,
        kind: "forward",
        recipientId: Option.some(target.id),
      });
    }),
    { concurrency: 1, discard: true },
  );
  yield* aliases
    .increment(failure.alias.slice(at + 1), failure.alias.slice(0, at), "forwarded")
    .pipe(Effect.ignore);
  yield* discard(user.userId, failureId);
  yield* Effect.logInfo("failed delivery sent again");
});

/** What the handlers use. The group captures them once, at startup. */
type FailureServices =
  | AliasRepo.AliasRepo
  | FailureRepo.FailureRepo
  | RecipientRepo.RecipientRepo
  | SentRepo.SentRepo
  | UsernameRepo.UsernameRepo
  | SharedDomains.SharedDomains
  | Inbox.Inbox
  | Transport.Transport;

export const FailuresLive = HttpApiBuilder.group(Api, "failures", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<FailureServices>();
    return handlers
      .handle("list", () => Effect.provide(list(), services))
      .handle("download", ({ params }) => Effect.provide(download(params.failureId), services))
      .handle("resend", ({ params }) => Effect.provide(resend(params.failureId), services))
      .handle("remove", ({ params }) => Effect.provide(remove(params.failureId), services));
  }),
);
