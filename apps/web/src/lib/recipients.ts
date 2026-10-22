import {
  ConfirmationRateLimited,
  ConfirmationRejected,
  ConfirmationUndeliverable,
  InvalidRecipientAddress,
  MailUnavailable,
  RecipientAlreadyVerified,
  RecipientExists,
  RecipientNotFound,
  RecipientNotVerified,
  TooManyPendingRecipients,
} from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why a forwarding-address action failed, worded for the person at the keyboard. */
class RecipientActionFailed extends Schema.TaggedError<RecipientActionFailed>()(
  "RecipientActionFailed",
  { message: Schema.String },
) {}

const waitFor = (seconds: number) =>
  seconds < 120 ? `${seconds} seconds` : `${Math.ceil(seconds / 3600)} hours`;

const describe = <E>(error: E): string => {
  if (error instanceof InvalidRecipientAddress) {
    return error.reason === "alias-domain"
      ? "That's an alias address. Forward to a mailbox you read elsewhere."
      : "That doesn't look like an email address.";
  }
  if (error instanceof RecipientExists) return "You've already added that address.";
  if (error instanceof TooManyPendingRecipients) {
    return `Confirm or remove one of your ${error.limit} unconfirmed addresses first.`;
  }
  if (error instanceof ConfirmationRateLimited) {
    return `Too many confirmation mails. Try again in ${waitFor(error.retryAfterSeconds)}.`;
  }
  if (error instanceof ConfirmationUndeliverable) {
    return "We can't deliver mail to that address.";
  }
  if (error instanceof MailUnavailable) return "Mail can't be sent right now. Try again later.";
  if (error instanceof ConfirmationRejected) {
    return "This confirmation link has expired or was already used. Send a new one.";
  }
  if (error instanceof RecipientNotFound) return "That address isn't in your account.";
  if (error instanceof RecipientAlreadyVerified) return "That address is already confirmed.";
  if (error instanceof RecipientNotVerified) return "Confirm the address before using it.";
  return "Something went wrong. Please try again.";
};

/** Runs one recipients call, replacing every failure with a readable message. */
export const callRecipients = <A, E>(call: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  callApi((api) =>
    Effect.mapError(call(api), (error) => new RecipientActionFailed({ message: describe(error) })),
  );

export const recipientsQuery = queryOptions({
  queryKey: ["recipients"],
  queryFn: () => callRecipients((api) => api.recipients.list()),
});
