import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { Username } from "@alias/core";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { ChallengeRepo, PasskeyRepo, SessionRepo, UserRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const passkey = (overrides: Partial<PasskeyRepo.Passkey> = {}): PasskeyRepo.Passkey => ({
  id: "cred_1",
  userId: "usr_1",
  publicKey: new Uint8Array([1, 2, 3, 250]),
  counter: 0,
  transports: ["internal", "hybrid"],
  createdAt: at(1_000),
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
);

type Repos =
  | UserRepo.UserRepo
  | PasskeyRepo.PasskeyRepo
  | SessionRepo.SessionRepo
  | ChallengeRepo.ChallengeRepo;

/**
 * Behaviour the user, passkey, session and challenge repositories must show on every DynamoDB
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
              yield* users.register(yield* user("ada"), passkey());

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
              yield* users.register(yield* user("john"), passkey());

              const error = yield* Effect.flip(
                users.register(yield* user("j0hn", "usr_2"), passkey({ id: "cred_2" })),
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
              yield* users.register(yield* user("ada"), passkey());

              const error = yield* Effect.flip(
                users.register(yield* user("grace", "usr_2"), passkey({ userId: "usr_2" })),
              );
              expect(error).toEqual(new UserRepo.CredentialTaken({ credentialId: "cred_1" }));
              expect(yield* users.isUsernameTaken(yield* Username.parse("grace"))).toBe(false);
            }),
          ),
        );
      });

      describe("UserRepo lookups and settings", () => {
        it.effect("finds a user by their exact username, not by a lookalike", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              yield* users.register(yield* user("john"), passkey());

              expect(yield* users.findByUsername("john")).toEqual(
                Option.some({ id: "usr_1", username: "john", createdAt: at(1_000) }),
              );
              // Same skeleton ("0" looks like "o"), so taken, but a different username.
              expect(yield* users.isUsernameTaken(yield* Username.parse("j0hn"))).toBe(true);
              expect(yield* users.findByUsername("j0hn")).toEqual(Option.none());
              expect(yield* users.findByUsername("grace")).toEqual(Option.none());
            }),
          ),
        );

        const defaults: UserRepo.UserSettings = {
          isOnTheFlyEnabled: false,
          imageProtection: "block-trackers",
          isLinkCleaningEnabled: false,
        };

        it.effect("starts with on-the-fly aliases off and stores the user's choice", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              yield* users.register(yield* user("ada"), passkey());
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
              yield* users.register(yield* user("ada"), passkey());

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
        it.effect("records the signature counter of the last login", () =>
          withRepos(
            Effect.gen(function* () {
              const users = yield* UserRepo.UserRepo;
              const passkeys = yield* PasskeyRepo.PasskeyRepo;
              yield* users.register(yield* user("ada"), passkey());

              yield* passkeys.recordUse("cred_1", 7);
              expect(yield* passkeys.findById("cred_1")).toEqual(
                Option.some(passkey({ counter: 7 })),
              );
            }),
          ),
        );

        it.effect("fails to record a use of an unknown passkey instead of creating it", () =>
          withRepos(
            Effect.gen(function* () {
              const passkeys = yield* PasskeyRepo.PasskeyRepo;
              const error = yield* Effect.flip(passkeys.recordUse("cred_missing", 1));
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
    });
  });
