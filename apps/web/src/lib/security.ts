import { SessionNotFound } from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why a sessions or passkeys call failed, worded for the person at the keyboard. */
class SecurityActionFailed extends Schema.TaggedError<SecurityActionFailed>()(
  "SecurityActionFailed",
  { message: Schema.String },
) {}

const describe = <E>(error: E): string =>
  error instanceof SessionNotFound
    ? "That session has already ended."
    : "Something went wrong. Please try again.";

/** Runs one sessions or passkeys call, replacing every failure with a readable message. */
export const callSecurity = <A, E>(call: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  callApi((api) =>
    Effect.mapError(call(api), (error) => new SecurityActionFailed({ message: describe(error) })),
  );

export const sessionsQuery = queryOptions({
  queryKey: ["security", "sessions"],
  queryFn: () => callSecurity((api) => api.security.sessions()),
});

export const passkeysQuery = queryOptions({
  queryKey: ["security", "passkeys"],
  queryFn: () => callSecurity((api) => api.security.passkeys()),
});
