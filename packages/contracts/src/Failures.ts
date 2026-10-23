import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Authentication } from "./Auth.ts";
import { requires } from "./Scopes.ts";

/**
 * Failed deliveries (PLAN.md §20.33): mail to one of the caller's aliases that could not be
 * forwarded for good, listed for 7 days. Only metadata, unless the caller turned on
 * `isFailedMailKept` in their settings: then the message is kept encrypted too, and can be
 * downloaded or sent again to the caller's forwarding address.
 */

/**
 * `rejected`: SES refused the message. `recipient-bounced`: the forwarding address is paused
 * after bouncing. `key-unusable`: its OpenPGP key no longer encrypts. `too-large`: over the
 * size forwarding takes (never kept).
 */
export const FailureReason = Schema.Literals([
  "rejected",
  "recipient-bounced",
  "key-unusable",
  "too-large",
]);
export type FailureReason = typeof FailureReason.Type;

const FailedDelivery = Schema.Struct({
  id: Schema.String,
  /** The alias the mail was sent to. */
  alias: Schema.String,
  /** Who wrote it, as the `From` field (else the envelope sender) named them. */
  sender: Schema.OptionFromOptionalKey(Schema.String),
  reason: FailureReason,
  receivedAt: Schema.DateTimeUtcFromString,
  /** It is gone after this, kept copy included. */
  expiresAt: Schema.DateTimeUtcFromString,
  /** Size of the original message in bytes. */
  size: Schema.Int,
  /** A copy is kept: it can be downloaded and sent again. */
  isKept: Schema.Boolean,
});
export type FailedDelivery = typeof FailedDelivery.Type;

export class FailureNotFound extends Schema.TaggedError<FailureNotFound>()(
  "FailureNotFound",
  { failureId: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * Sending again didn't work: no copy was kept, the alias is deactivated, there is no verified
 * forwarding address or it is paused, its key doesn't encrypt, or SES refused the message. `isRetryable` when trying again later may work.
 */
export class ResendFailed extends Schema.TaggedError<ResendFailed>()(
  "ResendFailed",
  {
    failureId: Schema.String,
    reason: Schema.Literals([
      "not-kept",
      "inactive-alias",
      "no-recipient",
      "recipient-bounced",
      "key-unusable",
      "rejected",
      "unavailable",
    ]),
    isRetryable: Schema.Boolean,
  },
  { httpApiStatus: 422 },
) {}

const FailureId = { failureId: Schema.String };

/** The kept message as the forward would have delivered it (before any OpenPGP encryption). */
const RawMessage = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: "message/rfc822" }),
);

export const FailuresGroup = HttpApiGroup.make("failures")
  .add(
    requires("deliveries:read")(
      HttpApiEndpoint.get("list", "/failed-deliveries", { success: Schema.Array(FailedDelivery) }),
    ),
  )
  .add(
    requires("deliveries:read")(
      HttpApiEndpoint.get("download", "/failed-deliveries/:failureId/message", {
        params: FailureId,
        success: RawMessage,
        error: [FailureNotFound, ResendFailed],
      }),
    ),
  )
  .add(
    requires("deliveries:write")(
      HttpApiEndpoint.post("resend", "/failed-deliveries/:failureId/resend", {
        params: FailureId,
        error: [FailureNotFound, ResendFailed],
      }),
    ),
  )
  .add(
    requires("deliveries:write")(
      HttpApiEndpoint.delete("remove", "/failed-deliveries/:failureId", {
        params: FailureId,
        error: FailureNotFound,
      }),
    ),
  )
  .middleware(Authentication)
  .prefix("/v1");
