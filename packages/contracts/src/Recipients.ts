import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Authentication } from "./Auth.ts";

/** A forwarding address: a real mailbox alias mail can be forwarded to once it is verified. */
const Recipient = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  isVerified: Schema.Boolean,
  /** The chosen default, or else the oldest verified recipient. Never a pending one. */
  isDefault: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  /**
   * When SES last reported a permanent bounce. Mail isn't forwarded to it any more; resending
   * the confirmation (pending) or deleting and adding it again (verified) tries it once more.
   */
  bouncedAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
  /** When the mailbox last reported forwarded mail as spam. */
  complainedAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
});
export type Recipient = typeof Recipient.Type;

export class InvalidRecipientAddress extends Schema.TaggedError<InvalidRecipientAddress>()(
  "InvalidRecipientAddress",
  {
    address: Schema.String,
    /** `alias-domain`: forwarding to one of our own domains would loop. */
    reason: Schema.Literals(["invalid", "alias-domain"]),
  },
  { httpApiStatus: 400 },
) {}

export class RecipientExists extends Schema.TaggedError<RecipientExists>()(
  "RecipientExists",
  { address: Schema.String },
  { httpApiStatus: 409 },
) {}

/** Confirm or delete a pending recipient before adding another. */
export class TooManyPendingRecipients extends Schema.TaggedError<TooManyPendingRecipients>()(
  "TooManyPendingRecipients",
  { limit: Schema.Number },
  { httpApiStatus: 409 },
) {}

/** Unknown, or someone else's: both look the same. */
export class RecipientNotFound extends Schema.TaggedError<RecipientNotFound>()(
  "RecipientNotFound",
  { recipientId: Schema.String },
  { httpApiStatus: 404 },
) {}

export class RecipientAlreadyVerified extends Schema.TaggedError<RecipientAlreadyVerified>()(
  "RecipientAlreadyVerified",
  { recipientId: Schema.String },
  { httpApiStatus: 409 },
) {}

export class RecipientNotVerified extends Schema.TaggedError<RecipientNotVerified>()(
  "RecipientNotVerified",
  { recipientId: Schema.String },
  { httpApiStatus: 409 },
) {}

/** The confirmation token is wrong, expired or already used. Resend to get a new one. */
export class ConfirmationRejected extends Schema.TaggedError<ConfirmationRejected>()(
  "ConfirmationRejected",
  { recipientId: Schema.String },
  { httpApiStatus: 400 },
) {}

/** Too many confirmation mails: wait for the resend cooldown or the daily allowance. */
export class ConfirmationRateLimited extends Schema.TaggedError<ConfirmationRateLimited>()(
  "ConfirmationRateLimited",
  { retryAfterSeconds: Schema.Number },
  { httpApiStatus: 429 },
) {}

/** SES refused the confirmation mail for this address (for example, it is suppressed). */
export class ConfirmationUndeliverable extends Schema.TaggedError<ConfirmationUndeliverable>()(
  "ConfirmationUndeliverable",
  { address: Schema.String },
  { httpApiStatus: 422 },
) {}

/** The confirmation mail couldn't be sent right now; try again later. */
export class MailUnavailable extends Schema.TaggedError<MailUnavailable>()(
  "MailUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

const recipientId = { recipientId: Schema.String };

/**
 * Forwarding addresses, signed-in only. Adding one mails a confirmation link to it; the owner
 * opens the link while signed in, and the web app posts its token to `confirm`.
 */
export const RecipientsGroup = HttpApiGroup.make("recipients")
  .add(HttpApiEndpoint.get("list", "/recipients", { success: Schema.Array(Recipient) }))
  .add(
    HttpApiEndpoint.post("add", "/recipients", {
      payload: Schema.Struct({ address: Schema.String }),
      success: Recipient.pipe(HttpApiSchema.status(201)),
      error: [
        InvalidRecipientAddress,
        RecipientExists,
        TooManyPendingRecipients,
        ConfirmationRateLimited,
        ConfirmationUndeliverable,
        MailUnavailable,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("confirm", "/recipients/:recipientId/confirm", {
      params: recipientId,
      payload: Schema.Struct({ token: Schema.String }),
      success: Recipient,
      error: [RecipientNotFound, ConfirmationRejected],
    }),
  )
  .add(
    HttpApiEndpoint.post("resend", "/recipients/:recipientId/resend", {
      params: recipientId,
      error: [
        RecipientNotFound,
        RecipientAlreadyVerified,
        ConfirmationRateLimited,
        ConfirmationUndeliverable,
        MailUnavailable,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.post("makeDefault", "/recipients/:recipientId/default", {
      params: recipientId,
      error: [RecipientNotFound, RecipientNotVerified],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/recipients/:recipientId", {
      params: recipientId,
      error: RecipientNotFound,
    }),
  )
  .middleware(Authentication)
  .prefix("/v1");
