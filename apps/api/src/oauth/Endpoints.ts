import { DEVICE_CODE_GRANT_TYPE, Scope } from "@alias/contracts";
import { OAuth } from "@alias/core";
import { OAuthRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { clientSource } from "../ClientSource.ts";
import { GRANT_TYPES } from "./Grants.ts";
import { Issuer } from "./Issuer.ts";

/**
 * The authorization server's metadata (RFC 8414) and dynamic client registration (RFC 7591, kept
 * for clients that predate metadata documents), in the RFCs' own wire formats (PLAN.md §20.24).
 * The token and revocation endpoints are `OAuthGroup`'s, shared with the device login (§20.23).
 * All clients are public: nothing is authenticated but the code verifier and the tokens.
 */

/** Registrations one client address may make in an hour. Registration needs no account. */
export const MAX_REGISTRATIONS_PER_HOUR = 10;

const DEFAULT_CLIENT_NAME = "Unnamed client";

/** How long a registered client lives without a grant (PLAN.md §20.30); its first one keeps it. */
const UNUSED_CLIENT_LIFETIME = Duration.days(30);

const noStore = { "cache-control": "no-store", pragma: "no-cache" };

/** A registration error response (RFC 7591 §3.2.2). */
class RegistrationError extends Schema.TaggedError<RegistrationError>()("RegistrationError", {
  error: Schema.String,
  description: Schema.String,
  status: Schema.Number,
}) {}

const fail = (error: string, description: string, status = 400) =>
  Effect.fail(new RegistrationError({ error, description, status }));

const errorResponse = (error: RegistrationError) =>
  HttpServerResponse.jsonUnsafe(
    { error: error.error, error_description: error.description },
    { status: error.status, headers: noStore },
  );

const metadata = Effect.fn("OAuth.metadata")(function* () {
  const issuer = yield* Issuer;
  return HttpServerResponse.jsonUnsafe(
    {
      issuer: issuer.issuer,
      authorization_endpoint: issuer.authorizationEndpoint,
      token_endpoint: issuer.tokenEndpoint,
      registration_endpoint: issuer.registrationEndpoint,
      revocation_endpoint: issuer.revocationEndpoint,
      scopes_supported: Scope.literals,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      device_authorization_endpoint: issuer.deviceAuthorizationEndpoint,
      grant_types_supported: [...GRANT_TYPES, DEVICE_CODE_GRANT_TYPE],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
});

const Uri = Schema.String.check(Schema.isMaxLength(2048));

/** RFC 7591 §2, the fields read; anything else a client sends is ignored. */
const RegistrationRequest = Schema.Struct({
  redirect_uris: Schema.NonEmptyArray(Uri).check(Schema.isMaxLength(10)),
  client_name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  client_uri: Schema.optionalKey(Uri),
  grant_types: Schema.optionalKey(Schema.Array(Schema.String)),
  response_types: Schema.optionalKey(Schema.Array(Schema.String)),
});

const register = Effect.fn("OAuth.register")(function* () {
  const crypto = yield* Crypto.Crypto;
  const repo = yield* OAuthRepo.OAuthRepo;
  const now = yield* DateTime.now;
  const source = yield* clientSource();
  const body = yield* HttpServerRequest.schemaBodyJson(RegistrationRequest).pipe(
    Effect.catch(() => fail("invalid_client_metadata", "Not a client registration request.")),
  );
  if (!Arr.every(body.redirect_uris, OAuth.isAllowedRedirectUri)) {
    return yield* fail("invalid_redirect_uri", "Redirect URIs must be https or loopback http.");
  }
  if (!Arr.every(body.grant_types ?? [], (grant) => Arr.contains(GRANT_TYPES, grant))) {
    return yield* fail(
      "invalid_client_metadata",
      "Grant types: authorization_code, refresh_token.",
    );
  }
  if (!Arr.every(body.response_types ?? [], (type) => type === "code")) {
    return yield* fail("invalid_client_metadata", "Response types: code.");
  }
  const clientUri = Option.fromUndefinedOr(body.client_uri);
  if (Option.exists(clientUri, (uri) => !Str.startsWith("https://")(uri) || !URL.canParse(uri))) {
    return yield* fail("invalid_client_metadata", "client_uri must be an https URL.");
  }
  if (!(yield* Effect.orDie(repo.reserveRegistration(source, now, MAX_REGISTRATIONS_PER_HOUR)))) {
    return yield* fail("invalid_request", "Too many registrations; try again later.", 429);
  }
  const client: OAuthRepo.Client = {
    id: `mcp_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`,
    name: Option.getOrElse(
      Option.filter(Option.fromUndefinedOr(body.client_name?.trim()), Str.isNonEmpty),
      () => DEFAULT_CLIENT_NAME,
    ),
    redirectUris: body.redirect_uris,
    uri: clientUri,
    createdAt: now,
    expiresAt: Option.some(DateTime.addDuration(now, UNUSED_CLIENT_LIFETIME)),
  };
  yield* Effect.orDie(repo.registerClient(client));
  // Every client is public: whatever authentication it asked for, it gets none (§3.2.1 lets the
  // server replace requested metadata), and it can't hold a secret anyway.
  return HttpServerResponse.jsonUnsafe(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(DateTime.toEpochMillis(now) / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: GRANT_TYPES,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...Option.match(clientUri, { onNone: () => ({}), onSome: (uri) => ({ client_uri: uri }) }),
    },
    { status: 201, headers: noStore },
  );
});

const handle = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, RegistrationError, R>,
) => Effect.catchTag(effect, "RegistrationError", (error) => Effect.succeed(errorResponse(error)));

/** What the endpoints use. The routes capture them once, at startup. */
type EndpointServices = Crypto.Crypto | Issuer | OAuthRepo.OAuthRepo;

export const routes = HttpRouter.use(
  Effect.fn("OAuth.routes")(function* (router) {
    const services = yield* Effect.context<EndpointServices>();
    const serve = <R extends EndpointServices | HttpServerRequest.HttpServerRequest>(
      effect: Effect.Effect<HttpServerResponse.HttpServerResponse, RegistrationError, R>,
    ) => handle(effect).pipe(Effect.provide(services));
    yield* router.add("GET", "/.well-known/oauth-authorization-server", serve(metadata()));
    yield* router.add("POST", "/v1/oauth/register", serve(register()));
  }),
);
