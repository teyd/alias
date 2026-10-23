import { Identities, Transport } from "@alias/aws";
import { InviteCode, SharedDomains, Username } from "@alias/core";
import {
  Api,
  CurrentUser,
  HumanCheckFailed,
  InvalidUsername,
  InviteRejected,
  PasskeyRejected,
  SignupUnavailable,
  TooManyAttempts,
  UsernameTaken,
} from "@alias/contracts";
import {
  AccountRepo,
  AliasRepo,
  ChallengeRepo,
  DomainRepo,
  InviteRepo,
  PasskeyRepo,
  RecipientRepo,
  type SessionRepo,
  SignupLimitRepo,
  UserRepo,
  UsernameRepo,
} from "@alias/db";
import { Inbox } from "@alias/inbox";
import { Turnstile } from "@alias/turnstile";
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
import { requireSameOrigin } from "./Authentication.ts";
import { clientSource } from "./ClientSource.ts";
import { SignupMode, hashCode } from "./Invites.ts";
import * as Passkeys from "./Passkeys.ts";
import { RelyingParty } from "./RelyingParty.ts";
import * as Sessions from "./Sessions.ts";
import { SignupLimits } from "./SignupLimits.ts";

/**
 * Sign-up and login calls must come from the web app itself (`Sec-Fetch-Site`, `Origin`, a JSON
 * body), as cookie-authenticated changes must (SR-14): otherwise any page could make its
 * visitors' browsers use up their address's challenge budget (PLAN.md §20.27).
 */
const fromWebApp = Effect.fn("auth.fromWebApp")(function* () {
  yield* requireSameOrigin((yield* RelyingParty).origin);
});

/**
 * Counts a sign-up or login challenge against the calling client, before anything else is read
 * or written: each challenge is an item until it is answered or expires, so this also bounds how
 * many one client can make the table hold (PLAN.md §20.27).
 */
const reserveChallenge = Effect.fn("auth.reserveChallenge")(function* () {
  const limits = yield* SignupLimits;
  const source = yield* clientSource();
  const now = yield* DateTime.now;
  const repo = yield* SignupLimitRepo.SignupLimitRepo;
  if (!(yield* Effect.orDie(repo.reserveChallenge(source, now, limits.challengesPerHour)))) {
    return yield* new TooManyAttempts();
  }
});

/** The Turnstile token must prove a human solved the widget; we fail closed without an answer. */
export const checkHuman = Effect.fn("auth.checkHuman")(function* (token: string) {
  const turnstile = yield* Turnstile.Turnstile;
  const verdict = yield* turnstile.verify(token).pipe(
    Effect.tapError((error) => Effect.logWarning("Turnstile unavailable", error.reason)),
    Effect.mapError(() => new SignupUnavailable({ reason: "human-check-unavailable" })),
  );
  if (Turnstile.Verdict.guards.NotHuman(verdict)) return yield* new HumanCheckFailed();
});

/**
 * While sign-up takes invites (PLAN.md §20.36), the hash of the code that came with it, once it is
 * found redeemable; None when sign-up is open. A code that redeems nothing (malformed, unknown,
 * revoked, expired, used up) counts against the client, and past the hourly limit every code is
 * refused unread, so codes can't be guessed in bulk. The code is redeemed only when the account is
 * created, in the same transaction (`register`).
 */
const checkInvite = Effect.fn("auth.checkInvite")(function* (typed: Option.Option<string>) {
  if ((yield* SignupMode) === "open") return Option.none<string>();
  const given = Option.filter(typed, (code) => code.trim() !== "");
  if (Option.isNone(given)) return yield* new InviteRejected({ reason: "missing" });
  const limits = yield* SignupLimits;
  const source = yield* clientSource();
  const now = yield* DateTime.now;
  const repo = yield* SignupLimitRepo.SignupLimitRepo;
  if ((yield* Effect.orDie(repo.inviteMisses(source, now))) >= limits.inviteMissesPerHour) {
    return yield* new TooManyAttempts();
  }
  const invites = yield* InviteRepo.InviteRepo;
  const found = yield* Option.match(InviteCode.normalize(given.value), {
    onNone: () => Effect.succeedNone,
    onSome: (code) =>
      Effect.flatMap(hashCode(code), (hash) =>
        Effect.map(Effect.orDie(invites.findRedeemable(hash, now)), Option.as(hash)),
      ),
  });
  if (Option.isNone(found)) {
    yield* Effect.orDie(repo.recordInviteMiss(source, now, limits.inviteMissesPerHour));
    return yield* new InviteRejected({ reason: "invalid" });
  }
  return found;
});

/**
 * One more account for this client today and for everyone this hour. The client's own limit goes
 * first, so a script hitting it can't also use up everyone's. An additional username counts as
 * one too (PLAN.md §20.34): it claims a name and a subdomain just as a sign-up does.
 */
export const reserveSignup = Effect.fn("auth.reserveSignup")(function* () {
  const limits = yield* SignupLimits;
  const source = yield* clientSource();
  const now = yield* DateTime.now;
  const repo = yield* SignupLimitRepo.SignupLimitRepo;
  if (!(yield* Effect.orDie(repo.reserveSignup(source, now, limits.signupsPerDay)))) {
    return yield* new TooManyAttempts();
  }
  if (!(yield* Effect.orDie(repo.reserveGlobalSignup(now, limits.signupsPerHour)))) {
    yield* Effect.logWarning(`sign-ups paused: ${limits.signupsPerHour} this hour`);
    return yield* new SignupUnavailable({ reason: "paused" });
  }
});

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
  | ChallengeRepo.ChallengeRepo
  | SignupLimitRepo.SignupLimitRepo
  | InviteRepo.InviteRepo
  | Turnstile.Turnstile;

/** Sign-up starts here: the Turnstile widget to solve first, and whether to ask for an invite. */
const signup = Effect.fn("auth.signup")(function* () {
  const turnstile = yield* Turnstile.Turnstile;
  return {
    turnstile: { siteKey: turnstile.siteKey, scriptUrl: turnstile.scriptUrl },
    isInviteRequired: (yield* SignupMode) === "invite",
  };
});

/**
 * A registration challenge for a free username, once a human solved the Turnstile widget and,
 * during the beta, with a redeemable invite code. The token is redeemed last, so a taken or
 * invalid username or a refused invite doesn't use it up.
 */
const registerOptions = Effect.fn("auth.registerOptions")(function* (payload: {
  readonly username: string;
  readonly turnstileToken: string;
  readonly inviteCode?: string;
}) {
  yield* fromWebApp();
  yield* reserveChallenge();
  const requested = payload.username;
  const username = yield* Username.parse(requested).pipe(
    Effect.mapError((error) => new InvalidUsername({ username: requested, reason: error.reason })),
  );
  const users = yield* UserRepo.UserRepo;
  if (yield* Effect.orDie(users.isUsernameTaken(username))) {
    return yield* new UsernameTaken({ username });
  }
  const invite = yield* checkInvite(Option.fromUndefinedOr(payload.inviteCode));
  yield* checkHuman(payload.turnstileToken);
  const crypto = yield* Crypto.Crypto;
  const userId = `usr_${(yield* Effect.orDie(crypto.randomULID)).toLowerCase()}`;
  const ceremony = ChallengeRepo.Registration({
    userId,
    username,
    ...Option.match(invite, { onNone: () => ({}), onSome: (inviteHash) => ({ inviteHash }) }),
  });
  return yield* issueChallenge(ceremony, (challenge) =>
    Passkeys.registrationOptions({ userId, username, challenge }),
  ).pipe(Effect.orDie);
});

const register = Effect.fn("auth.register")(function* (payload: {
  readonly challengeId: string;
  readonly credential: RegistrationResponseJSON;
}) {
  yield* fromWebApp();
  const { challenge, ceremony } = yield* takeChallenge(
    payload.challengeId,
    Option.liftPredicate(ChallengeRepo.isRegistration),
  );
  // A challenge issued before sign-up started taking invites can't skip one.
  const invite = Option.fromUndefinedOr(ceremony.inviteHash);
  if ((yield* SignupMode) === "invite" && Option.isNone(invite)) {
    return yield* new InviteRejected({ reason: "missing" });
  }
  const credential = yield* Passkeys.verifyRegistration({
    credential: payload.credential,
    expectedChallenge: challenge,
  });
  yield* reserveSignup();
  // Valid when the challenge was issued; parsing again only restores the brand.
  const username = yield* Effect.orDie(Username.parse(ceremony.username));
  const now = yield* DateTime.now;
  const user = { id: ceremony.userId, username, createdAt: now };
  const users = yield* UserRepo.UserRepo;
  yield* users
    .register(
      user,
      { ...credential, userId: user.id, createdAt: now, lastUsedAt: Option.none() },
      invite,
    )
    .pipe(
      Effect.catchTags({
        UsernameTaken: (error) => Effect.fail(new UsernameTaken({ username: error.username })),
        CredentialTaken: () => Effect.fail(new PasskeyRejected({ reason: "credential-taken" })),
        // Used up or revoked since the challenge was issued: the code is spent.
        InviteNotRedeemable: () => Effect.fail(new InviteRejected({ reason: "invalid" })),
        DatabaseError: Effect.die,
      }),
    );
  return yield* Effect.orDie(Sessions.start(user));
});

const loginOptions = Effect.fn("auth.loginOptions")(function* () {
  yield* fromWebApp();
  yield* reserveChallenge();
  return yield* issueChallenge(ChallengeRepo.Authentication(), Passkeys.authenticationOptions).pipe(
    Effect.orDie,
  );
});

/**
 * Logins with discoverable passkeys name no username, so the per-user throttle counts failed
 * assertions against the account whose passkey was presented. Credential IDs are never handed
 * out (no `allowCredentials`), so only someone holding one can lock its account for the hour.
 */
const throttled = Effect.fn("auth.throttled")(function* (userId: string) {
  const limits = yield* SignupLimits;
  const repo = yield* SignupLimitRepo.SignupLimitRepo;
  const failures = yield* Effect.orDie(repo.loginFailures(userId, yield* DateTime.now));
  if (failures >= limits.loginFailuresPerHour) return yield* new TooManyAttempts();
});

const recordFailure = Effect.fn("auth.recordFailure")(function* (userId: string) {
  const limits = yield* SignupLimits;
  const repo = yield* SignupLimitRepo.SignupLimitRepo;
  yield* Effect.orDie(
    repo.recordLoginFailure(userId, yield* DateTime.now, limits.loginFailuresPerHour),
  );
});

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
  yield* throttled(passkey.userId);
  if (Option.exists(claimedUser, (userId) => userId !== passkey.userId)) {
    yield* recordFailure(passkey.userId);
    return yield* unknownCredential;
  }
  const counter = yield* Passkeys.verifyAuthentication({
    credential: payload.credential,
    expectedChallenge: challenge,
    passkey,
  }).pipe(Effect.tapError(() => recordFailure(passkey.userId)));
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
  yield* fromWebApp();
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
  const additional = Arr.map(
    yield* Effect.orDie((yield* UsernameRepo.UsernameRepo).listByUser(user.userId)),
    (entry) => entry.username,
  );
  yield* Effect.orDie(
    (yield* AccountRepo.AccountRepo).erase({
      userId: user.userId,
      username: user.username,
      additionalUsernames: additional,
      subdomains: Arr.flatMap([user.username, ...additional], (username) =>
        Arr.map(shared, (domain) => `${username}.${domain}`),
      ),
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
      .handle("signup", () => Effect.provide(signup(), services))
      .handle("registerOptions", ({ payload }) =>
        Effect.provide(registerOptions(payload), services),
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
  | UsernameRepo.UsernameRepo
  | Inbox.Inbox;

export const AccountLive = HttpApiBuilder.group(Api, "account", (handlers) =>
  Effect.map(Effect.context<AccountServices>(), (services) =>
    handlers
      .handle("me", () => Effect.service(CurrentUser))
      .handle("eraseOptions", () => Effect.provide(eraseOptions(), services))
      .handle("erase", ({ payload }) => Effect.provide(erase(payload), services)),
  ),
);
