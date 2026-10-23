import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { Username } from "@alias/core";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { UserRepo, UsernameRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const MAX = 3;

const repos = Layer.mergeAll(UserRepo.layer, UsernameRepo.layer);

/** Signs `name` up as `userId`, as the API does: the user, the username's claim, a passkey. */
const signUp = Effect.fn("signUp")(function* (userId: string, name: string) {
  const users = yield* UserRepo.UserRepo;
  yield* users.register(
    { id: userId, username: yield* Username.parse(name), createdAt: at(1_000) },
    {
      id: `cred_${userId}`,
      userId,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: ["internal"],
      createdAt: at(1_000),
      lastUsedAt: Option.none(),
    },
  );
});

const add = Effect.fn("add")(function* (userId: string, name: string, createdAt = 2_000) {
  const usernames = yield* UsernameRepo.UsernameRepo;
  return yield* usernames.add(
    { userId, username: yield* Username.parse(name), createdAt: at(createdAt) },
    MAX,
  );
});

const additional = (
  userId: string,
  username: string,
  overrides: Partial<UsernameRepo.AdditionalUsername> = {},
): UsernameRepo.AdditionalUsername => ({
  username,
  userId,
  createdAt: at(2_000),
  isOnTheFlyEnabled: false,
  defaultRecipientId: Option.none(),
  ...overrides,
});

/**
 * Behaviour UsernameRepo (additional usernames, PLAN.md §20.34) must show on every DynamoDB
 * engine. Runners pass the emulator; each test gets its own table on it.
 */
export const usernameRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`UsernameRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepos = <A, E>(
        effect: Effect.Effect<A, E, UserRepo.UserRepo | UsernameRepo.UsernameRepo>,
      ) => effect.pipe(Effect.provide(repos.pipe(Layer.provide(freshTable()))));

      it.effect("finds the owner of an exact primary username, not of a lookalike", () =>
        withRepos(
          Effect.gen(function* () {
            const users = yield* UserRepo.UserRepo;
            const usernames = yield* UsernameRepo.UsernameRepo;
            yield* signUp("usr_1", "john");

            expect(yield* usernames.findOwner("john")).toEqual(
              Option.some({ userId: "usr_1", username: "john", additional: Option.none() }),
            );
            // Same skeleton ("0" looks like "o"), so taken, but a different username.
            expect(yield* users.isUsernameTaken(yield* Username.parse("j0hn"))).toBe(true);
            expect(yield* usernames.findOwner("j0hn")).toEqual(Option.none());
            expect(yield* usernames.findOwner("grace")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("adds usernames that are listed oldest first and resolve to their owner", () =>
        withRepos(
          Effect.gen(function* () {
            const users = yield* UserRepo.UserRepo;
            const usernames = yield* UsernameRepo.UsernameRepo;
            yield* signUp("usr_1", "ada");
            expect(yield* add("usr_1", "ada-work", 3_000)).toEqual(
              additional("usr_1", "ada-work", { createdAt: at(3_000) }),
            );
            yield* add("usr_1", "lovelace", 2_000);

            expect(Arr.map(yield* usernames.listByUser("usr_1"), (u) => u.username)).toEqual([
              "lovelace",
              "ada-work",
            ]);
            expect(yield* usernames.listByUser("usr_2")).toEqual([]);
            expect(yield* usernames.find("usr_1", "lovelace")).toEqual(
              Option.some(additional("usr_1", "lovelace")),
            );
            expect(yield* usernames.find("usr_2", "lovelace")).toEqual(Option.none());
            expect(yield* usernames.findOwner("lovelace")).toEqual(
              Option.some({
                userId: "usr_1",
                username: "lovelace",
                additional: Option.some(additional("usr_1", "lovelace")),
              }),
            );
            // Taken like a primary username, lookalikes included, and a lookalike finds no one.
            expect(yield* users.isUsernameTaken(yield* Username.parse("iovelace"))).toBe(true);
            expect(yield* usernames.findOwner("iovelace")).toEqual(Option.none());
            // The primary stays the user's login handle.
            expect(yield* users.findById("usr_1")).toEqual(
              Option.some({ id: "usr_1", username: "ada", createdAt: at(1_000) }),
            );
          }),
        ),
      );

      it.effect("shares one namespace with sign-up: no name or lookalike twice", () =>
        withRepos(
          Effect.gen(function* () {
            yield* signUp("usr_1", "ada");
            yield* signUp("usr_2", "grace");
            yield* add("usr_1", "lovelace");

            // Another user's primary, its lookalike, and someone's additional username.
            expect(yield* Effect.flip(add("usr_1", "grace"))).toEqual(
              new UserRepo.UsernameTaken({ username: "grace" }),
            );
            expect(yield* Effect.flip(add("usr_2", "lovelace"))).toEqual(
              new UserRepo.UsernameTaken({ username: "lovelace" }),
            );
            expect(yield* Effect.flip(add("usr_2", "iovelace"))).toEqual(
              new UserRepo.UsernameTaken({ username: "iovelace" }),
            );
            // The owner's own primary can't be added a second time either.
            expect(yield* Effect.flip(add("usr_1", "ada"))).toEqual(
              new UserRepo.UsernameTaken({ username: "ada" }),
            );
            // And sign-up can't take an additional username.
            expect(yield* Effect.flip(signUp("usr_3", "lovelace"))).toEqual(
              new UserRepo.UsernameTaken({ username: "lovelace" }),
            );
            const usernames = yield* UsernameRepo.UsernameRepo;
            expect(yield* usernames.listByUser("usr_2")).toEqual([]);
          }),
        ),
      );

      it.effect("lets one user have a username, even when two add it at once", () =>
        withRepos(
          Effect.gen(function* () {
            const results = yield* Effect.all(
              [Effect.result(add("usr_1", "shared")), Effect.result(add("usr_2", "shared"))],
              { concurrency: "unbounded" },
            );
            expect(Arr.length(Arr.filter(results, Result.isSuccess))).toBe(1);
            const usernames = yield* UsernameRepo.UsernameRepo;
            const owner = yield* usernames.findOwner("shared");
            expect(Option.isSome(owner)).toBe(true);
            const listed = [
              ...(yield* usernames.listByUser("usr_1")),
              ...(yield* usernames.listByUser("usr_2")),
            ];
            expect(Arr.map(listed, (u) => u.userId)).toEqual(
              Option.toArray(Option.map(owner, (found) => found.userId)),
            );
          }),
        ),
      );

      it.effect("caps additional usernames per user, atomically, and claims nothing past it", () =>
        withRepos(
          Effect.gen(function* () {
            const users = yield* UserRepo.UserRepo;
            const usernames = yield* UsernameRepo.UsernameRepo;
            const names = ["one-name", "two-name", "three-name", "four-name", "five-name"];
            const results = yield* Effect.forEach(
              names,
              (name) => Effect.result(add("usr_1", name)),
              {
                concurrency: "unbounded",
              },
            );
            expect(Arr.length(Arr.filter(results, Result.isSuccess))).toBe(MAX);
            expect(
              Arr.filter(
                Arr.getFailures(results),
                (error) => !(error instanceof UsernameRepo.TooManyUsernames),
              ),
            ).toEqual([]);
            expect(yield* usernames.listByUser("usr_1")).toHaveLength(MAX);
            // A refused name stays free for anyone.
            const refused = Arr.filter(names, (_, index) =>
              Option.exists(Arr.get(results, index), Result.isFailure),
            );
            const free = yield* Effect.forEach(
              refused,
              (name) => Effect.flatMap(Username.parse(name), users.isUsernameTaken),
              { concurrency: 1 },
            );
            expect(free).toEqual(Arr.map(refused, () => false));
            // Another user has a cap of their own.
            yield* add("usr_2", "six-name");
          }),
        ),
      );

      it.effect("changes only what's given, and only the owner's", () =>
        withRepos(
          Effect.gen(function* () {
            const usernames = yield* UsernameRepo.UsernameRepo;
            yield* signUp("usr_1", "ada");
            yield* add("usr_1", "ada-work");

            expect(
              yield* usernames.update("usr_1", "ada-work", {
                isOnTheFlyEnabled: Option.some(true),
                defaultRecipientId: Option.none(),
              }),
            ).toEqual(additional("usr_1", "ada-work", { isOnTheFlyEnabled: true }));
            expect(
              yield* usernames.update("usr_1", "ada-work", {
                isOnTheFlyEnabled: Option.none(),
                defaultRecipientId: Option.some(Option.some("rcp_1")),
              }),
            ).toEqual(
              additional("usr_1", "ada-work", {
                isOnTheFlyEnabled: true,
                defaultRecipientId: Option.some("rcp_1"),
              }),
            );
            expect(
              yield* usernames.update("usr_1", "ada-work", {
                isOnTheFlyEnabled: Option.none(),
                defaultRecipientId: Option.none(),
              }),
            ).toEqual(
              additional("usr_1", "ada-work", {
                isOnTheFlyEnabled: true,
                defaultRecipientId: Option.some("rcp_1"),
              }),
            );
            expect(
              yield* usernames.update("usr_1", "ada-work", {
                isOnTheFlyEnabled: Option.some(false),
                defaultRecipientId: Option.some(Option.none()),
              }),
            ).toEqual(additional("usr_1", "ada-work"));

            const missing = new UsernameRepo.NoSuchUsername({ username: "ada-work" });
            expect(
              yield* Effect.flip(
                usernames.update("usr_2", "ada-work", {
                  isOnTheFlyEnabled: Option.some(true),
                  defaultRecipientId: Option.none(),
                }),
              ),
            ).toEqual(missing);
            // The primary has no entry: its settings are the account's.
            expect(
              yield* Effect.flip(
                usernames.update("usr_1", "ada", {
                  isOnTheFlyEnabled: Option.some(true),
                  defaultRecipientId: Option.none(),
                }),
              ),
            ).toEqual(new UsernameRepo.NoSuchUsername({ username: "ada" }));
            expect(yield* usernames.find("usr_2", "ada-work")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("deletes a username for good, in two resumable steps that free its slot", () =>
        withRepos(
          Effect.gen(function* () {
            const users = yield* UserRepo.UserRepo;
            const usernames = yield* UsernameRepo.UsernameRepo;
            yield* signUp("usr_1", "ada");
            yield* add("usr_1", "ada-work");
            yield* add("usr_1", "ada-home", 2_001);
            yield* add("usr_1", "ada-club", 2_002);

            yield* usernames.retire("usr_1", "ada-work");
            // Nobody owns it any more, so its subdomain takes nothing new; it stays listed until
            // the deletion is done, and a second attempt goes through.
            expect(yield* usernames.findOwner("ada-work")).toEqual(Option.none());
            expect(Arr.map(yield* usernames.listByUser("usr_1"), (u) => u.username)).toContain(
              "ada-work",
            );
            yield* usernames.retire("usr_1", "ada-work");
            yield* usernames.remove("usr_1", "ada-work");

            expect(Arr.map(yield* usernames.listByUser("usr_1"), (u) => u.username)).toEqual([
              "ada-home",
              "ada-club",
            ]);
            expect(yield* usernames.find("usr_1", "ada-work")).toEqual(Option.none());
            const gone = new UsernameRepo.NoSuchUsername({ username: "ada-work" });
            expect(yield* Effect.flip(usernames.retire("usr_1", "ada-work"))).toEqual(gone);
            expect(yield* Effect.flip(usernames.remove("usr_1", "ada-work"))).toEqual(gone);
            // Never given out again: not to its owner, anyone else, or as a lookalike.
            expect(yield* users.isUsernameTaken(yield* Username.parse("ada-work"))).toBe(true);
            expect(yield* Effect.flip(add("usr_1", "ada-work"))).toEqual(
              new UserRepo.UsernameTaken({ username: "ada-work" }),
            );
            expect(yield* Effect.flip(add("usr_2", "adawork"))).toEqual(
              new UserRepo.UsernameTaken({ username: "adawork" }),
            );
            expect(yield* Effect.flip(signUp("usr_3", "ada-w0rk"))).toEqual(
              new UserRepo.UsernameTaken({ username: "ada-w0rk" }),
            );
            // Its slot is free again.
            yield* add("usr_1", "ada-shop");
          }),
        ),
      );

      it.effect("never deletes someone else's username or a primary one", () =>
        withRepos(
          Effect.gen(function* () {
            const usernames = yield* UsernameRepo.UsernameRepo;
            yield* signUp("usr_1", "ada");
            yield* signUp("usr_2", "grace");
            yield* add("usr_2", "grace-work");

            expect(yield* Effect.flip(usernames.retire("usr_1", "grace-work"))).toEqual(
              new UsernameRepo.NoSuchUsername({ username: "grace-work" }),
            );
            expect(yield* Effect.flip(usernames.retire("usr_1", "ada"))).toEqual(
              new UsernameRepo.NoSuchUsername({ username: "ada" }),
            );
            expect(yield* Effect.flip(usernames.remove("usr_1", "grace-work"))).toEqual(
              new UsernameRepo.NoSuchUsername({ username: "grace-work" }),
            );
            expect(Option.map(yield* usernames.findOwner("grace-work"), (o) => o.userId)).toEqual(
              Option.some("usr_2"),
            );
            expect(Option.map(yield* usernames.findOwner("ada"), (o) => o.userId)).toEqual(
              Option.some("usr_1"),
            );
          }),
        ),
      );
    });
  });
