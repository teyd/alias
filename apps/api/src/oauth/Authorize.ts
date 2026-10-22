import {
  type AuthorizationRequest,
  type Consent,
  CurrentUser,
  InvalidAuthorizationRequest,
  Scope,
} from "@alias/contracts";
import { OAuth } from "@alias/core";
import { OAuthRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { hashToken, newToken } from "../Secrets.ts";
import * as Clients from "./Clients.ts";
import { CODE_LIFETIME, Issuer, PREFIX } from "./Issuer.ts";

/**
 * The authorization endpoint (OAuth 2.1 §4.1.1), split in two: `inspect` validates a request for
 * the consent screen, `decide` validates it again and answers with the redirect carrying a code
 * or an error. Both need a signed-in user; the web app's `/oauth/authorize` page shows the login
 * in place when there is none.
 */

const isScope = Schema.is(Scope);

type Reason = InvalidAuthorizationRequest["reason"];

/** The OAuth error code each refusal is reported with at the redirect URI (RFC 6749 §4.1.2.1). */
const ERROR_CODES: Partial<Record<Reason, string>> = {
  "unsupported-response-type": "unsupported_response_type",
  "pkce-required": "invalid_request",
  "invalid-scope": "invalid_scope",
  "invalid-resource": "invalid_target",
};

/** A validated authorization request. */
interface Valid {
  readonly client: Clients.Client;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: ReadonlyArray<Scope>;
  readonly resource: string;
  readonly state: Option.Option<string>;
}

/** `redirectUri` with `params`, the issuer (RFC 9207) and the client's `state` added. */
const redirect = Effect.fn("Authorize.redirect")(function* (
  redirectUri: string,
  state: Option.Option<string>,
  params: Readonly<Record<string, string>>,
) {
  const { issuer } = yield* Issuer;
  const url = new URL(redirectUri);
  url.search = new URLSearchParams([
    ...url.searchParams,
    ...R.toEntries(params),
    ...Arr.fromOption(Option.map(state, (value): [string, string] => ["state", value])),
    ["iss", issuer],
  ]).toString();
  return url.href;
});

/** A refusal reported to the client at its redirect URI, now that it is known to be its own. */
const refuseTo = (redirectUri: string, state: Option.Option<string>) => (reason: Reason) =>
  redirect(redirectUri, state, {
    error: ERROR_CODES[reason] ?? "invalid_request",
    error_description: reason,
  }).pipe(
    Effect.flatMap((redirectTo) =>
      Effect.fail(new InvalidAuthorizationRequest({ reason, redirectTo })),
    ),
  );

/** A refusal that must not redirect: the client or its redirect URI is in doubt. */
const refuse = (reason: Reason) => Effect.fail(new InvalidAuthorizationRequest({ reason }));

const validate = Effect.fn("Authorize.validate")(function* (request: AuthorizationRequest) {
  const client = yield* Clients.resolve(request.client_id).pipe(
    Effect.catchTags({
      UnknownClient: () => refuse("unknown-client"),
      ClientMetadataUnavailable: () => refuse("client-metadata-unavailable"),
    }),
  );
  if (!Arr.some(client.redirectUris, (uri) => OAuth.redirectMatches(uri, request.redirect_uri))) {
    return yield* refuse("invalid-redirect-uri");
  }
  const state = Option.fromUndefinedOr(request.state);
  const refuseHere = refuseTo(request.redirect_uri, state);
  if (request.response_type !== "code") return yield* refuseHere("unsupported-response-type");
  const challenge = request.code_challenge ?? "";
  if (request.code_challenge_method !== "S256" || !OAuth.isS256Challenge(challenge)) {
    return yield* refuseHere("pkce-required");
  }
  const asked = OAuth.scopeTokens(request.scope ?? "");
  if (!Arr.every(asked, isScope)) return yield* refuseHere("invalid-scope");
  const { resource } = yield* Issuer;
  if (request.resource !== undefined && request.resource !== resource) {
    return yield* refuseHere("invalid-resource");
  }
  return {
    client,
    redirectUri: request.redirect_uri,
    codeChallenge: challenge,
    // No scope asked for: offer them all, and let the user choose.
    scopes: Arr.isReadonlyArrayNonEmpty(asked) ? asked : Scope.literals,
    resource,
    state,
  } satisfies Valid;
});

const hostOf = (uri: string) => (URL.canParse(uri) ? new URL(uri).host : uri);

/** The host a metadata-document client's document was fetched from. */
const verifiedHost = (client: Clients.Client) =>
  client.kind === "metadata-document" && URL.canParse(client.id)
    ? Option.some(new URL(client.id))
    : Option.none();

/**
 * The client's `client_uri` when it is on the verified host or below it, with the same scheme;
 * otherwise anyone's document could link the consent screen anywhere (SR-15, PLAN.md §20.25).
 */
const sameSiteUri = (client: Clients.Client, host: Option.Option<URL>) =>
  Option.flatMap(host, (verified) =>
    Option.filter(client.uri, (uri) => {
      if (!URL.canParse(uri)) return false;
      const url = new URL(uri);
      return (
        url.protocol === verified.protocol &&
        url.username === "" &&
        url.password === "" &&
        (url.hostname === verified.hostname || url.hostname.endsWith(`.${verified.hostname}`))
      );
    }),
  );

/** What the consent screen shows for `request`. */
export const inspect = Effect.fn("Authorize.inspect")(function* (request: AuthorizationRequest) {
  const valid = yield* validate(request);
  const host = verifiedHost(valid.client);
  return {
    client: {
      id: valid.client.id,
      name: valid.client.name,
      kind: valid.client.kind,
      host: Option.map(host, (url) => url.host),
      uri: sameSiteUri(valid.client, host),
      redirectHost: hostOf(valid.redirectUri),
      isLocalRedirect: OAuth.isLocalRedirectUri(valid.redirectUri),
    },
    scopes: valid.scopes,
    resource: valid.resource,
  } satisfies Consent;
});

/**
 * The user's answer to `request`: a redirect with a fresh authorization code for the scopes they
 * granted, or with `access_denied`.
 */
export const decide = Effect.fn("Authorize.decide")(function* (decision: {
  readonly request: AuthorizationRequest;
  readonly isApproved: boolean;
  readonly scopes: ReadonlyArray<Scope>;
}) {
  const valid = yield* validate(decision.request);
  if (!decision.isApproved) {
    return yield* redirect(valid.redirectUri, valid.state, {
      error: "access_denied",
      error_description: "The user declined.",
    });
  }
  const granted = Arr.filter(valid.scopes, (scope) => Arr.contains(decision.scopes, scope));
  if (Arr.isArrayEmpty(granted)) return yield* refuse("no-scope-granted");
  const user = yield* CurrentUser;
  const crypto = yield* Crypto.Crypto;
  const repo = yield* OAuthRepo.OAuthRepo;
  const code = `${PREFIX.code}${yield* Effect.orDie(newToken(crypto))}`;
  yield* Effect.orDie(
    repo.createCode({
      hash: yield* Effect.orDie(hashToken(crypto, code)),
      clientId: valid.client.id,
      clientName: valid.client.name,
      redirectUri: valid.redirectUri,
      codeChallenge: valid.codeChallenge,
      scopes: granted,
      resource: valid.resource,
      userId: user.userId,
      username: user.username,
      expiresAt: DateTime.addDuration(yield* DateTime.now, CODE_LIFETIME),
    }),
  );
  return yield* redirect(valid.redirectUri, valid.state, { code });
});
