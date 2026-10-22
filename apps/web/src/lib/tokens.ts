import { TokenNotFound } from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why a token action failed, worded for the person at the keyboard. */
class TokenActionFailed extends Schema.TaggedError<TokenActionFailed>()("TokenActionFailed", {
  message: Schema.String,
}) {}

const describe = <E>(error: E): string =>
  error instanceof TokenNotFound
    ? "That token is already gone."
    : "Something went wrong. Please try again.";

/** Runs one tokens call, replacing every failure with a readable message. */
export const callTokens = <A, E>(call: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  callApi((api) =>
    Effect.mapError(call(api), (error) => new TokenActionFailed({ message: describe(error) })),
  );

export const tokensQuery = queryOptions({
  queryKey: ["tokens"],
  queryFn: () => callTokens((api) => api.tokens.list()),
});

/** A token needs a scope; said here, before asking the API. */
export const noScopePicked = (): Promise<never> =>
  Promise.reject(new TokenActionFailed({ message: "Pick at least one scope." }));
