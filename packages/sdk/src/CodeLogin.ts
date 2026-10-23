import { Api, type Scope } from "@alias/contracts";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Base64Url } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/**
 * A login for programs that can show the person a browser and catch where it is sent back (a
 * browser extension through `identity.launchWebAuthFlow`): the OAuth 2.1 authorization code
 * grant with PKCE (`S256`) against the API's authorization server (PLAN.md §20.24, §20.35),
 * for an access token bound to the HTTP API (RFC 8707) and a rotating refresh token. The client
 * registers itself (RFC 7591) with its redirect URI, since that names the installation. Needs an
 * `HttpClient`; `start` also needs `Crypto`.
 */

/** The login ended without tokens: refused, tampered with, or answered by someone else. */
export class CodeLoginFailed extends Schema.TaggedError<CodeLoginFailed>()("CodeLoginFailed", {
  reason: Schema.String,
}) {}

/** RFC 8414, the fields read. */
const Metadata = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
});

/** RFC 7591 §3.2.1, the field read. */
const Registered = Schema.Struct({ client_id: Schema.String });

const failed = (reason: string) => new CodeLoginFailed({ reason });

/** A JSON answer of the server, or `CodeLoginFailed` naming what was asked. */
const fetchJson = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
  what: string,
) =>
  Effect.flatMap(Effect.service(HttpClient.HttpClient), (client) => client.execute(request)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    Effect.mapError(() => failed(`${what} failed`)),
  );

const metadata = (baseUrl: string) =>
  fetchJson(
    HttpClientRequest.get(`${baseUrl}/.well-known/oauth-authorization-server`).pipe(
      HttpClientRequest.acceptJson,
    ),
    Metadata,
    "reading the authorization server's metadata",
  );

/** Registers a public client for `redirectUri`, answering its `client_id`. */
export const register = Effect.fn("CodeLogin.register")(function* (options: {
  readonly baseUrl: string;
  readonly redirectUri: string;
  readonly clientName: string;
}) {
  const registered = yield* fetchJson(
    HttpClientRequest.post(`${options.baseUrl}/v1/oauth/register`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        redirect_uris: [options.redirectUri],
        client_name: options.clientName,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    ),
    Registered,
    "registering the client",
  );
  return registered.client_id;
});

/** A login waiting for the browser to come back. Keep it out of anyone else's reach. */
export interface Pending {
  /** Where to send the browser. */
  readonly authorizationUrl: string;
  readonly baseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly issuer: string;
  readonly resource: string;
  readonly state: string;
  readonly verifier: Redacted.Redacted<string>;
}

/** What a login or a refresh yields. */
export interface Tokens {
  /** For `AliasClient.make`; it lives an hour. */
  readonly accessToken: Redacted.Redacted<string>;
  /** For {@link refresh}; each refresh replaces it, and presenting a used one revokes the grant. */
  readonly refreshToken: Redacted.Redacted<string>;
  readonly expiresAt: DateTime.Utc;
  readonly scopes: ReadonlyArray<string>;
}

/** 32 random bytes in base64url: 43 characters, a valid PKCE verifier (RFC 7636 §4.1). */
const randomString = Effect.fn("CodeLogin.randomString")(function* () {
  const crypto = yield* Crypto.Crypto;
  return Base64Url.encode(yield* Effect.orDie(crypto.randomBytes(32)));
});

/**
 * Prepares the authorization request: a fresh verifier and `state`, the challenge, and the
 * resource, the HTTP API under the issuer the server names.
 */
export const start = Effect.fn("CodeLogin.start")(function* (options: {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: Arr.NonEmptyReadonlyArray<Scope>;
}) {
  const server = yield* metadata(options.baseUrl);
  const crypto = yield* Crypto.Crypto;
  const verifier = yield* randomString();
  const state = yield* randomString();
  const challenge = Base64Url.encode(
    yield* Effect.orDie(crypto.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const resource = `${server.issuer}/v1`;
  const url = new URL(server.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: Arr.join(options.scopes, " "),
    state,
    resource,
  }).toString();
  return {
    authorizationUrl: url.href,
    baseUrl: options.baseUrl,
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    issuer: server.issuer,
    resource,
    state,
    verifier: Redacted.make(verifier),
  } satisfies Pending;
});

const issued = Effect.fn("CodeLogin.issued")(function* (answer: {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly scope: string;
}) {
  if (answer.refresh_token === undefined) return yield* failed("no refresh token issued");
  return {
    accessToken: Redacted.make(answer.access_token),
    refreshToken: Redacted.make(answer.refresh_token),
    expiresAt: DateTime.addDuration(yield* DateTime.now, Duration.seconds(answer.expires_in)),
    scopes: Arr.filter(answer.scope.split(" "), (scope) => scope !== ""),
  } satisfies Tokens;
});

/**
 * Finishes the login with the URL the browser was sent back to: it must carry this login's
 * `state` and the issuer (RFC 9207, against mix-up attacks), then the code is redeemed with the
 * verifier. A refusal (`error=access_denied`) fails with its error code.
 */
export const finish = Effect.fn("CodeLogin.finish")(function* (
  pending: Pending,
  redirectedTo: string,
) {
  if (!URL.canParse(redirectedTo)) return yield* failed("not a URL");
  const url = new URL(redirectedTo);
  const param = (name: string) => Option.fromNullishOr(url.searchParams.get(name));
  if (`${url.origin}${url.pathname}` !== new URL(pending.redirectUri).href) {
    return yield* failed("sent back somewhere else");
  }
  if (!Option.contains(param("state"), pending.state)) return yield* failed("state differs");
  if (!Option.contains(param("iss"), pending.issuer)) return yield* failed("issuer differs");
  const error = param("error");
  if (Option.isSome(error)) return yield* failed(error.value);
  const code = param("code");
  if (Option.isNone(code)) return yield* failed("no code");
  const client = yield* HttpApiClient.make(Api, { baseUrl: pending.baseUrl });
  const answer = yield* client.oauth.token({
    payload: {
      grant_type: "authorization_code",
      client_id: pending.clientId,
      code: code.value,
      redirect_uri: pending.redirectUri,
      code_verifier: Redacted.value(pending.verifier),
      resource: pending.resource,
    },
  });
  return yield* issued(answer);
});

/**
 * Swaps the refresh token for new tokens. Never run two at once for one grant: the server takes
 * the second for a stolen token and revokes the grant. `OAuthError` `invalid_grant` means the
 * grant is gone (revoked, disconnected or lapsed); log in again.
 */
export const refresh = Effect.fn("CodeLogin.refresh")(function* (options: {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly refreshToken: Redacted.Redacted<string>;
}) {
  const client = yield* HttpApiClient.make(Api, { baseUrl: options.baseUrl });
  const answer = yield* client.oauth.token({
    payload: {
      grant_type: "refresh_token",
      client_id: options.clientId,
      refresh_token: Redacted.value(options.refreshToken),
    },
  });
  return yield* issued(answer);
});

/** Ends the login: revoking the refresh token revokes the grant and its access tokens (RFC 7009). */
export const logout = Effect.fn("CodeLogin.logout")(function* (options: {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly refreshToken: Redacted.Redacted<string>;
}) {
  const client = yield* HttpApiClient.make(Api, { baseUrl: options.baseUrl });
  yield* client.oauth.revoke({
    payload: { token: Redacted.value(options.refreshToken), client_id: options.clientId },
  });
});
