import {
  type AuthorizationRequest,
  ConnectedAppNotFound,
  InvalidAuthorizationRequest,
} from "@alias/contracts";
import { queryOptions } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Client, callApi } from "./api";

/** Why an OAuth action failed, worded for the person at the keyboard. */
class OAuthActionFailed extends Schema.TaggedError<OAuthActionFailed>()("OAuthActionFailed", {
  message: Schema.String,
  /** The client's redirect URI with the error, when the client may hear about it. */
  redirectTo: Schema.optionalKey(Schema.String),
}) {}

const REASONS: Record<InvalidAuthorizationRequest["reason"], string> = {
  "unknown-client": "This app isn't known here. Start the connection again from the app.",
  "client-metadata-unavailable":
    "The app's description couldn't be loaded or isn't valid, so it can't be trusted.",
  "invalid-redirect-uri": "The app asked to send you somewhere it never registered.",
  "unsupported-response-type": "The app made a request this server doesn't support.",
  "pkce-required": "The app didn't protect its request with PKCE, so it can't be approved.",
  "invalid-scope": "The app asked for a permission that doesn't exist.",
  "invalid-resource":
    "The app asked for access to something other than this account's MCP server or API.",
  "no-scope-granted": "Pick at least one permission, or deny the request.",
};

const describe = <E>(error: E): OAuthActionFailed =>
  error instanceof InvalidAuthorizationRequest
    ? Option.match(Option.fromUndefinedOr(error.redirectTo), {
        onNone: () => new OAuthActionFailed({ message: REASONS[error.reason] }),
        onSome: (redirectTo) =>
          new OAuthActionFailed({ message: REASONS[error.reason], redirectTo }),
      })
    : new OAuthActionFailed({
        message:
          error instanceof ConnectedAppNotFound
            ? "That app is already disconnected."
            : "Something went wrong. Please try again.",
      });

/** Runs one OAuth call, replacing every failure with a readable message. */
export const callOAuth = <A, E>(call: (api: Client) => Effect.Effect<A, E>): Promise<A> =>
  callApi((api) => Effect.mapError(call(api), describe));

export const consentQuery = (request: AuthorizationRequest) =>
  queryOptions({
    queryKey: ["oauth", "consent", request],
    queryFn: () => callOAuth((api) => api.consent.inspect({ payload: request })),
    retry: false,
  });

export const grantsQuery = queryOptions({
  queryKey: ["oauth", "grants"],
  queryFn: () => callOAuth((api) => api.consent.grants()),
});

/** Where the failed request may send the browser back to, if anywhere. */
export const redirectOf = (error: Error): Option.Option<string> =>
  error instanceof OAuthActionFailed ? Option.fromUndefinedOr(error.redirectTo) : Option.none();
