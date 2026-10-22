import { SendingEvent, Transport } from "@alias/aws";
import {
  Api,
  ConfirmationRateLimited,
  ConfirmationRejected,
  ConfirmationUndeliverable,
  CurrentUser,
  InvalidPublicKey,
  InvalidRecipientAddress,
  MailUnavailable,
  RecipientAlreadyVerified,
  RecipientExists,
  RecipientNotFound,
  RecipientNotVerified,
  TooManyPendingRecipients,
} from "@alias/contracts";
import { Address, Pgp, SharedDomains } from "@alias/core";
import { RecipientRepo, SentRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import * as ConfirmationMail from "./ConfirmationMail.ts";
import { MailSettings } from "./MailSettings.ts";
import { RelyingParty } from "./RelyingParty.ts";
import { hashToken, newToken } from "./Secrets.ts";

/**
 * Limits on confirmation mail. Each one goes to a mailbox that hasn't agreed to anything yet, so
 * they are small: they protect strangers from being mailed through us, and SES's complaint rate.
 * - At most 3 unconfirmed recipients per user at a time (confirm or delete one to add another).
 * - A resend for the same recipient at most once a minute.
 * - At most 10 confirmation mails (adds and resends together) per user and UTC day.
 * - A confirmation link works for 24 hours, once.
 */
export const MAX_PENDING_RECIPIENTS = 3;
const RESEND_COOLDOWN = Duration.minutes(1);
export const CONFIRMATION_MAILS_PER_DAY = 10;
const CONFIRMATION_LIFETIME = Duration.hours(24);

const view = (recipient: RecipientRepo.Recipient, now: DateTime.Utc) => ({
  id: recipient.id,
  address: recipient.address,
  isVerified: Option.isSome(recipient.verifiedAt),
  isDefault: recipient.isDefault,
  createdAt: recipient.createdAt,
  bouncedAt: recipient.bouncedAt,
  bounceReason: recipient.bounceReason,
  complainedAt: recipient.complainedAt,
  encryption: Option.map(recipient.encryption, (encryption) => ({
    publicKey: encryption.publicKey,
    fingerprint: encryption.fingerprint,
    userIds: encryption.userIds,
    expiresAt: encryption.expiresAt,
    isUsable: !Option.exists(encryption.expiresAt, (at) => DateTime.isLessThanOrEqualTo(at, now)),
    isSubjectHidden: encryption.isSubjectHidden,
  })),
});

const rateLimited = (now: DateTime.Utc, until: DateTime.Utc) =>
  new ConfirmationRateLimited({
    retryAfterSeconds: Math.ceil(Duration.toSeconds(DateTime.distance(now, until))),
  });

/** The caller's recipient; someone else's answers exactly like a missing one. */
const findOwned = Effect.fn("recipients.findOwned")(function* (recipientId: string) {
  const user = yield* CurrentUser;
  const repo = yield* RecipientRepo.RecipientRepo;
  const found = yield* Effect.orDie(repo.find(user.userId, recipientId));
  return yield* Option.match(found, {
    onNone: () => Effect.fail(new RecipientNotFound({ recipientId })),
    onSome: Effect.succeed,
  });
});

/** A fresh token for the mail, and what the table keeps of it. */
const newConfirmation = Effect.fn("recipients.newConfirmation")(function* (now: DateTime.Utc) {
  const crypto = yield* Crypto.Crypto;
  const token = yield* Effect.orDie(newToken(crypto));
  const confirmation: RecipientRepo.Confirmation = {
    tokenHash: yield* Effect.orDie(hashToken(crypto, token)),
    expiresAt: DateTime.addDuration(now, CONFIRMATION_LIFETIME),
    sentAt: now,
  };
  return { token, confirmation };
});

/** Counts one confirmation mail against the caller's daily allowance. */
const reserveMail = Effect.fn("recipients.reserveMail")(function* (now: DateTime.Utc) {
  const user = yield* CurrentUser;
  const repo = yield* RecipientRepo.RecipientRepo;
  yield* repo.reserveMail(user.userId, now, CONFIRMATION_MAILS_PER_DAY).pipe(
    Effect.catchTags({
      MailQuotaExceeded: (error) => Effect.fail(rateLimited(now, error.resetsAt)),
      DatabaseError: Effect.die,
    }),
  );
});

/** Mails the confirmation link. Call {@link reserveMail} first. */
const sendConfirmation = Effect.fn("recipients.sendConfirmation")(function* (
  recipient: { readonly id: string; readonly address: string },
  token: string,
  now: DateTime.Utc,
) {
  const user = yield* CurrentUser;
  const settings = yield* MailSettings;
  const relyingParty = yield* RelyingParty;
  const transport = yield* Transport.Transport;
  const raw = ConfirmationMail.render({
    sender: settings.sender,
    recipient: recipient.address,
    username: user.username,
    link: ConfirmationMail.link({ origin: relyingParty.origin, recipientId: recipient.id, token }),
    validFor: CONFIRMATION_LIFETIME,
    date: now,
  });
  // The owner asked to (re)confirm this address, so an earlier bounce shouldn't keep SES from
  // trying it once more. If it bounces again, the feedback Lambda suppresses it again.
  yield* transport
    .unsuppress(recipient.address)
    .pipe(
      Effect.catchTag("SuppressionError", (error) =>
        Effect.logWarning("suppression list not updated", error.reason),
      ),
    );
  const messageId = yield* transport
    .send(raw, {
      from: settings.sender,
      to: [recipient.address],
      tags: SendingEvent.tags(user.userId, "confirmation"),
    })
    .pipe(
      Effect.catchTags({
        TransportRejected: () =>
          Effect.fail(new ConfirmationUndeliverable({ address: recipient.address })),
        // The code says what went wrong without logging the address.
        TransportRetryable: (error) =>
          Effect.logWarning("confirmation mail not sent", error.code).pipe(
            Effect.andThen(Effect.fail(new MailUnavailable())),
          ),
      }),
    );
  yield* SentRepo.remember({
    messageId,
    userId: user.userId,
    kind: "confirmation",
    recipientId: Option.some(recipient.id),
  });
});

const list = Effect.fn("recipients.list")(function* () {
  const user = yield* CurrentUser;
  const repo = yield* RecipientRepo.RecipientRepo;
  const now = yield* DateTime.now;
  return Arr.map(yield* Effect.orDie(repo.list(user.userId)), (recipient) => view(recipient, now));
});

const add = Effect.fn("recipients.add")(function* (requested: string) {
  const user = yield* CurrentUser;
  const sharedDomains = yield* SharedDomains.SharedDomains;
  const repo = yield* RecipientRepo.RecipientRepo;
  const crypto = yield* Crypto.Crypto;
  const invalid = (reason: InvalidRecipientAddress["reason"]) =>
    new InvalidRecipientAddress({ address: requested, reason });

  const parsed = yield* Address.parse(requested).pipe(Effect.mapError(() => invalid("invalid")));
  // Forwarding to one of our own domains would loop back into the pipeline.
  if (!Address.Destination.$is("Custom")(Address.classify(parsed, sharedDomains))) {
    return yield* invalid("alias-domain");
  }
  const now = yield* DateTime.now;
  const recipient: RecipientRepo.NewRecipient = {
    id: `rcp_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`,
    userId: user.userId,
    address: `${parsed.local}@${parsed.domain}`,
    createdAt: now,
  };
  const { token, confirmation } = yield* newConfirmation(now);
  yield* repo.add(recipient, confirmation, MAX_PENDING_RECIPIENTS).pipe(
    Effect.catchTags({
      RecipientExists: (error) => Effect.fail(new RecipientExists({ address: error.address })),
      TooManyPendingRecipients: (error) =>
        Effect.fail(new TooManyPendingRecipients({ limit: error.limit })),
      DatabaseError: Effect.die,
    }),
  );
  // A recipient whose mail never went out is useless and holds a pending slot, so undo the add.
  yield* reserveMail(now).pipe(
    Effect.andThen(sendConfirmation(recipient, token, now)),
    Effect.tapError(() =>
      repo.delete(user.userId, recipient.id).pipe(
        Effect.catchTag("NoSuchRecipient", () => Effect.void),
        Effect.orDie,
      ),
    ),
  );
  return view(
    {
      ...recipient,
      verifiedAt: Option.none(),
      lastSentAt: now,
      isDefault: false,
      bouncedAt: Option.none(),
      bounceReason: Option.none(),
      complainedAt: Option.none(),
      encryption: Option.none(),
    },
    now,
  );
});

const confirm = Effect.fn("recipients.confirm")(function* (recipientId: string, token: string) {
  const recipient = yield* findOwned(recipientId);
  const repo = yield* RecipientRepo.RecipientRepo;
  const crypto = yield* Crypto.Crypto;
  const tokenHash = yield* Effect.orDie(hashToken(crypto, token));
  const now = yield* DateTime.now;
  yield* repo.confirm(recipient, tokenHash, now).pipe(
    Effect.catchTags({
      ConfirmationMismatch: () => Effect.fail(new ConfirmationRejected({ recipientId })),
      DatabaseError: Effect.die,
    }),
  );
  // Read again: confirming may have made it the default.
  return view(yield* findOwned(recipientId), now);
});

/**
 * Mails a new confirmation link: for a pending recipient, or to resume forwarding to a verified
 * one that was paused because it bounced (PLAN.md §20.28). Opening the link proves the mailbox
 * takes mail again; only then does forwarding resume.
 */
const resend = Effect.fn("recipients.resend")(function* (recipientId: string) {
  const recipient = yield* findOwned(recipientId);
  if (Option.isSome(recipient.verifiedAt) && Option.isNone(recipient.bouncedAt)) {
    return yield* new RecipientAlreadyVerified({ recipientId });
  }
  const now = yield* DateTime.now;
  const allowedAt = DateTime.addDuration(recipient.lastSentAt, RESEND_COOLDOWN);
  if (DateTime.isLessThan(now, allowedAt)) return yield* rateLimited(now, allowedAt);

  // Reserve first, so a used-up allowance leaves the current link working.
  yield* reserveMail(now);
  const repo = yield* RecipientRepo.RecipientRepo;
  const { token, confirmation } = yield* newConfirmation(now);
  yield* repo.renewConfirmation(recipient, confirmation).pipe(
    Effect.catchTags({
      // Another resend (or a confirm) won the race since the read above.
      RecipientChanged: () =>
        Effect.fail(rateLimited(now, DateTime.addDuration(now, RESEND_COOLDOWN))),
      DatabaseError: Effect.die,
    }),
  );
  yield* sendConfirmation(recipient, token, now);
});

const makeDefault = Effect.fn("recipients.makeDefault")(function* (recipientId: string) {
  const recipient = yield* findOwned(recipientId);
  const notVerified = new RecipientNotVerified({ recipientId });
  if (Option.isNone(recipient.verifiedAt)) return yield* notVerified;
  const repo = yield* RecipientRepo.RecipientRepo;
  yield* repo.setDefault(recipient).pipe(
    Effect.catchTags({
      RecipientChanged: () => Effect.fail(notVerified),
      DatabaseError: Effect.die,
    }),
  );
});

/**
 * Stores the recipient's OpenPGP key once it proves it can encrypt now (PLAN.md §20.21), or
 * replaces the one it has. Only the re-armored key is kept, never the text around it.
 */
const setEncryption = Effect.fn("recipients.setEncryption")(function* (
  recipientId: string,
  publicKey: string,
  isSubjectHidden: boolean,
) {
  const recipient = yield* findOwned(recipientId);
  const repo = yield* RecipientRepo.RecipientRepo;
  const now = yield* DateTime.now;
  const key = yield* Pgp.readKey(publicKey, now).pipe(
    Effect.mapError((error) => new InvalidPublicKey({ reason: error.reason })),
  );
  yield* repo
    .setEncryption(recipient, {
      publicKey: key.armored,
      fingerprint: key.fingerprint,
      userIds: key.userIds,
      expiresAt: key.expiresAt,
      isSubjectHidden,
    })
    .pipe(
      Effect.catchTags({
        RecipientChanged: () => Effect.fail(new RecipientNotFound({ recipientId })),
        DatabaseError: Effect.die,
      }),
    );
  return view(yield* findOwned(recipientId), now);
});

const removeEncryption = Effect.fn("recipients.removeEncryption")(function* (recipientId: string) {
  const recipient = yield* findOwned(recipientId);
  const repo = yield* RecipientRepo.RecipientRepo;
  yield* repo.removeEncryption(recipient).pipe(
    Effect.catchTags({
      RecipientChanged: () => Effect.fail(new RecipientNotFound({ recipientId })),
      DatabaseError: Effect.die,
    }),
  );
  return view(yield* findOwned(recipientId), yield* DateTime.now);
});

const remove = Effect.fn("recipients.remove")(function* (recipientId: string) {
  const user = yield* CurrentUser;
  const repo = yield* RecipientRepo.RecipientRepo;
  yield* repo.delete(user.userId, recipientId).pipe(
    Effect.catchTags({
      NoSuchRecipient: () => Effect.fail(new RecipientNotFound({ recipientId })),
      DatabaseError: Effect.die,
    }),
  );
});

/** What the recipient handlers use. The group captures them once, at startup. */
type RecipientServices =
  | Crypto.Crypto
  | RelyingParty
  | MailSettings
  | SharedDomains.SharedDomains
  | Transport.Transport
  | RecipientRepo.RecipientRepo
  | SentRepo.SentRepo;

export const RecipientsLive = HttpApiBuilder.group(Api, "recipients", (handlers) =>
  Effect.map(Effect.context<RecipientServices>(), (services) =>
    handlers
      .handle("list", () => Effect.provide(list(), services))
      .handle("add", ({ payload }) => Effect.provide(add(payload.address), services))
      .handle("confirm", ({ params, payload }) =>
        Effect.provide(confirm(params.recipientId, payload.token), services),
      )
      .handle("resend", ({ params }) => Effect.provide(resend(params.recipientId), services))
      .handle("makeDefault", ({ params }) =>
        Effect.provide(makeDefault(params.recipientId), services),
      )
      .handle("setEncryption", ({ params, payload }) =>
        Effect.provide(
          setEncryption(params.recipientId, payload.publicKey, payload.isSubjectHidden),
          services,
        ),
      )
      .handle("removeEncryption", ({ params }) =>
        Effect.provide(removeEncryption(params.recipientId), services),
      )
      .handle("remove", ({ params }) => Effect.provide(remove(params.recipientId), services)),
  ),
);
