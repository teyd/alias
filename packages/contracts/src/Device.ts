import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Authentication } from "./Auth.ts";
import { Scope, TooManyAttempts } from "./Scopes.ts";

/** RFC 8628 §3.4: the `grant_type` a device polls the token endpoint with. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Clients that may start a device login, with the name the approval page shows. Public clients
 * (RFC 6749 §2.1): the id names the program, it proves nothing.
 */
export const DeviceClientId = Schema.Literals(["alias-cli"]);
export type DeviceClientId = typeof DeviceClientId.Type;
export const DeviceClients = { "alias-cli": "Alias CLI" } satisfies Record<DeviceClientId, string>;

/**
 * The OAuth error response (RFC 6749 §5.2, RFC 8628 §3.5), status 400. The wire carries
 * `error`, which OAuth clients read, next to Effect's `_tag`.
 */
export class OAuthError extends Schema.TaggedError<OAuthError>()(
  "OAuthError",
  {
    error: Schema.Literals([
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "invalid_scope",
      "unsupported_grant_type",
      "authorization_pending",
      "slow_down",
      "access_denied",
      "expired_token",
      "invalid_target",
    ]),
    error_description: Schema.optionalKey(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

/** RFC 8628 §3.1, form-encoded like every OAuth endpoint. `scope` is space-separated. */
const DeviceAuthorizationRequest = Schema.Struct({
  client_id: Schema.String,
  scope: Schema.String,
}).pipe(HttpApiSchema.asFormUrlEncoded());

/** RFC 8628 §3.2. */
const DeviceAuthorization = Schema.Struct({
  device_code: Schema.String,
  /** As shown: `BCDF-GHJK`. */
  user_code: Schema.String,
  verification_uri: Schema.String,
  /** `verification_uri` with the code filled in, e.g. for a QR code. */
  verification_uri_complete: Schema.String,
  expires_in: Schema.Int,
  interval: Schema.Int,
});

/**
 * One token endpoint for every grant: the device code (RFC 8628 §3.4) and, for MCP clients
 * (PLAN.md §20.24), an authorization code with its PKCE verifier (OAuth 2.1 §4.1.3) or a refresh
 * token (§4.3). Each grant type checks the fields it needs.
 */
const TokenRequest = Schema.Struct({
  grant_type: Schema.String,
  client_id: Schema.String,
  device_code: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  redirect_uri: Schema.optionalKey(Schema.String),
  code_verifier: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  /** RFC 8707: the MCP resource the token is for. */
  resource: Schema.optionalKey(Schema.String),
}).pipe(HttpApiSchema.asFormUrlEncoded());

/**
 * RFC 6749 §5.1. A device login gets a personal API token (`alias_pat_…`); an MCP client an
 * hour's access token (`alias_oat_…`) and a refresh token (`alias_ort_…`), rotated on each use.
 */
const AccessToken = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Int,
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.String,
});

/**
 * RFC 7009 §2.1. `token_type_hint` is accepted and ignored: the prefix tells the kind of token.
 * A public client may name itself (`client_id`); another client's token is then left alone.
 */
const RevocationRequest = Schema.Struct({
  token: Schema.String,
  token_type_hint: Schema.optionalKey(Schema.String),
  client_id: Schema.optionalKey(Schema.String),
}).pipe(HttpApiSchema.asFormUrlEncoded());

/**
 * The device side of a device login (RFC 8628) and token revocation (RFC 7009), without
 * credentials. A device asks for a code, shows the user code, and polls `token` until the
 * signed-in user approves or denies it on the web (`DeviceGroup`). Responses carry
 * `Cache-Control: no-store`.
 */
export const OAuthGroup = HttpApiGroup.make("oauth")
  .add(
    HttpApiEndpoint.post("deviceAuthorization", "/device_authorization", {
      payload: DeviceAuthorizationRequest,
      success: DeviceAuthorization,
      error: [OAuthError, TooManyAttempts],
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/token", {
      payload: TokenRequest,
      success: AccessToken,
      error: [OAuthError, TooManyAttempts],
    }),
  )
  .add(
    // Always 200: revoking an unknown or already revoked token is not an error (RFC 7009 §2.2).
    HttpApiEndpoint.post("revoke", "/revoke", {
      payload: RevocationRequest,
      success: HttpApiSchema.Empty(200),
    }),
  )
  .prefix("/v1/oauth");

/** A device login waiting for the signed-in user's decision, as the approval page shows it. */
const DeviceRequest = Schema.Struct({
  /** As shown: `BCDF-GHJK`. */
  userCode: Schema.String,
  clientId: Schema.String,
  clientName: Schema.String,
  scopes: Schema.Array(Scope),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type DeviceRequest = typeof DeviceRequest.Type;

/** No pending device login has this code: mistyped, expired, or already decided. */
export class DeviceCodeNotFound extends Schema.TaggedError<DeviceCodeNotFound>()(
  "DeviceCodeNotFound",
  {},
  { httpApiStatus: 404 },
) {}

const UserCodePayload = Schema.Struct({ userCode: Schema.String });

/**
 * The person's side of a device login, session-only: a token can't approve a login (that would
 * let a token mint tokens). The code travels in the body, not the URL. Unknown codes count
 * against the user; after a few an hour every lookup gets `TooManyAttempts`.
 */
export const DeviceGroup = HttpApiGroup.make("device")
  .add(
    HttpApiEndpoint.post("lookup", "/device/lookup", {
      payload: UserCodePayload,
      success: DeviceRequest,
      error: [DeviceCodeNotFound, TooManyAttempts],
    }),
  )
  .add(
    HttpApiEndpoint.post("approve", "/device/approve", {
      payload: UserCodePayload,
      error: [DeviceCodeNotFound, TooManyAttempts],
    }),
  )
  .add(
    HttpApiEndpoint.post("deny", "/device/deny", {
      payload: UserCodePayload,
      error: [DeviceCodeNotFound, TooManyAttempts],
    }),
  )
  .middleware(Authentication)
  .prefix("/v1");
