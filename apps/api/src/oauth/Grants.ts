import { OAuthError } from "@alias/contracts";
import { OAuth } from "@alias/core";
import { OAuthRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { hashToken, newToken } from "../Secrets.ts";
import * as Clients from "./Clients.ts";
import { ACCESS_LIFETIME, PREFIX, REFRESH_LIFETIME } from "./Issuer.ts";

/**
 * The MCP clients' grants at the token endpoint (PLAN.md §20.24): `authorization_code` with PKCE
 * and rotating `refresh_token`, and revoking their tokens. The endpoint itself, `/v1/oauth/token`
 * and `/v1/oauth/revoke` in `OAuthGroup`, is shared with the device login (§20.23), which hands
 * these grant types and token prefixes here.
 */

/** The token request's fields these grants read; the endpoint decoded the form. */
export interface TokenRequest {
  readonly grant_type: string;
  readonly client_id: string;
  /** The device login's grant (`device.ts`). */
  readonly device_code?: string;
  readonly code?: string;
  readonly redirect_uri?: string;
  readonly code_verifier?: string;
  readonly refresh_token?: string;
  readonly scope?: string;
  readonly resource?: string;
}

export const GRANT_TYPES = ["authorization_code", "refresh_token"];

const fail = (error: OAuthError["error"], description: string) =>
  Effect.fail(new OAuthError({ error, error_description: description }));

const invalidGrant = (description: string) => fail("invalid_grant", description);

/** A parameter the grant needs, or `invalid_request` (RFC 6749 §5.2). */
const required = (value: Option.Option<string>, name: string) =>
  Option.match(Option.filter(value, Str.isNonEmpty), {
    onNone: () => fail("invalid_request", `Missing ${name}.`),
    onSome: Effect.succeed,
  });

/** A secret with its prefix, and the hash the table keeps instead. */
const secret = Effect.fn("Grants.secret")(function* (prefix: string) {
  const crypto = yield* Crypto.Crypto;
  const value = `${prefix}${yield* Effect.orDie(newToken(crypto))}`;
  return { value, hash: yield* Effect.orDie(hashToken(crypto, value)) };
});

/** A fresh access and refresh token for `grant`, the access token limited to `scopes`. */
const mint = Effect.fn("Grants.mint")(function* (
  grant: Pick<OAuthRepo.Grant, "id" | "userId" | "username" | "clientId" | "resource">,
  scopes: ReadonlyArray<string>,
  now: DateTime.Utc,
) {
  const access = yield* secret(PREFIX.access);
  const refresh = yield* secret(PREFIX.refresh);
  const issued: OAuthRepo.Issued = {
    access: {
      hash: access.hash,
      grantId: grant.id,
      clientId: grant.clientId,
      userId: grant.userId,
      username: grant.username,
      scopes,
      resource: grant.resource,
      expiresAt: DateTime.addDuration(now, ACCESS_LIFETIME),
    },
    refresh: {
      hash: refresh.hash,
      grantId: grant.id,
      clientId: grant.clientId,
      userId: grant.userId,
      expiresAt: DateTime.addDuration(now, REFRESH_LIFETIME),
    },
  };
  const response = {
    access_token: access.value,
    token_type: "Bearer" as const,
    expires_in: Duration.toSeconds(ACCESS_LIFETIME),
    refresh_token: refresh.value,
    scope: Arr.join(scopes, " "),
  };
  return { issued, response };
});

const exchangeCode = Effect.fn("Grants.exchangeCode")(function* (request: TokenRequest) {
  const codeValue = yield* required(Option.fromUndefinedOr(request.code), "code");
  const redirectUri = yield* required(Option.fromUndefinedOr(request.redirect_uri), "redirect_uri");
  const verifier = yield* required(Option.fromUndefinedOr(request.code_verifier), "code_verifier");
  const crypto = yield* Crypto.Crypto;
  const repo = yield* OAuthRepo.OAuthRepo;
  const found = yield* Effect.orDie(
    Effect.flatMap(hashToken(crypto, codeValue), (hash) => repo.findCode(hash)),
  );
  if (Option.isNone(found)) return yield* invalidGrant("Unknown or expired code.");
  const code = found.value;
  if (Option.isSome(code.grantId)) {
    // A code redeemed twice may have been stolen: what it issued goes (OAuth 2.1 §4.1.3).
    yield* Effect.orDie(repo.revokeGrant(code.grantId.value));
    return yield* invalidGrant("Code already used.");
  }
  if (code.clientId !== request.client_id) return yield* invalidGrant("Code of another client.");
  if (code.redirectUri !== redirectUri) return yield* invalidGrant("Wrong redirect_uri.");
  if (!(yield* OAuth.verifyS256(verifier, code.codeChallenge))) {
    return yield* invalidGrant("PKCE verification failed.");
  }
  if (request.resource !== undefined && request.resource !== code.resource) {
    return yield* fail("invalid_target", "Not the resource this code was issued for.");
  }
  const now = yield* DateTime.now;
  const grant: OAuthRepo.Grant = {
    id: `grt_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`,
    userId: code.userId,
    username: code.username,
    clientId: code.clientId,
    clientName: code.clientName,
    scopes: code.scopes,
    resource: code.resource,
    createdAt: now,
    expiresAt: DateTime.addDuration(now, REFRESH_LIFETIME),
  };
  const { issued, response } = yield* mint(grant, grant.scopes, now);
  const client = { isRegistered: !Clients.isMetadataDocumentId(code.clientId) };
  yield* repo.redeemCode(code, grant, issued, client).pipe(
    Effect.catchTags({
      CodeUnusable: () => invalidGrant("Code already used."),
      DatabaseError: Effect.die,
    }),
  );
  return response;
});

const exchangeRefresh = Effect.fn("Grants.exchangeRefresh")(function* (request: TokenRequest) {
  const presented = yield* required(Option.fromUndefinedOr(request.refresh_token), "refresh_token");
  const crypto = yield* Crypto.Crypto;
  const repo = yield* OAuthRepo.OAuthRepo;
  const refresh = yield* Effect.orDie(
    Effect.flatMap(hashToken(crypto, presented), (hash) => repo.findRefresh(hash)),
  );
  if (Option.isNone(refresh) || refresh.value.clientId !== request.client_id) {
    return yield* invalidGrant("Unknown, expired or revoked refresh token.");
  }
  const grant = yield* Effect.orDie(repo.findGrant(refresh.value.grantId));
  if (Option.isNone(grant)) return yield* invalidGrant("The grant was revoked.");
  if (request.resource !== undefined && request.resource !== grant.value.resource) {
    return yield* fail("invalid_target", "Not the resource this grant is for.");
  }
  // A refresh may ask for fewer scopes than granted (RFC 6749 §6), never more.
  const asked = OAuth.scopeTokens(request.scope ?? "");
  if (!Arr.every(asked, (scope) => Arr.contains(grant.value.scopes, scope))) {
    return yield* fail("invalid_scope", "More scopes than were granted.");
  }
  const now = yield* DateTime.now;
  const { issued, response } = yield* mint(
    grant.value,
    Arr.isReadonlyArrayNonEmpty(asked) ? asked : grant.value.scopes,
    now,
  );
  yield* repo.rotate(refresh.value, issued, issued.refresh.expiresAt).pipe(
    Effect.catchTags({
      RefreshUnusable: () => invalidGrant("Unknown, expired or revoked refresh token."),
      DatabaseError: Effect.die,
    }),
  );
  return response;
});

/** Exchanges a code or a refresh token for new tokens (`grant_type` is one of `GRANT_TYPES`). */
export const exchange = (request: TokenRequest) =>
  request.grant_type === "authorization_code" ? exchangeCode(request) : exchangeRefresh(request);

/** True for the tokens `revoke` handles: MCP clients' access and refresh tokens. */
export const isOAuthToken = (token: string) =>
  Str.startsWith(PREFIX.refresh)(token) || Str.startsWith(PREFIX.access)(token);

/**
 * RFC 7009 for an MCP client's token: a refresh token revokes its grant, with every access token
 * of it; an access token goes alone. A token of another client (when `client_id` is given) is
 * left alone, silently, like an unknown one (§2.2).
 */
export const revoke = Effect.fn("Grants.revoke")(function* (
  token: string,
  clientId: Option.Option<string>,
) {
  const crypto = yield* Crypto.Crypto;
  const repo = yield* OAuthRepo.OAuthRepo;
  const hash = yield* Effect.orDie(hashToken(crypto, token));
  const ownedBy = <A extends { readonly clientId: string }>(item: Option.Option<A>) =>
    Option.filter(
      item,
      (found) => Option.getOrElse(clientId, () => found.clientId) === found.clientId,
    );
  if (Str.startsWith(PREFIX.refresh)(token)) {
    const refresh = ownedBy(yield* Effect.orDie(repo.findRefresh(hash)));
    if (Option.isSome(refresh)) yield* Effect.orDie(repo.revokeGrant(refresh.value.grantId));
    return;
  }
  const access = ownedBy(yield* Effect.orDie(repo.findAccess(hash)));
  if (Option.isSome(access)) yield* Effect.orDie(repo.revokeAccess(hash));
});
