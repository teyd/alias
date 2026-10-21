import { Username } from "@alias/core";
import {
  Api,
  CurrentUser,
  InvalidUsername,
  PasskeyRejected,
  UsernameTaken,
} from "@alias/contracts";
import { ChallengeRepo, PasskeyRepo, type SessionRepo, UserRepo } from "@alias/db";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import { HttpApiBuilder } from "effect/http-api";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Passkeys from "./Passkeys.ts";
import type { RelyingParty } from "./RelyingParty.ts";
import * as Sessions from "./Sessions.ts";

/** Issues a fresh single-use challenge and remembers what it was for. */
const issueChallenge = Effect.fn("auth.issueChallenge")(function* <A extends { challenge: string }>(
  ceremony: ChallengeRepo.Ceremony,
  makeOptions: (challenge: Uint8Array) => Effect.Effect<A, PasskeyRejected, RelyingParty>,
) {
  const crypto = yield* Crypto.Crypto;
  const challenges = yield* ChallengeRepo.ChallengeRepo;
  const challengeId = yield* crypto.randomUUIDv4();
  const options = yield* makeOptions(yield* crypto.randomBytes(32)).pipe(Effect.orDie);
  const now = yield* DateTime.now;
  yield* challenges.create({
    id: challengeId,
    challenge: options.challenge,
    ceremony,
    expiresAt: DateTime.addDuration(now, Duration.millis(Passkeys.CEREMONY_TIMEOUT_MILLIS)),
  });
  return { challengeId, options };
});

/** Takes the challenge if it is live and `select` accepts the ceremony it was issued for. */
const takeChallenge = Effect.fn("auth.takeChallenge")(function* <A>(
  id: string,
  select: (ceremony: ChallengeRepo.Ceremony) => Option.Option<A>,
) {
  const challenges = yield* ChallengeRepo.ChallengeRepo;
  const taken = yield* Effect.orDie(challenges.take(id));
  const matched = Option.flatMap(taken, (found) =>
    Option.map(select(found.ceremony), (ceremony) => ({ challenge: found.challenge, ceremony })),
  );
  return yield* Option.match(matched, {
    onNone: () => Effect.fail(new PasskeyRejected({ reason: "challenge-expired" })),
    onSome: Effect.succeed,
  });
});

/** What the auth handlers use. The group captures them once, at startup. */
type AuthServices =
  | Crypto.Crypto
  | RelyingParty
  | UserRepo.UserRepo
  | PasskeyRepo.PasskeyRepo
  | SessionRepo.SessionRepo
  | ChallengeRepo.ChallengeRepo;

const registerOptions = Effect.fn("auth.registerOptions")(function* (requested: string) {
  const username = yield* Username.parse(requested).pipe(
    Effect.mapError((error) => new InvalidUsername({ username: requested, reason: error.reason })),
  );
  const users = yield* UserRepo.UserRepo;
  if (yield* Effect.orDie(users.isUsernameTaken(username))) {
    return yield* new UsernameTaken({ username });
  }
  const crypto = yield* Crypto.Crypto;
  const userId = `usr_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`;
  return yield* issueChallenge(ChallengeRepo.Registration({ userId, username }), (challenge) =>
    Passkeys.registrationOptions({ userId, username, challenge }),
  ).pipe(Effect.orDie);
});

const register = Effect.fn("auth.register")(function* (payload: {
  readonly challengeId: string;
  readonly credential: RegistrationResponseJSON;
}) {
  const { challenge, ceremony } = yield* takeChallenge(
    payload.challengeId,
    Option.liftPredicate(ChallengeRepo.isRegistration),
  );
  const credential = yield* Passkeys.verifyRegistration({
    credential: payload.credential,
    expectedChallenge: challenge,
  });
  // Valid when the challenge was issued; parsing again only restores the brand.
  const username = yield* Effect.orDie(Username.parse(ceremony.username));
  const now = yield* DateTime.now;
  const user = { id: ceremony.userId, username, createdAt: now };
  const users = yield* UserRepo.UserRepo;
  yield* users.register(user, { ...credential, userId: user.id, createdAt: now }).pipe(
    Effect.catchTags({
      UsernameTaken: (error) => Effect.fail(new UsernameTaken({ username: error.username })),
      CredentialTaken: () => Effect.fail(new PasskeyRejected({ reason: "credential-taken" })),
      DatabaseError: Effect.die,
    }),
  );
  return yield* Effect.orDie(Sessions.start(user));
});

const loginOptions = () =>
  issueChallenge(ChallengeRepo.Authentication(), Passkeys.authenticationOptions).pipe(Effect.orDie);

const login = Effect.fn("auth.login")(function* (payload: {
  readonly challengeId: string;
  readonly credential: AuthenticationResponseJSON;
}) {
  const { challenge } = yield* takeChallenge(
    payload.challengeId,
    Option.liftPredicate(ChallengeRepo.isAuthentication),
  );
  const unknownCredential = new PasskeyRejected({ reason: "unknown-credential" });
  const orUnknown = <A>(found: Option.Option<A>) =>
    Option.match(found, { onNone: () => Effect.fail(unknownCredential), onSome: Effect.succeed });

  const passkeys = yield* PasskeyRepo.PasskeyRepo;
  const passkey = yield* Effect.flatMap(
    Effect.orDie(passkeys.findById(payload.credential.id)),
    orUnknown,
  );
  // A discoverable credential names its user; it must be the one the passkey belongs to.
  const claimedUser = Option.map(
    Option.fromUndefinedOr(payload.credential.response.userHandle),
    (handle) => Result.getOrElse(Base64Url.decodeString(handle), () => ""),
  );
  if (Option.exists(claimedUser, (userId) => userId !== passkey.userId)) {
    return yield* unknownCredential;
  }
  const counter = yield* Passkeys.verifyAuthentication({
    credential: payload.credential,
    expectedChallenge: challenge,
    passkey,
  });
  yield* passkeys.recordUse(passkey.id, counter).pipe(
    Effect.catchTags({
      PasskeyNotFound: () => Effect.fail(unknownCredential),
      DatabaseError: Effect.die,
    }),
  );
  const users = yield* UserRepo.UserRepo;
  const user = yield* Effect.flatMap(Effect.orDie(users.findById(passkey.userId)), orUnknown);
  return yield* Effect.orDie(Sessions.start(user));
});

export const AuthLive = HttpApiBuilder.group(Api, "auth", (handlers) =>
  Effect.map(Effect.context<AuthServices>(), (services) =>
    handlers
      .handle("registerOptions", ({ payload }) =>
        Effect.provide(registerOptions(payload.username), services),
      )
      .handle("register", ({ payload }) => Effect.provide(register(payload), services))
      .handle("loginOptions", () => Effect.provide(loginOptions(), services))
      .handle("login", ({ payload }) => Effect.provide(login(payload), services))
      .handle("logout", () => Effect.provide(Effect.orDie(Sessions.end()), services)),
  ),
);

export const AccountLive = HttpApiBuilder.group(Api, "account", (handlers) =>
  handlers.handle("me", () => Effect.service(CurrentUser)),
);
