import { FunctionUrl } from "@alias/aws";
import {
  Authentication,
  CurrentUser,
  Forbidden,
  TOKEN_PREFIX,
  TokenAccessAnnotation,
  TooManyAttempts,
  Unauthenticated,
} from "@alias/contracts";
import { SessionRepo, TokenRepo, UserRepo } from "@alias/db";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Str from "effect/String";
import { hashToken } from "./Secrets.ts";
import { sessionId } from "./Sessions.ts";

/**
 * Failed token attempts one client address may make in a UTC hour before every token request
 * from it gets 429. Tokens carry 256 random bits, so this protects the table and the bill, not
 * the secrets.
 */
export const MAX_FAILURES_PER_HOUR = 20;

/** `lastUsedAt` moves at most this often per token, whatever the request rate. */
const TOUCH_EVERY = Duration.minutes(5);

/** `alias_pat_` and 32 random bytes in base64url. Anything else is refused without a lookup. */
const WELL_FORMED = new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

/**
 * The server side of `Authentication`: a live session cookie, or a token the endpoint accepts,
 * of a user who still exists.
 */
export const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const sessions = yield* SessionRepo.SessionRepo;
    const tokens = yield* TokenRepo.TokenRepo;
    const users = yield* UserRepo.UserRepo;

    /** A credential of a user who is gone (an erased account) authenticates nothing. */
    const isLiveUser = (userId: string) =>
      Effect.map(Effect.orDie(users.findById(userId)), Option.isSome);

    /** The client's address, hashed: the failure counter's key holds no IP. */
    const clientSource = Effect.fn("Authentication.clientSource")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const address = Option.getOrElse(
        Option.fromUndefinedOr(request.headers[FunctionUrl.SOURCE_IP_HEADER]),
        () => "unknown",
      );
      return yield* Effect.orDie(hashToken(crypto, address));
    });

    return Authentication.of({
      session: Effect.fn("Authentication.session")(function* (httpEffect, { credential }) {
        const token = Redacted.value(credential);
        if (Str.isEmpty(token)) return yield* new Unauthenticated();
        const id = yield* Effect.orDie(sessionId(crypto, token));
        const session = yield* Effect.orDie(sessions.find(id));
        if (Option.isNone(session)) return yield* new Unauthenticated();
        if (!(yield* isLiveUser(session.value.userId))) return yield* new Unauthenticated();
        return yield* Effect.provideService(httpEffect, CurrentUser, {
          userId: session.value.userId,
          username: session.value.username,
        });
      }),

      token: Effect.fn("Authentication.token")(function* (httpEffect, { credential, endpoint }) {
        const secret = Redacted.value(credential);
        if (Str.isEmpty(secret)) return yield* new Unauthenticated();
        const source = yield* clientSource();
        const now = yield* DateTime.now;
        if ((yield* Effect.orDie(tokens.failures(source, now))) >= MAX_FAILURES_PER_HOUR) {
          return yield* new TooManyAttempts();
        }
        const found = WELL_FORMED.test(secret)
          ? yield* Effect.orDie(
              Effect.flatMap(hashToken(crypto, secret), (hash) => tokens.findByHash(hash)),
            )
          : Option.none<TokenRepo.Token>();
        if (Option.isNone(found)) {
          yield* Effect.orDie(tokens.recordFailure(source, now, MAX_FAILURES_PER_HOUR));
          return yield* new Unauthenticated();
        }
        const token = found.value;
        if (!(yield* isLiveUser(token.userId))) return yield* new Unauthenticated();
        const access = Context.getOption(endpoint.annotations, TokenAccessAnnotation);
        if (Option.isNone(access)) return yield* new Forbidden({});
        if (access.value._tag === "Scope" && !Arr.contains(token.scopes, access.value.scope)) {
          return yield* new Forbidden({ scope: access.value.scope });
        }
        // Bookkeeping only: a failed write must not fail the request.
        yield* tokens
          .touch(token, now, TOUCH_EVERY)
          .pipe(
            Effect.catchTag("DatabaseError", (error) =>
              Effect.logWarning("token use not recorded", error.operation),
            ),
          );
        return yield* Effect.provideService(httpEffect, CurrentUser, {
          userId: token.userId,
          username: token.username,
        });
      }),
    });
  }),
);
