import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Authentication } from "./Auth.ts";
import { requires } from "./Scopes.ts";

/**
 * Inbox mode and temporary inboxes (PLAN.md §3.5, §20.22). An inbox is an alias that stores the
 * mail it receives (mode `inbox`, or `both` to also forward it), encrypted, for `retentionDays`.
 * A temporary inbox is one on a temp-mail domain that stops taking mail at `expiresAt`; its
 * address is never handed out again.
 */

/** How long stored messages are kept. Each value is one S3 lifecycle class. */
export const RetentionDays = Schema.Literals([1, 7, 30]);
export type RetentionDays = typeof RetentionDays.Type;

/** Kept for inbox aliases whose owner chose nothing; temporary inboxes keep mail one day. */
export const DEFAULT_RETENTION_DAYS: RetentionDays = 7;

/** Longest wait a long poll may ask for, inside the API Lambda's 30 s and CloudFront's 30 s. */
export const MAX_WAIT_SECONDS = 25;

const InboxMode = Schema.Literals(["inbox", "both"]);

export const InboxView = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  mode: InboxMode,
  isTemporary: Schema.Boolean,
  /** Temporary inboxes only: from then on, mail to the address is dropped. */
  expiresAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
  retentionDays: RetentionDays,
});
export type InboxView = typeof InboxView.Type;

/** What a stored message is, without its body: enough for a list and for `--wait --otp`. */
export const MessageSummary = Schema.Struct({
  id: Schema.String,
  receivedAt: Schema.DateTimeUtcFromString,
  /** Deleted for good then (retention). */
  expiresAt: Schema.DateTimeUtcFromString,
  /** Size of the original message in bytes. */
  size: Schema.Number,
  from: Schema.OptionFromOptionalKey(Schema.String),
  subject: Schema.OptionFromOptionalKey(Schema.String),
  /** The start of the text, for a list. */
  preview: Schema.String,
  /** A one-time code found in the message (`Verification` in `@alias/core`). */
  code: Schema.OptionFromOptionalKey(Schema.String),
  /** A verification or sign-in link found in the message. Never visited by us. */
  link: Schema.OptionFromOptionalKey(Schema.String),
  attachmentCount: Schema.Number,
});
export type MessageSummary = typeof MessageSummary.Type;

const Attachment = Schema.Struct({
  filename: Schema.OptionFromOptionalKey(Schema.String),
  contentType: Schema.String,
  size: Schema.Number,
});

/** One message, decrypted. Attachments are listed, not served. */
export const MessageView = Schema.Struct({
  ...MessageSummary.fields,
  to: Schema.OptionFromOptionalKey(Schema.String),
  date: Schema.OptionFromOptionalKey(Schema.String),
  text: Schema.OptionFromOptionalKey(Schema.String),
  /**
   * Sanitized HTML: no scripts, forms, frames, event handlers or styles that load anything, and
   * no remote images (counted in `blockedImageCount`). Render it in a sandboxed frame anyway.
   */
  html: Schema.OptionFromOptionalKey(Schema.String),
  attachments: Schema.Array(Attachment),
  blockedImageCount: Schema.Number,
});
export type MessageView = typeof MessageView.Type;

/** A temporary inbox; both fields are optional. */
const NewTemporaryInbox = Schema.Struct({
  /** One of the temp-mail domains; the first one when absent. */
  domain: Schema.optionalKey(Schema.String),
  /** How long it takes mail, 1 hour to 7 days; one day when absent. */
  lifetimeHours: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 168 })),
  ),
});

/** No inbox of the caller's at this address. Someone else's looks exactly the same. */
export class InboxNotFound extends Schema.TaggedError<InboxNotFound>()(
  "InboxNotFound",
  { address: Schema.String },
  { httpApiStatus: 404 },
) {}

export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()(
  "MessageNotFound",
  { messageId: Schema.String },
  { httpApiStatus: 404 },
) {}

export class InvalidTemporaryInbox extends Schema.TaggedError<InvalidTemporaryInbox>()(
  "InvalidTemporaryInbox",
  { reason: Schema.Literals(["temp-mail-disabled", "unknown-domain"]) },
  { httpApiStatus: 400 },
) {}

/** The caller created as many temporary inboxes today as one may. */
export class TemporaryInboxLimit extends Schema.TaggedError<TemporaryInboxLimit>()(
  "TemporaryInboxLimit",
  {},
  { httpApiStatus: 429 },
) {}

const InboxAddress = { domain: Schema.String, local: Schema.String };

/**
 * Signed in, or a token with `inboxes:read`/`inboxes:write`, which reach the caller's inboxes and
 * nothing else (a "temp-only" token for scripts, CI and assistants).
 */
export const InboxesGroup = HttpApiGroup.make("inboxes")
  .add(
    requires("inboxes:read")(
      HttpApiEndpoint.get("list", "/inboxes", { success: Schema.Array(InboxView) }),
    ),
  )
  .add(
    requires("inboxes:write")(
      HttpApiEndpoint.post("create", "/inboxes", {
        payload: NewTemporaryInbox,
        success: InboxView.pipe(HttpApiSchema.status(201)),
        error: [InvalidTemporaryInbox, TemporaryInboxLimit],
      }),
    ),
  )
  .add(
    requires("inboxes:write")(
      HttpApiEndpoint.delete("remove", "/inboxes/:domain/:local", {
        params: InboxAddress,
        error: InboxNotFound,
      }),
    ),
  )
  .add(
    requires("inboxes:read")(
      HttpApiEndpoint.get("messages", "/inboxes/:domain/:local/messages", {
        params: InboxAddress,
        query: {
          /** Only messages after this id: what a poller has already seen. */
          after: Schema.optionalKey(Schema.String),
          /**
           * Long poll: with nothing to return, wait up to this many seconds for a message to
           * arrive before answering with an empty list.
           */
          wait: Schema.optionalKey(
            Schema.NumberFromString.check(
              Schema.isBetween({ minimum: 0, maximum: MAX_WAIT_SECONDS }),
            ),
          ),
        },
        success: Schema.Array(MessageSummary),
        error: InboxNotFound,
      }),
    ),
  )
  .add(
    requires("inboxes:read")(
      HttpApiEndpoint.get("message", "/inboxes/:domain/:local/messages/:messageId", {
        params: { ...InboxAddress, messageId: Schema.String },
        success: MessageView,
        error: [InboxNotFound, MessageNotFound],
      }),
    ),
  )
  .add(
    requires("inboxes:write")(
      HttpApiEndpoint.delete("removeMessage", "/inboxes/:domain/:local/messages/:messageId", {
        params: { ...InboxAddress, messageId: Schema.String },
        error: [InboxNotFound, MessageNotFound],
      }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");
