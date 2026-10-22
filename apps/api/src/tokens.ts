import { Api, CurrentUser, Scope, type Token, TOKEN_PREFIX, TokenNotFound } from "@alias/contracts";
import { TokenRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { hashToken, newToken } from "./Secrets.ts";

const view = (token: TokenRepo.Token): Token => ({
  id: token.id,
  name: token.name,
  scopes: Arr.filter(token.scopes, Schema.is(Scope)),
  hint: token.hint,
  createdAt: token.createdAt,
  expiresAt: token.expiresAt,
  lastUsedAt: token.lastUsedAt,
});

/**
 * Mints a token: `alias_pat_` and 256 random bits. Only the SHA-256 is stored. A slow password
 * hash (argon2, scrypt) defends low-entropy secrets against offline guessing and would cost every
 * request tens of milliseconds; a 256-bit random secret can't be guessed offline, and its plain
 * hash is a lookup key, so a request costs one GetItem.
 */
const create = Effect.fn("tokens.create")(function* (payload: {
  readonly name: string;
  readonly scopes: ReadonlyArray<Token["scopes"][number]>;
  readonly expiresInDays?: number;
}) {
  const user = yield* CurrentUser;
  const crypto = yield* Crypto.Crypto;
  const tokens = yield* TokenRepo.TokenRepo;
  const secret = `${TOKEN_PREFIX}${yield* newToken(crypto)}`;
  const now = yield* DateTime.now;
  const token: TokenRepo.NewToken = {
    id: `tok_${(yield* crypto.randomULID).toLowerCase()}`,
    hash: yield* hashToken(crypto, secret),
    userId: user.userId,
    username: user.username,
    name: payload.name,
    scopes: Arr.dedupe(payload.scopes),
    hint: secret.slice(-4),
    createdAt: now,
    expiresAt: Option.map(Option.fromUndefinedOr(payload.expiresInDays), (days) =>
      DateTime.addDuration(now, Duration.days(days)),
    ),
  };
  yield* tokens.create(token);
  return { ...view({ ...token, lastUsedAt: Option.none() }), token: secret };
});

/** What the token handlers use. The group captures them once, at startup. */
type TokenServices = Crypto.Crypto | TokenRepo.TokenRepo;

export const TokensLive = HttpApiBuilder.group(Api, "tokens", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<TokenServices>();
    const tokens = yield* TokenRepo.TokenRepo;
    return handlers
      .handle("list", () =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => Effect.orDie(tokens.list(user.userId))),
          Effect.map(Arr.map(view)),
        ),
      )
      .handle("create", ({ payload }) => Effect.provide(Effect.orDie(create(payload)), services))
      .handle("revoke", ({ params }) =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => tokens.revoke(user.userId, params.tokenId)),
          Effect.catchTags({
            NoSuchToken: () => Effect.fail(new TokenNotFound({ tokenId: params.tokenId })),
            DatabaseError: Effect.die,
          }),
        ),
      );
  }),
);
