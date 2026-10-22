import { Identities, Transport } from "@alias/aws";
import { SharedDomains, Username } from "@alias/core";
import {
  Api,
  CurrentUser,
  InvalidUsername,
  PasskeyRejected,
  UsernameTaken,
} from "@alias/contracts";
import {
  AccountRepo,
  AliasRepo,
  ChallengeRepo,
  DomainRepo,
  PasskeyRepo,
  RecipientRepo,
  type SessionRepo,
  UserRepo,
} from "@alias/db";
import { Inbox } from "@alias/inbox";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import * as Arr from "effect/Array";
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
  yield* users
    .register(user, {
      ...credential,
      userId: user.id,
      createdAt: now,
      lastUsedAt: Option.none(),
    })
    .pipe(
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

/**
 * Verifies a passkey assertion answering the challenge `select` accepts, and returns the passkey
 * with its new signature counter recorded.
 */
const assertPasskey = Effect.fn("auth.assertPasskey")(function* (
  payload: { readonly challengeId: string; readonly credential: AuthenticationResponseJSON },
  select: (ceremony: ChallengeRepo.Ceremony) => Option.Option<ChallengeRepo.Ceremony>,
) {
  const { challenge } = yield* takeChallenge(payload.challengeId, select);
  const unknownCredential = new PasskeyRejected({ reason: "unknown-credential" });
  const passkeys = yield* PasskeyRepo.PasskeyRepo;
  const passkey = yield* Effect.flatMap(
    Effect.orDie(passkeys.findById(payload.credential.id)),
    (found) =>
      Option.match(found, { onNone: () => Effect.fail(unknownCredential), onSome: Effect.succeed }),
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
  yield* passkeys.recordUse(passkey.id, counter, yield* DateTime.now).pipe(
    Effect.catchTags({
      PasskeyNotFound: () => Effect.fail(unknownCredential),
      // A racing assertion with a higher counter won, or the credential is cloned.
      CounterNotIncreased: () =>
        Effect.fail(new PasskeyRejected({ reason: "verification-failed" })),
      DatabaseError: Effect.die,
    }),
  );
  return passkey;
});

const login = Effect.fn("auth.login")(function* (payload: {
  readonly challengeId: string;
  readonly credential: AuthenticationResponseJSON;
}) {
  const passkey = yield* assertPasskey(
    payload,
    Option.liftPredicate(ChallengeRepo.isAuthentication),
  );
  const users = yield* UserRepo.UserRepo;
  const user = yield* Effect.flatMap(Effect.orDie(users.findById(passkey.userId)), (found) =>
    Option.match(found, {
      onNone: () => Effect.fail(new PasskeyRejected({ reason: "unknown-credential" })),
      onSome: Effect.succeed,
    }),
  );
  return yield* Effect.orDie(Sessions.start(user));
});

/** A challenge only the signed-in user can answer, to confirm erasing their account. */
const eraseOptions = Effect.fn("auth.eraseOptions")(function* () {
  const user = yield* CurrentUser;
  return yield* issueChallenge(
    ChallengeRepo.Erasure(user.userId),
    Passkeys.authenticationOptions,
  ).pipe(Effect.orDie);
});

/**
 * Erases the signed-in account (PLAN.md §20.15) once a passkey of that account answered an
 * erasure challenge issued to it. The recipients' addresses come off SES's suppression list first:
 * they are personal data too, and a retry after a failure later on finds them again.
 */
const erase = Effect.fn("auth.erase")(function* (payload: {
  readonly challengeId: string;
  readonly credential: AuthenticationResponseJSON;
}) {
  const user = yield* CurrentUser;
  const passkey = yield* assertPasskey(
    payload,
    Option.liftPredicate(
      (ceremony) => ChallengeRepo.isErasure(ceremony) && ceremony.userId === user.userId,
    ),
  );
  // Someone else's passkey proves nothing about this account.
  if (passkey.userId !== user.userId) {
    return yield* new PasskeyRejected({ reason: "unknown-credential" });
  }
  const recipients = yield* Effect.orDie((yield* RecipientRepo.RecipientRepo).list(user.userId));
  const transport = yield* Transport.Transport;
  yield* Effect.forEach(recipients, (recipient) => transport.unsuppress(recipient.address), {
    concurrency: 4,
    discard: true,
  }).pipe(Effect.orDie);
  // Custom domains' SES identities first: the sweep deletes the claims that name them.
  const domains = yield* Effect.orDie((yield* DomainRepo.DomainRepo).listByUser(user.userId));
  const identities = yield* Identities.Identities;
  yield* Effect.forEach(domains, (domain) => identities.delete(domain.domain), {
    concurrency: 4,
    discard: true,
  }).pipe(Effect.orDie);
  // Their aliases' ids, for the stored mail in S3: erasure removes the aliases from the table.
  const aliases = yield* Effect.orDie((yield* AliasRepo.AliasRepo).listByUser(user.userId));
  const shared = yield* SharedDomains.SharedDomains;
  yield* Effect.orDie(
    (yield* AccountRepo.AccountRepo).erase({
      userId: user.userId,
      username: user.username,
      subdomains: Arr.map(shared, (domain) => `${user.username}.${domain}`),
      customDomains: Arr.map(domains, (domain) => domain.domain),
      sessionId: yield* Effect.orDie(Sessions.currentId()),
    }),
  );
  // The table no longer holds the data keys, so what is left in S3 can't be read; it goes too.
  // Bodies of aliases deleted before were purged with them.
  const inbox = yield* Inbox.Inbox;
  yield* Effect.forEach(aliases, (alias) => Effect.orDie(inbox.purge(alias.id)), {
    concurrency: 4,
    discard: true,
  });
  yield* Effect.orDie(Sessions.end());
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

/** What the account handlers use beyond the auth ones. */
type AccountServices =
  | AuthServices
  | RecipientRepo.RecipientRepo
  | AccountRepo.AccountRepo
  | DomainRepo.DomainRepo
  | Identities.Identities
  | Transport.Transport
  | SharedDomains.SharedDomains
  | AliasRepo.AliasRepo
  | Inbox.Inbox;

export const AccountLive = HttpApiBuilder.group(Api, "account", (handlers) =>
  Effect.map(Effect.context<AccountServices>(), (services) =>
    handlers
      .handle("me", () => Effect.service(CurrentUser))
      .handle("eraseOptions", () => Effect.provide(eraseOptions(), services))
      .handle("erase", ({ payload }) => Effect.provide(erase(payload), services)),
  ),
);
