import { InvalidWebhookUrl, TooManyWebhooks, WebhookNotFound } from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why a webhook action failed, worded for the person at the keyboard. */
class WebhookActionFailed extends Schema.TaggedError<WebhookActionFailed>()("WebhookActionFailed", {
  message: Schema.String,
}) {}

const reasons: Record<InvalidWebhookUrl["reason"], string> = {
  "invalid-url": "That isn't a URL.",
  "not-https": "Webhook URLs must start with https://.",
  "has-credentials": "Leave the user name and password out of the URL.",
  "not-public-host": "That host isn't reachable from the internet.",
  "too-long": "That URL is too long.",
};

const describe = <E>(error: E): string => {
  if (error instanceof InvalidWebhookUrl) return reasons[error.reason];
  if (error instanceof TooManyWebhooks) return `You can have up to ${error.limit} webhooks.`;
  if (error instanceof WebhookNotFound) return "That webhook is already gone.";
  return "Something went wrong. Please try again.";
};

/** Runs one webhooks call, replacing every failure with a readable message. */
export const callWebhooks = <A, E>(call: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  callApi((api) =>
    Effect.mapError(call(api), (error) => new WebhookActionFailed({ message: describe(error) })),
  );

/** An event type is needed; said here, before asking the API. */
export const noEventPicked = (): Promise<never> =>
  Promise.reject(new WebhookActionFailed({ message: "Pick at least one event." }));

export const webhooksQuery = queryOptions({
  queryKey: ["webhooks"],
  queryFn: () => callWebhooks((api) => api.webhooks.list()),
});
