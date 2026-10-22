import {
  Api,
  CurrentUser,
  type PasskeyView,
  SessionNotFound,
  type SessionView,
} from "@alias/contracts";
import { PasskeyRepo, SessionRepo } from "@alias/db";
import * as Arr from "effect/Array";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/http-api";
import * as Sessions from "./Sessions.ts";

/**
 * The account's sessions and passkeys (PLAN.md §20.30, SR-25). Session-only, like the contract
 * says: a stolen token can't end the owner's sessions, and a stolen cookie that ends the others
 * only hastens what the owner would do.
 */

const passkeyView = (passkey: PasskeyRepo.Passkey): PasskeyView => ({
  id: passkey.id,
  createdAt: passkey.createdAt,
  lastUsedAt: passkey.lastUsedAt,
  transports: passkey.transports,
});

const sessions = Effect.fn("security.sessions")(function* () {
  const user = yield* CurrentUser;
  const repo = yield* SessionRepo.SessionRepo;
  const current = yield* Effect.orDie(Sessions.currentId());
  const live = yield* Effect.orDie(repo.list(user.userId));
  return Arr.map(live, (session): SessionView => ({
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    isCurrent: session.id === current,
  }));
});

/** Ends every session of the user but the one this request came with. */
const endOtherSessions = Effect.fn("security.endOtherSessions")(function* () {
  const user = yield* CurrentUser;
  const repo = yield* SessionRepo.SessionRepo;
  const current = yield* Effect.orDie(Sessions.currentId());
  const others = Arr.filter(yield* Effect.orDie(repo.list(user.userId)), (s) => s.id !== current);
  yield* Effect.forEach(others, (session) => Effect.orDie(repo.delete(session.id)), {
    concurrency: 5,
    discard: true,
  });
  return { ended: others.length };
});

/** What the security handlers use. The group captures them once, at startup. */
type SecurityServices = Crypto.Crypto | SessionRepo.SessionRepo | PasskeyRepo.PasskeyRepo;

export const SecurityLive = HttpApiBuilder.group(Api, "security", (handlers) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<SecurityServices>();
    const sessionRepo = yield* SessionRepo.SessionRepo;
    const passkeys = yield* PasskeyRepo.PasskeyRepo;
    return handlers
      .handle("sessions", () => Effect.provide(sessions(), services))
      .handle("endSession", ({ params }) =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => sessionRepo.deleteOwned(user.userId, params.sessionId)),
          Effect.catchTags({
            NoSuchSession: () => Effect.fail(new SessionNotFound({ sessionId: params.sessionId })),
            DatabaseError: Effect.die,
          }),
        ),
      )
      .handle("endOtherSessions", () => Effect.provide(endOtherSessions(), services))
      .handle("passkeys", () =>
        Effect.service(CurrentUser).pipe(
          Effect.flatMap((user) => Effect.orDie(passkeys.list(user.userId))),
          Effect.map(Arr.map(passkeyView)),
        ),
      );
  }),
);
