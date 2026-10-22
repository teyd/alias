import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { Authentication } from "./Auth.ts";
import { Scope } from "./Scopes.ts";

/** Every token starts with it, so secret scanners can find leaked ones. */
export const TOKEN_PREFIX = "alias_pat_";

const TokenName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64));

/** A token as listed. The secret itself is never shown again after creation. */
const Token = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  scopes: Schema.Array(Scope),
  /** The secret's last four characters, to tell tokens apart: `alias_pat_…AbCd`. */
  hint: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  /** Never expires when absent. */
  expiresAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
  /** Updated at most every few minutes. */
  lastUsedAt: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
});
export type Token = typeof Token.Type;

const NewToken = Schema.Struct({
  name: TokenName,
  scopes: Schema.NonEmptyArray(Scope),
  /** Absent: the token lives until revoked. */
  expiresInDays: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 366 })),
  ),
});

/** The new token, with its secret: shown this once, stored only as a hash. */
const CreatedToken = Schema.Struct({ ...Token.fields, token: Schema.String });

export class TokenNotFound extends Schema.TaggedError<TokenNotFound>()(
  "TokenNotFound",
  { tokenId: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * Personal API tokens. Session-only (no endpoint names a scope), so a token can't mint, list or
 * revoke tokens.
 */
export const TokensGroup = HttpApiGroup.make("tokens")
  .add(HttpApiEndpoint.get("list", "/tokens", { success: Schema.Array(Token) }))
  .add(
    HttpApiEndpoint.post("create", "/tokens", {
      payload: NewToken,
      success: CreatedToken.pipe(HttpApiSchema.status(201)),
    }),
  )
  .add(
    HttpApiEndpoint.delete("revoke", "/tokens/:tokenId", {
      params: { tokenId: Schema.String },
      error: TokenNotFound,
    }),
  )
  .middleware(Authentication)
  .prefix("/v1");
