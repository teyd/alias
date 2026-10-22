import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Authentication } from "./Auth.ts";
import { Scope } from "./Scopes.ts";

/**
 * The consent side of the OAuth 2.1 authorization server (PLAN.md §20.24). The authorization
 * endpoint is a page of the web app (`/oauth/authorize`): it hands the query it was opened with to
 * these endpoints, shows the signed-in user what the client asks for, and follows the redirect
 * the decision returns. The token and revocation endpoints are `OAuthGroup`'s (`Device.ts`);
 * metadata and dynamic registration speak the RFCs' own formats and are not part of this API.
 *
 * Session-only: no endpoint names a scope, so a token can neither approve a client nor see or
 * revoke connected apps.
 */

const Param = Schema.String.check(Schema.isMaxLength(2048));

/** An authorization request's query parameters, as the client sent them (RFC 6749 §4.1.1). */
const AuthorizationRequest = Schema.Struct({
  response_type: Param,
  client_id: Param,
  redirect_uri: Param,
  code_challenge: Schema.optionalKey(Param),
  code_challenge_method: Schema.optionalKey(Param),
  scope: Schema.optionalKey(Param),
  state: Schema.optionalKey(Param),
  /** RFC 8707: the resource the token is for, the MCP endpoint. */
  resource: Schema.optionalKey(Param),
});
export type AuthorizationRequest = typeof AuthorizationRequest.Type;

/**
 * Who asks. What a client says about itself (`name`) is never verified, whatever its kind; what
 * the consent screen can vouch for is `host` and `redirectHost` (PLAN.md §20.30).
 */
const RequestingClient = Schema.Struct({
  id: Schema.String,
  /** The client's own `client_name`: shown as a claim, never as who it is. */
  name: Schema.String,
  /**
   * `registered`: through dynamic registration (RFC 7591), so nothing about it is verified but
   * its redirect URIs. `metadata-document`: its id is the HTTPS URL of its metadata document.
   */
  kind: Schema.Literals(["registered", "metadata-document"]),
  /**
   * The host of a metadata-document client's `client_id` URL, which served the document: the one
   * name of who asks that is verified. None for registered clients.
   */
  host: Schema.OptionFromOptionalKey(Schema.String),
  /**
   * The client's `client_uri`, only when it is on `host` or below it (same scheme), so it may be
   * shown as a link. Never for registered clients.
   */
  uri: Schema.OptionFromOptionalKey(Schema.String),
  /** Where the code goes, which the consent screen must show (MCP authorization spec). */
  redirectHost: Schema.String,
  /** Only `localhost` redirects: any program on the user's machine could be posing as it. */
  isLocalRedirect: Schema.Boolean,
});

/** What the consent screen shows. */
const Consent = Schema.Struct({
  client: RequestingClient,
  /** The scopes asked for; the user may grant fewer. */
  scopes: Schema.Array(Scope),
  resource: Schema.String,
});
export type Consent = typeof Consent.Type;

const Decision = Schema.Struct({
  request: AuthorizationRequest,
  isApproved: Schema.Boolean,
  /** What the user granted, out of the scopes asked for. Ignored when not approved. */
  scopes: Schema.Array(Scope),
});

/** Where the browser goes next: the client's redirect URI, with a code or an error. */
const Redirect = Schema.Struct({ redirectTo: Schema.String });

/**
 * The request can't be shown. Without `redirectTo` the client or its redirect URI is unknown, so
 * nothing may be sent back (RFC 6749 §4.1.2.1); with it, the client gets the error at its
 * redirect URI.
 */
export class InvalidAuthorizationRequest extends Schema.TaggedError<InvalidAuthorizationRequest>()(
  "InvalidAuthorizationRequest",
  {
    reason: Schema.Literals([
      "unknown-client",
      "client-metadata-unavailable",
      "invalid-redirect-uri",
      "unsupported-response-type",
      "pkce-required",
      "invalid-scope",
      "invalid-resource",
      "no-scope-granted",
    ]),
    redirectTo: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

/** A client the user let in, as listed under "Connected apps". */
const ConnectedApp = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  clientName: Schema.String,
  scopes: Schema.Array(Scope),
  createdAt: Schema.DateTimeUtcFromString,
});
export type ConnectedApp = typeof ConnectedApp.Type;

export class ConnectedAppNotFound extends Schema.TaggedError<ConnectedAppNotFound>()(
  "ConnectedAppNotFound",
  { grantId: Schema.String },
  { httpApiStatus: 404 },
) {}

export const ConsentGroup = HttpApiGroup.make("consent")
  .add(
    HttpApiEndpoint.post("inspect", "/oauth/authorization", {
      payload: AuthorizationRequest,
      success: Consent,
      error: InvalidAuthorizationRequest,
    }),
  )
  .add(
    HttpApiEndpoint.post("decide", "/oauth/authorization/decision", {
      payload: Decision,
      success: Redirect,
      error: InvalidAuthorizationRequest,
    }),
  )
  .add(HttpApiEndpoint.get("grants", "/oauth/grants", { success: Schema.Array(ConnectedApp) }))
  .add(
    HttpApiEndpoint.delete("revoke", "/oauth/grants/:grantId", {
      params: { grantId: Schema.String },
      error: ConnectedAppNotFound,
    }),
  )
  .middleware(Authentication)
  .prefix("/v1");
