import { ComposeRefused, DraftClosed, DraftNotFound, SendFailed } from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why an outbox action failed, worded for the person at the keyboard. */
class OutboxActionFailed extends Schema.TaggedError<OutboxActionFailed>()("OutboxActionFailed", {
  message: Schema.String,
}) {}

const SEND_FAILURES: Record<SendFailed["reason"], string> = {
  "inactive-alias": "The alias is deactivated or gone, so it can't send.",
  "unknown-contact": "That contact was removed.",
  "blocked-contact": "You blocked that contact.",
  "blocked-address": "Your blocklist names that address or its domain.",
  "limit-reached": "You've sent the most mail allowed today. Try again tomorrow.",
  suppressed: "That address bounced for good before, so nothing is sent to it.",
  rejected: "The mail service refused this message.",
  unavailable: "The mail service is unavailable right now. Try again in a moment.",
};

const COMPOSE_REFUSALS: Record<ComposeRefused["reason"], string> = {
  "unknown-alias": "That alias no longer exists.",
  "inactive-alias": "The alias is deactivated, so it can't send. Activate it first.",
  "invalid-address": "That isn't a valid email address.",
  "blocked-contact": "You blocked that contact. Unblock it in the alias's contacts first.",
  "blocked-address": "Your blocklist names that address or its domain. Remove it there first.",
  "recipient-limit": "You've written to the most new people allowed today. Try again tomorrow.",
};

const describe = <E>(error: E): string =>
  error instanceof ComposeRefused
    ? COMPOSE_REFUSALS[error.reason]
    : error instanceof DraftNotFound
      ? "There's no such draft. It may have been deleted after a day."
      : error instanceof DraftClosed
        ? `This draft is already ${error.status}.`
        : error instanceof SendFailed
          ? SEND_FAILURES[error.reason]
          : "Something went wrong. Please try again.";

/** Runs one outbox call, replacing every failure with a readable message. */
export const callOutbox = <A, E>(call: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  callApi((api) =>
    Effect.mapError(call(api), (error) => new OutboxActionFailed({ message: describe(error) })),
  );

export const draftQuery = (draftId: string) =>
  queryOptions({
    queryKey: ["outbox", draftId],
    queryFn: () => callOutbox((api) => api.outbox.get({ params: { draftId } })),
    retry: false,
  });

/**
 * Writes new mail from one of the caller's aliases to any address (PLAN.md §20.33): the address
 * becomes a contact of the alias, and the mail goes out at once, from the alias.
 */
export const composeMail = (payload: {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}) => callOutbox((api) => api.outbox.compose({ payload }));
