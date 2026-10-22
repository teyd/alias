import {
  Authentication,
  CrossSiteRequest,
  CurrentUser,
  Forbidden,
  sessionCookie,
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
import { clientSource } from "./ClientSource.ts";
import { RelyingParty } from "./RelyingParty.ts";
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

/** Methods that change nothing; everything else is a change. */
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/** `application/json`, whatever parameters follow, in any case. */
const isJson = (contentType: string) =>
  Str.toLowerCase(Str.trim(Str.split(contentType, ";")[0] ?? "")) === "application/json";

/**
 * CSRF protection beyond `SameSite=Strict` (SR-14, PLAN.md §20.30), for changes the session
 * cookie authenticates. Browsers send `Sec-Fetch-Site` and `Origin` on every non-GET fetch and
 * form, and pages can't forge either, so a change must say `same-origin` and the web app's own
 * origin where it says anything, and say at least one of them. A body must be JSON: HttpApi
 * decodes a body without `Content-Type` as JSON, which would let a cross-site
 * `fetch(…, { mode: "no-cors", body: blob })`, a "simple" request, reach a JSON endpoint. The body
 * text is cached by the request, so the payload decoder reads the same text afterwards.
 */
const requireSameOrigin = Effect.fn("Authentication.requireSameOrigin")(function* (
  appOrigin: string,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Arr.contains(SAFE_METHODS, request.method)) return;
  const fetchSite = Option.fromUndefinedOr(request.headers["sec-fetch-site"]);
  const origin = Option.fromUndefinedOr(request.headers["origin"]);
  if (
    (Option.isNone(fetchSite) && Option.isNone(origin)) ||
    Option.exists(fetchSite, (site) => site !== "same-origin") ||
    Option.exists(origin, (value) => value !== appOrigin)
  ) {
    return yield* new CrossSiteRequest();
  }
  const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  if (Str.isNonEmpty(body) && !isJson(request.headers["content-type"] ?? "")) {
    return yield* new CrossSiteRequest();
  }
});

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
    const relyingParty = yield* RelyingParty;

    /** A credential of a user who is gone (an erased account) authenticates nothing. */
    const isLiveUser = (userId: string) =>
      Effect.map(Effect.orDie(users.findById(userId)), Option.isSome);

    return Authentication.of({
      session: Effect.fn("Authentication.session")(function* (httpEffect, { credential }) {
        const token = Redacted.value(credential);
        if (Str.isEmpty(token)) return yield* new Unauthenticated();
        const id = yield* Effect.orDie(sessionId(crypto, token));
        const session = yield* Effect.orDie(sessions.find(id));
        if (Option.isNone(session)) return yield* new Unauthenticated();
        if (!(yield* isLiveUser(session.value.userId))) return yield* new Unauthenticated();
        yield* requireSameOrigin(relyingParty.origin);
        return yield* Effect.provideService(httpEffect, CurrentUser, {
          userId: session.value.userId,
          username: session.value.username,
        });
      }),

      token: Effect.fn("Authentication.token")(function* (httpEffect, { credential, endpoint }) {
        const secret = Redacted.value(credential);
        if (Str.isEmpty(secret)) {
          // No token: the session, tried first, refused. If that was a cross-site change, this
          // is the answer that says so (`Authentication` returns the last scheme's failure).
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (Str.isNonEmpty(request.cookies[sessionCookie.key] ?? "")) {
            yield* requireSameOrigin(relyingParty.origin);
          }
          return yield* new Unauthenticated();
        }
        const source = yield* Effect.provideService(clientSource(), Crypto.Crypto, crypto);
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
