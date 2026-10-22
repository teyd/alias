import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Authentication } from "./Auth.ts";

/**
 * Mail an MCP client drafted (PLAN.md §20.24, `send_mail`), waiting for its owner. Nothing an MCP
 * client does sends mail: the owner opens the draft in the web app and sends or discards it.
 * Session-only (no endpoint names a scope), so no token, `mail:send` included, can send a draft.
 */

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
      "limit-reached",
      "rejected",
      "unavailable",
    ]),
    isRetryable: Schema.Boolean,
  },
  { httpApiStatus: 422 },
) {}

const DraftId = { draftId: Schema.String };

export const OutboxGroup = HttpApiGroup.make("outbox")
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
