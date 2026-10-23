import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Authentication } from "./Auth.ts";

/**
 * Mail an MCP client drafted (PLAN.md §20.24, `send_mail`), waiting for its owner. Nothing an MCP
 * client does sends mail: the owner opens the draft in the web app and sends or discards it.
 * Session-only (no endpoint names a scope), so no token, `mail:send` included, can send a draft.
 *
 * The owner also writes new mail here (PLAN.md §20.33): composing from one of their aliases to
 * any address makes the address a contact of the alias and sends at once, through the same path
 * a draft takes. Session-only too: a token can't mail strangers.
 */

/** One header line once sanitized; the outbound message encodes it. */
export const MailSubject = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export type MailSubject = typeof MailSubject.Type;

/** Plain text only: no HTML, no attachments. */
export const MailText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000));
export type MailText = typeof MailText.Type;

/** `pending` until the owner decides; a pending draft lapses after an hour. */
const DraftStatus = Schema.Literals(["pending", "sent", "discarded", "expired"]);
type DraftStatus = typeof DraftStatus.Type;

const Draft = Schema.Struct({
  id: Schema.String,
  /** The alias it goes out from. */
  from: Schema.String,
  /** The contact's address, where it goes. */
  to: Schema.String,
  contactName: Schema.OptionFromOptionalKey(Schema.String),
  subject: Schema.String,
  text: Schema.String,
  /** The connected app that drafted it. */
  clientName: Schema.String,
  status: DraftStatus,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type Draft = typeof Draft.Type;

export class DraftNotFound extends Schema.TaggedError<DraftNotFound>()(
  "DraftNotFound",
  { draftId: Schema.String },
  { httpApiStatus: 404 },
) {}

/** Already sent, discarded or lapsed. */
export class DraftClosed extends Schema.TaggedError<DraftClosed>()(
  "DraftClosed",
  { draftId: Schema.String, status: DraftStatus },
  { httpApiStatus: 409 },
) {}

/**
 * The draft can't go out: the alias was deactivated or deleted, the contact blocked or removed,
 * the day's send limit is used up, or SES refused the message. `isRetryable` when trying again
 * later may work (SES unavailable).
 */
export class SendFailed extends Schema.TaggedError<SendFailed>()(
  "SendFailed",
  {
    draftId: Schema.String,
    reason: Schema.Literals([
      "inactive-alias",
      "unknown-contact",
      "blocked-contact",
      // The owner's blocklist names the address or its domain (PLAN.md §20.32).
      "blocked-address",
      "limit-reached",
      // The address is on the SES suppression list: it bounced for good before.
      "suppressed",
      "rejected",
      "unavailable",
    ]),
    isRetryable: Schema.Boolean,
  },
  { httpApiStatus: 422 },
) {}

/** What the owner writes from the web app. */
const NewMail = Schema.Struct({
  /** One of the caller's aliases, by address. */
  from: Schema.String,
  /** Any address; it becomes a contact of the alias unless it is one. */
  to: Schema.String,
  subject: MailSubject,
  text: MailText,
});

/**
 * The mail can't be written: no such alias of the caller's, or it is deactivated; the recipient
 * is no usable address, a contact the owner blocked or an address their blocklist names; or the
 * day's allowance of new recipients is used up.
 */
export class ComposeRefused extends Schema.TaggedError<ComposeRefused>()(
  "ComposeRefused",
  {
    reason: Schema.Literals([
      "unknown-alias",
      "inactive-alias",
      "invalid-address",
      // The owner's blocklist names the address or its domain (PLAN.md §20.32).
      "blocked-address",
      "blocked-contact",
      "recipient-limit",
    ]),
  },
  { httpApiStatus: 422 },
) {}

const DraftId = { draftId: Schema.String };

export const OutboxGroup = HttpApiGroup.make("outbox")
  .add(
    HttpApiEndpoint.post("compose", "/outbox", {
      payload: NewMail,
      success: Draft,
      // A send that failed leaves the draft pending, to send again from `/outbox/:draftId`.
      error: [ComposeRefused, SendFailed],
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/outbox/:draftId", {
      params: DraftId,
      success: Draft,
      error: DraftNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("send", "/outbox/:draftId/send", {
      params: DraftId,
      success: Draft,
      error: [DraftNotFound, DraftClosed, SendFailed],
    }),
  )
  .add(
    HttpApiEndpoint.post("discard", "/outbox/:draftId/discard", {
      params: DraftId,
      success: Draft,
      error: [DraftNotFound, DraftClosed],
    }),
  )
  .middleware(Authentication)
  .prefix("/v1");
