import {
  PrimaryUsername,
  RecipientNotFound,
  RecipientNotVerified,
  TooManyUsernames,
  UsernameNotFound,
} from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";
import { describeAuthError } from "./passkeys";

/** Why a username action failed, worded for the person at the keyboard. */
class UsernameActionFailed extends Schema.TaggedError<UsernameActionFailed>()(
  "UsernameActionFailed",
  { message: Schema.String },
) {}

const describe = <E>(error: E): string => {
  if (error instanceof TooManyUsernames) {
    return `You can have up to ${error.limit} more usernames. Delete one first.`;
  }
  if (error instanceof UsernameNotFound) return "That username isn't in your account.";
  if (error instanceof PrimaryUsername) {
    return "Your primary username is how you sign in; it can't be deleted.";
  }
  if (error instanceof RecipientNotFound) return "That destination isn't in your account.";
  if (error instanceof RecipientNotVerified) return "Confirm the destination before using it.";
  // The name checks, the human check and the limits are sign-up's.
  return describeAuthError(error);
};

const call = <A, E>(run: (api: Client) => Effect.Effect<A, E>) =>
  callApi((api) =>
    Effect.mapError(run(api), (error) => new UsernameActionFailed({ message: describe(error) })),
  );

/** The primary username first, then the additional ones, oldest first, and how many may be. */
export const usernamesQuery = queryOptions({
  queryKey: ["usernames"],
  queryFn: () => call((api) => api.usernames.list()),
});

export const addUsername = (input: {
  readonly username: string;
  readonly turnstileToken: string;
}) => call((api) => api.usernames.add({ payload: input }));

export const setUsernameOnTheFly = (username: string, isOnTheFlyEnabled: boolean) =>
  call((api) => api.usernames.update({ params: { username }, payload: { isOnTheFlyEnabled } }));

/** None goes back to the account's default destination. */
export const setUsernameDestination = (username: string, recipientId: Option.Option<string>) =>
  call((api) =>
    api.usernames.update({
      params: { username },
      payload: { defaultRecipientId: Option.getOrNull(recipientId) },
    }),
  );

/** Deletes the username and every alias on its subdomains. */
export const deleteUsername = (username: string) =>
  call((api) => api.usernames.remove({ params: { username } }));
