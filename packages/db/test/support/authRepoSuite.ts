import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { Username } from "@alias/core";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  ChallengeRepo,
  PasskeyRepo,
  SessionRepo,
  SignupLimitRepo,
  UserRepo,
} from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const passkey = (overrides: Partial<PasskeyRepo.Passkey> = {}): PasskeyRepo.Passkey => ({
  id: "cred_1",
  userId: "usr_1",
  publicKey: new Uint8Array([1, 2, 3, 250]),
  counter: 0,
  transports: ["internal", "hybrid"],
  createdAt: at(1_000),
  lastUsedAt: Option.none(),
  ...overrides,
});

const user = (username: string, id = "usr_1") =>
  Effect.map(Username.parse(username), (parsed) => ({
    id,
    username: parsed,
    createdAt: at(1_000),
  }));

const repos = Layer.mergeAll(
  UserRepo.layer,
  PasskeyRepo.layer,
  SessionRepo.layer,
  ChallengeRepo.layer,
  SignupLimitRepo.layer,
);

type Repos =
  | UserRepo.UserRepo
  | PasskeyRepo.PasskeyRepo
  | SessionRepo.SessionRepo
  | ChallengeRepo.ChallengeRepo
  | SignupLimitRepo.SignupLimitRepo;

/**
 * Behaviour the user, passkey, session, challenge and sign-up limit repositories must show on every DynamoDB
 * engine. Runners pass the emulator; each test gets its own table on it.
 */
export const authRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`auth repositories (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepos = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
        effect.pipe(Effect.provide(repos.pipe(Layer.provide(freshTable()))));

      describe("UserRepo", () => {
        it.effect("registers a user with their first passkey", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              const passkeys = yield* PasskeyRepo.PasskeyRepo;
              yield* users.register(yield* user("ada"), passkey(), Option.none());

              expect(yield* users.findById("usr_1")).toEqual(
                Option.some({ id: "usr_1", username: "ada", createdAt: at(1_000) }),
              );
              expect(yield* passkeys.findById("cred_1")).toEqual(Option.some(passkey()));
              expect(yield* users.isUsernameTaken(yield* Username.parse("ada"))).toBe(true);
              expect(yield* users.isUsernameTaken(yield* Username.parse("grace"))).toBe(false);
            }),
          ),
        );

        it.effect("rejects a taken username and its lookalikes, writing nothing", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              const passkeys = yield* PasskeyRepo.PasskeyRepo;
              yield* users.register(yield* user("john"), passkey(), Option.none());

              const error = yield* Effect.flip(
                users.register(
                  yield* user("j0hn", "usr_2"),
                  passkey({ id: "cred_2" }),
                  Option.none(),
                ),
              );
              expect(error).toEqual(new UserRepo.UsernameTaken({ username: "j0hn" }));
              expect(yield* users.isUsernameTaken(yield* Username.parse("jo-hn"))).toBe(true);
              // The transaction left no half-registered user or orphaned passkey behind.
              expect(Option.isNone(yield* users.findById("usr_2"))).toBe(true);
              expect(Option.isNone(yield* passkeys.findById("cred_2"))).toBe(true);
            }),
          ),
        );

        it.effect("rejects a credential ID that is already registered", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              yield* users.register(yield* user("ada"), passkey(), Option.none());

              const error = yield* Effect.flip(
                users.register(
                  yield* user("grace", "usr_2"),
                  passkey({ userId: "usr_2" }),
                  Option.none(),
                ),
              );
              expect(error).toEqual(new UserRepo.CredentialTaken({ credentialId: "cred_1" }));
              expect(yield* users.isUsernameTaken(yield* Username.parse("grace"))).toBe(false);
            }),
          ),
        );
      });

      describe("UserRepo lookups and settings", () => {
        const defaults: UserRepo.UserSettings = {
          isOnTheFlyEnabled: false,
          imageProtection: "block-trackers",
          isLinkCleaningEnabled: false,
          isFailedMailKept: false,
        };

        it.effect("starts with on-the-fly aliases off and stores the user's choice", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              yield* users.register(yield* user("ada"), passkey(), Option.none());
              expect(yield* users.settings("usr_1")).toEqual(defaults);

              const onTheFly = { ...defaults, isOnTheFlyEnabled: true };
              expect(yield* users.updateSettings("usr_1", { isOnTheFlyEnabled: true })).toEqual(
                onTheFly,
              );
              expect(yield* users.updateSettings("usr_1", {})).toEqual(onTheFly);
              expect(yield* users.settings("usr_1")).toEqual(onTheFly);
              expect(yield* users.settings("usr_2")).toEqual(defaults);

              yield* users.updateSettings("usr_1", { isOnTheFlyEnabled: false });
              expect(yield* users.settings("usr_1")).toEqual(defaults);
              // Settings sit next to the user without disturbing it.
              expect(yield* users.findById("usr_1")).toEqual(
                Option.some(expect.objectContaining({ username: "ada" })),
              );
            }),
          ),
        );

        it.effect("blocks trackers until told otherwise, and cleans links only when asked", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              yield* users.register(yield* user("ada"), passkey(), Option.none());

              const changed = yield* users.updateSettings("usr_1", {
                imageProtection: "off",
                isLinkCleaningEnabled: true,
              });
              expect(changed).toEqual({
                ...defaults,
                imageProtection: "off",
                isLinkCleaningEnabled: true,
              });
              // Changing one setting keeps the others.
              expect(yield* users.updateSettings("usr_1", { isOnTheFlyEnabled: true })).toEqual({
                ...changed,
                isOnTheFlyEnabled: true,
              });
              expect(
                yield* users.updateSettings("usr_1", { imageProtection: "proxy-images" }),
              ).toEqual({ ...changed, isOnTheFlyEnabled: true, imageProtection: "proxy-images" });
              expect(yield* users.settings("usr_2")).toEqual(defaults);
            }),
          ),
        );
      });

      describe("PasskeyRepo", () => {
        it.effect("records the signature counter and time of the last login", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              const passkeys = yield* PasskeyRepo.PasskeyRepo;
              yield* users.register(yield* user("ada"), passkey(), Option.none());

              yield* passkeys.recordUse("cred_1", 7, at(5_000));
              expect(yield* passkeys.findById("cred_1")).toEqual(
                Option.some(passkey({ counter: 7, lastUsedAt: Option.some(at(5_000)) })),
              );
            }),
          ),
        );

        // SR-26 (PLAN.md §20.25): two racing assertions must not both pass.
        it.effect("refuses a counter that doesn't go up, unless the passkey doesn't count", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              const passkeys = yield* PasskeyRepo.PasskeyRepo;
              yield* users.register(yield* user("ada"), passkey(), Option.none());
              yield* users.register(
                yield* user("grace", "usr_2"),
                passkey({ id: "cred_2", userId: "usr_2" }),
                Option.none(),
              );
              yield* passkeys.recordUse("cred_1", 7, at(5_000));
              const refused = new PasskeyRepo.CounterNotIncreased({ credentialId: "cred_1" });
              expect(yield* Effect.flip(passkeys.recordUse("cred_1", 7, at(6_000)))).toEqual(
                refused,
              );
              expect(yield* Effect.flip(passkeys.recordUse("cred_1", 6, at(6_000)))).toEqual(
                refused,
              );
              expect(
                Option.map(yield* passkeys.findById("cred_1"), (found) => found.counter),
              ).toEqual(Option.some(7));
              yield* passkeys.recordUse("cred_1", 8, at(7_000));
              // Most passkeys report 0 every time.
              yield* passkeys.recordUse("cred_2", 0, at(5_000));
              yield* passkeys.recordUse("cred_2", 0, at(6_000));
              expect(
                Option.map(yield* passkeys.findById("cred_2"), (found) => found.lastUsedAt),
              ).toEqual(Option.some(Option.some(at(6_000))));
            }),
          ),
        );

        it.effect("lists a user's passkeys, oldest first, and no one else's", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              const passkeys = yield* PasskeyRepo.PasskeyRepo;
              yield* users.register(
                yield* user("ada"),
                passkey({ createdAt: at(2_000) }),
                Option.none(),
              );
              yield* users.register(
                yield* user("grace", "usr_2"),
                passkey({ id: "cred_2", userId: "usr_2" }),
                Option.none(),
              );
              expect(yield* passkeys.list("usr_1")).toEqual([passkey({ createdAt: at(2_000) })]);
              expect(yield* passkeys.list("usr_3")).toEqual([]);
            }),
          ),
        );

        it.effect("fails to record a use of an unknown passkey instead of creating it", () =>
          withRepos(
            Effect.gen(function* () {
              const passkeys = yield* PasskeyRepo.PasskeyRepo;
              const error = yield* Effect.flip(passkeys.recordUse("cred_missing", 1, at(1)));
              expect(error).toEqual(
                new PasskeyRepo.PasskeyNotFound({ credentialId: "cred_missing" }),
              );
              expect(Option.isNone(yield* passkeys.findById("cred_missing"))).toBe(true);
            }),
          ),
        );
      });

      describe("SessionRepo", () => {
        const session: SessionRepo.Session = {
          id: "hash_1",
          userId: "usr_1",
          username: "ada",
          createdAt: at(0),
          expiresAt: at(60_000),
        };

        it.effect("finds a live session and forgets it after delete", () =>
          withRepos(
            Effect.gen(function* () {
              const sessions = yield* SessionRepo.SessionRepo;
              yield* sessions.create(session);
              expect(yield* sessions.find("hash_1")).toEqual(Option.some(session));

              yield* sessions.delete("hash_1");
              expect(Option.isNone(yield* sessions.find("hash_1"))).toBe(true);
              // Logging out twice is fine.
              yield* sessions.delete("hash_1");
            }),
          ),
        );

        it.effect("lists a user's live sessions and deletes only their own", () =>
          withRepos(
            Effect.gen(function* () {
              const sessions = yield* SessionRepo.SessionRepo;
              yield* sessions.create({ ...session, id: "hash_2", createdAt: at(10) });
              yield* sessions.create(session);
              yield* sessions.create({ ...session, id: "hash_3", expiresAt: at(30_000) });
              yield* sessions.create({ ...session, id: "hash_9", userId: "usr_2" });
              yield* TestClock.setTime(30_000);
              const ids = (found: ReadonlyArray<SessionRepo.Session>) => found.map((one) => one.id);
              expect(ids(yield* sessions.list("usr_1"))).toEqual(["hash_1", "hash_2"]);

              const notTheirs = yield* Effect.flip(sessions.deleteOwned("usr_1", "hash_9"));
              expect(notTheirs).toEqual(new SessionRepo.NoSuchSession({ sessionId: "hash_9" }));
              expect(Option.isSome(yield* sessions.find("hash_9"))).toBe(true);
              const gone = yield* Effect.flip(sessions.deleteOwned("usr_1", "hash_missing"));
              expect(gone._tag).toBe("NoSuchSession");
              yield* sessions.deleteOwned("usr_1", "hash_2");
              expect(ids(yield* sessions.list("usr_1"))).toEqual(["hash_1"]);
            }),
          ),
        );

        it.effect("ignores an expired session that TTL has not deleted yet", () =>
          withRepos(
            Effect.gen(function* () {
              const sessions = yield* SessionRepo.SessionRepo;
              yield* sessions.create(session);
              yield* TestClock.setTime(59_999);
              expect(Option.isSome(yield* sessions.find("hash_1"))).toBe(true);
              yield* TestClock.setTime(60_000);
              expect(Option.isNone(yield* sessions.find("hash_1"))).toBe(true);
            }),
          ),
        );
      });

      describe("ChallengeRepo", () => {
        const challenge: ChallengeRepo.Challenge = {
          id: "ch_1",
          challenge: "c2lnbiBtZQ",
          ceremony: ChallengeRepo.Registration({ userId: "usr_1", username: "ada" }),
          expiresAt: at(300_000),
        };

        it.effect("hands out a challenge exactly once", () =>
          withRepos(
            Effect.gen(function* () {
              const challenges = yield* ChallengeRepo.ChallengeRepo;
              yield* challenges.create(challenge);
              yield* challenges.create({
                ...challenge,
                id: "ch_2",
                ceremony: ChallengeRepo.Authentication(),
              });

              expect(yield* challenges.take("ch_1")).toEqual(Option.some(challenge));
              expect(Option.isNone(yield* challenges.take("ch_1"))).toBe(true);
              expect(
                Option.map(yield* challenges.take("ch_2"), (taken) => taken.ceremony._tag),
              ).toEqual(Option.some("Authentication"));
            }),
          ),
        );

        it.effect("ignores an expired challenge that TTL has not deleted yet", () =>
          withRepos(
            Effect.gen(function* () {
              const challenges = yield* ChallengeRepo.ChallengeRepo;
              yield* challenges.create(challenge);
              yield* TestClock.setTime(300_000);
              expect(Option.isNone(yield* challenges.take("ch_1"))).toBe(true);
            }),
          ),
        );
      });

      describe("SignupLimitRepo", () => {
        const hour = 3_600_000;

        it.effect("counts challenges per client and UTC hour, up to the limit", () =>
          withRepos(
            Effect.gen(function* () {
              const limits = yield* SignupLimitRepo.SignupLimitRepo;
              const now = at(10 * hour);
              expect(yield* limits.reserveChallenge("src", now, 2)).toBe(true);
              expect(yield* limits.reserveChallenge("src", at(10 * hour + 59 * 60_000), 2)).toBe(
                true,
              );
              expect(yield* limits.reserveChallenge("src", now, 2)).toBe(false);
              expect(yield* limits.reserveChallenge("other", now, 2)).toBe(true);
              // The next hour is a fresh window.
              expect(yield* limits.reserveChallenge("src", at(11 * hour), 2)).toBe(true);
            }),
          ),
        );

        it.effect("counts sign-ups per client and UTC day, apart from challenges", () =>
          withRepos(
            Effect.gen(function* () {
              const limits = yield* SignupLimitRepo.SignupLimitRepo;
              const now = at(10 * hour);
              expect(yield* limits.reserveChallenge("src", now, 1)).toBe(true);
              expect(yield* limits.reserveSignup("src", now, 1)).toBe(true);
              expect(yield* limits.reserveSignup("src", at(23 * hour), 1)).toBe(false);
              expect(yield* limits.reserveSignup("other", now, 1)).toBe(true);
              expect(yield* limits.reserveSignup("src", at(24 * hour), 1)).toBe(true);
            }),
          ),
        );

        it.effect("counts every client's sign-ups in one hourly counter", () =>
          withRepos(
            Effect.gen(function* () {
              const limits = yield* SignupLimitRepo.SignupLimitRepo;
              const now = at(10 * hour);
              expect(yield* limits.reserveGlobalSignup(now, 2)).toBe(true);
              expect(yield* limits.reserveGlobalSignup(now, 2)).toBe(true);
              expect(yield* limits.reserveGlobalSignup(now, 2)).toBe(false);
              expect(yield* limits.reserveGlobalSignup(at(11 * hour), 2)).toBe(true);
            }),
          ),
        );

        it.effect("concurrent reservations never pass the limit", () =>
          withRepos(
            Effect.gen(function* () {
              const limits = yield* SignupLimitRepo.SignupLimitRepo;
              const now = at(10 * hour);
              const granted = yield* Effect.forEach(
                Array.from({ length: 12 }, () => now),
                (at) => limits.reserveGlobalSignup(at, 5),
                { concurrency: "unbounded" },
              );
              expect(granted.filter(Boolean)).toHaveLength(5);
            }),
          ),
        );

        it.effect("counts failed logins per account and hour, stopping at the limit", () =>
          withRepos(
            Effect.gen(function* () {
              const limits = yield* SignupLimitRepo.SignupLimitRepo;
              const now = at(10 * hour);
              expect(yield* limits.loginFailures("usr_1", now)).toBe(0);
              yield* limits.recordLoginFailure("usr_1", now, 2);
              yield* limits.recordLoginFailure("usr_1", now, 2);
              yield* limits.recordLoginFailure("usr_1", now, 2);
              expect(yield* limits.loginFailures("usr_1", now)).toBe(2);
              expect(yield* limits.loginFailures("usr_2", now)).toBe(0);
              expect(yield* limits.loginFailures("usr_1", at(11 * hour))).toBe(0);
            }),
          ),
        );
      });
    });
  });
