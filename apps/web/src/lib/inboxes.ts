import {
  InboxNotFound,
  InvalidTemporaryInbox,
  MessageNotFound,
  TemporaryInboxLimit,
} from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { aliasParams } from "./aliases";
import { type Client, callApi } from "./api";

/** Why an inbox action failed, worded for the person at the keyboard. */
class InboxFailed extends Schema.TaggedError<InboxFailed>()("InboxFailed", {
  message: Schema.String,
}) {}

const describe = <E>(error: E): string => {
  if (error instanceof InvalidTemporaryInbox) {
    return error.reason === "temp-mail-disabled"
      ? "Temporary inboxes aren't available on this server."
      : "That domain doesn't take temporary inboxes.";
  }
  if (error instanceof TemporaryInboxLimit) {
    return "You've created as many temporary inboxes as you can today. Try again tomorrow.";
  }
  if (error instanceof InboxNotFound) return "That inbox no longer exists.";
  if (error instanceof MessageNotFound) return "That message is gone: deleted or expired.";
  return "Something went wrong. Please try again.";
};

const call = <A, E>(run: (api: Client) => Effect.Effect<A, E>) =>
  callApi((api) =>
    Effect.mapError(run(api), (error) => new InboxFailed({ message: describe(error) })),
  );

/** Inbox-mode aliases and live temporary inboxes. */
export const inboxesQuery = queryOptions({
  queryKey: ["inboxes"],
  queryFn: () => call((api) => api.inboxes.list()),
});

/**
 * The inbox's messages, newest first. Refreshed every few seconds while the screen is open, so a
 * code shows up without reloading (the CLI long-polls instead).
 */
export const messagesQuery = (address: string) =>
  queryOptions({
    queryKey: ["inboxes", address, "messages"],
    queryFn: () => call((api) => api.inboxes.messages({ params: aliasParams(address), query: {} })),
    refetchInterval: 5_000,
  });

/** One message, decrypted by the API, its HTML sanitized there. */
export const messageQuery = (address: string, messageId: string) =>
  queryOptions({
    queryKey: ["inboxes", address, "messages", messageId],
    queryFn: () =>
      call((api) => api.inboxes.message({ params: { ...aliasParams(address), messageId } })),
    staleTime: Infinity,
  });

/** A random address on the default temp-mail domain, taking mail for a day. */
export const createTemporaryInbox = () => call((api) => api.inboxes.create({ payload: {} }));

/** Deletes a temporary inbox and its mail; the address is never handed out again. */
export const deleteTemporaryInbox = (address: string) =>
  call((api) => api.inboxes.remove({ params: aliasParams(address) }));

export const deleteMessage = (address: string, messageId: string) =>
  call((api) => api.inboxes.removeMessage({ params: { ...aliasParams(address), messageId } }));
