import { Authentication, CurrentUser, Unauthenticated, sessionCookie } from "@alias/contracts";
import { SessionRepo, UserRepo } from "@alias/db";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Str from "effect/String";
import { hashToken, newToken } from "./Secrets.ts";

const SESSION_LIFETIME = Duration.days(30);

/** `SameSite=Strict` keeps the cookie off cross-site requests, which is the CSRF defence. */
const cookieOptions = { path: "/", sameSite: "strict", secure: true, httpOnly: true } as const;

/** Sessions are stored under a hash of the token, so the table never holds a usable cookie. */
const sessionId = hashToken;

/** Creates a session for the user and sets its cookie on the response being built. */
export const start = Effect.fn("Sessions.start")(function* (user: UserRepo.User) {
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* SessionRepo.SessionRepo;
  const token = yield* newToken(crypto);
  const now = yield* DateTime.now;
  yield* sessions.create({
    id: yield* sessionId(crypto, token),
    userId: user.id,
    username: user.username,
    createdAt: now,
    expiresAt: DateTime.addDuration(now, SESSION_LIFETIME),
  });
  yield* HttpApiBuilder.securitySetCookie(sessionCookie, Redacted.make(token), {
    ...cookieOptions,
    maxAge: SESSION_LIFETIME,
  });
  return { userId: user.id, username: user.username };
});

/** The ID of the request's session, from its cookie. */
export const currentId = Effect.fn("Sessions.currentId")(function* () {
  const crypto = yield* Crypto.Crypto;
  const token = Redacted.value(yield* HttpApiBuilder.securityDecode(sessionCookie));
  return yield* sessionId(crypto, token);
});

/** Deletes the request's session, if it has one, and expires the cookie either way. */
export const end = Effect.fn("Sessions.end")(function* () {
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* SessionRepo.SessionRepo;
  const token = Redacted.value(yield* HttpApiBuilder.securityDecode(sessionCookie));
  if (Str.isNonEmpty(token)) {
    yield* sessions.delete(yield* sessionId(crypto, token));
  }
  yield* HttpApiBuilder.securitySetCookie(sessionCookie, "", {
    ...cookieOptions,
    maxAge: Duration.zero,
  });
});

/**
 * The server side of `Authentication`: cookie → live session of an existing user → `CurrentUser`.
 * A session whose user is gone (an erased account) authenticates nothing, even before it is
 * deleted or expires.
 */
export const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const sessions = yield* SessionRepo.SessionRepo;
    const users = yield* UserRepo.UserRepo;
    return Authentication.of({
      session: Effect.fn("Authentication.session")(function* (httpEffect, { credential }) {
        const token = Redacted.value(credential);
        if (Str.isEmpty(token)) return yield* new Unauthenticated();
        const id = yield* Effect.orDie(sessionId(crypto, token));
        const session = yield* Effect.orDie(sessions.find(id));
        if (Option.isNone(session)) return yield* new Unauthenticated();
        const user = yield* Effect.orDie(users.findById(session.value.userId));
        if (Option.isNone(user)) return yield* new Unauthenticated();
        return yield* Effect.provideService(httpEffect, CurrentUser, {
          userId: session.value.userId,
          username: session.value.username,
        });
      }),
    });
  }),
);
