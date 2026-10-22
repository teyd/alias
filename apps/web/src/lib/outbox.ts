import { DraftClosed, DraftNotFound, SendFailed } from "@alias/contracts";
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
  "limit-reached": "You've sent the most drafts allowed today. Try again tomorrow.",
  rejected: "The mail service refused this message.",
  unavailable: "The mail service is unavailable right now. Try again in a moment.",
};

const describe = <E>(error: E): string =>
  error instanceof DraftNotFound
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
