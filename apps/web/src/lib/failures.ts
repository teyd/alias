import { FailureNotFound, type FailedDelivery, ResendFailed } from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why a failed-delivery action failed, worded for the person at the keyboard. */
class FailureActionFailed extends Schema.TaggedError<FailureActionFailed>()("FailureActionFailed", {
  message: Schema.String,
}) {}

const RESEND_FAILURES: Record<ResendFailed["reason"], string> = {
  "not-kept": "No copy of this message was kept.",
  "inactive-alias": "The alias is deactivated or gone. Activate it first.",
  "no-recipient": "You have no verified destination to send it to.",
  "recipient-bounced": "Your destination is paused. Resume it on the Destinations screen first.",
  "key-unusable": "Your destination's OpenPGP key no longer encrypts. Upload a new one first.",
  rejected: "The mail service refused this message.",
  unavailable: "The mail service is unavailable right now. Try again in a moment.",
};

const describe = <E>(error: E): string =>
  error instanceof FailureNotFound
    ? "That failed delivery is gone: deleted, sent again, or past its 7 days."
    : error instanceof ResendFailed
      ? RESEND_FAILURES[error.reason]
      : "Something went wrong. Please try again.";

const call = <A, E>(run: (api: Client) => Effect.Effect<A, E>) =>
  callApi((api) =>
    Effect.mapError(run(api), (error) => new FailureActionFailed({ message: describe(error) })),
  );

/** Why forwarding failed, in the words of the Failed deliveries screen. */
export const REASONS: Record<FailedDelivery["reason"], string> = {
  rejected: "Refused by the mail service",
  "recipient-bounced": "Destination paused after bouncing",
  "key-unusable": "OpenPGP key no longer encrypts",
  "too-large": "Too large to forward",
};

export const failuresQuery = queryOptions({
  queryKey: ["failed-deliveries"],
  queryFn: () => call((api) => api.failures.list()),
});

/** The kept copy, as the forward would have delivered it (message/rfc822 bytes). */
export const downloadFailure = (failureId: string) =>
  call((api) => api.failures.download({ params: { failureId } }));

/** Sends the kept copy again to the default destination; delivered, the entry is gone. */
export const resendFailure = (failureId: string) =>
  call((api) => api.failures.resend({ params: { failureId } }));

export const deleteFailure = (failureId: string) =>
  call((api) => api.failures.remove({ params: { failureId } }));
