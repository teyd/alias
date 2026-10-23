import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { Username } from "@alias/core";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { InviteRepo, PasskeyRepo, SignupLimitRepo, UserRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);
const DAY = 86_400_000;

const invite = (overrides: Partial<Omit<InviteRepo.Invite, "uses">> = {}) => ({
  hash: "a".repeat(64),
  note: Option.some("beta batch 1"),
  maxUses: 1,
  createdAt: at(DAY),
  expiresAt: at(8 * DAY),
  ...overrides,
});

/** A new user `usr_<n>` named `user-<n>` with passkey `cred_<n>`, registered at `createdAt`. */
const signUp = (n: number, createdAt: DateTime.Utc, inviteHash: Option.Option<string>) =>
  Effect.gen(function* () {
    const users = yield* UserRepo.UserRepo;
    const username = yield* Username.parse(`user-${n}`);
    yield* users.register(
      { id: `usr_${n}`, username, createdAt },
      {
        id: `cred_${n}`,
        userId: `usr_${n}`,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ["internal"],
        createdAt,
        lastUsedAt: Option.none(),
      },
      inviteHash,
    );
  });

const repos = Layer.mergeAll(
  InviteRepo.layer,
  UserRepo.layer,
  PasskeyRepo.layer,
  SignupLimitRepo.layer,
);

type Repos =
  | InviteRepo.InviteRepo
  | UserRepo.UserRepo
  | PasskeyRepo.PasskeyRepo
  | SignupLimitRepo.SignupLimitRepo;

/**
 * Invite codes (PLAN.md §20.36) on every DynamoDB engine: lookups that ignore expired and used-up
 * codes, and redemption in the transaction that creates the user. Each test gets its own table.
 */
export const inviteRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`InviteRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepos = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
        effect.pipe(Effect.provide(repos.pipe(Layer.provide(freshTable()))));

      it.effect("finds an invite until it expires, and lists every one oldest first", () =>
        withRepos(
          Effect.gen(function* () {
            const invites = yield* InviteRepo.InviteRepo;
            yield* invites.create(invite());
            yield* invites.create(
              invite({ hash: "b".repeat(64), note: Option.none(), maxUses: 5, createdAt: at(0) }),
            );

            expect(yield* invites.findRedeemable("a".repeat(64), at(2 * DAY))).toEqual(
              Option.some({ ...invite(), uses: 0 }),
            );
            // Expired but not yet deleted by TTL (DynamoDB Local never runs it): ignored.
            expect(yield* invites.findRedeemable("a".repeat(64), at(8 * DAY))).toEqual(
              Option.none(),
            );
            expect(yield* invites.findRedeemable("c".repeat(64), at(2 * DAY))).toEqual(
              Option.none(),
            );
            expect(Arr.map(yield* invites.list(), (found) => found.hash)).toEqual([
              "b".repeat(64),
              "a".repeat(64),
            ]);
          }),
        ),
      );

      it.effect("revokes an invite by its hash", () =>
        withRepos(
          Effect.gen(function* () {
            const invites = yield* InviteRepo.InviteRepo;
            yield* invites.create(invite());
            expect(yield* invites.revoke("a".repeat(64))).toBe(true);
            expect(yield* invites.revoke("a".repeat(64))).toBe(false);
            expect(yield* invites.findRedeemable("a".repeat(64), at(2 * DAY))).toEqual(
              Option.none(),
            );
            expect(yield* invites.list()).toEqual([]);
          }),
        ),
      );

      it.effect("redeems a use in the transaction that creates the user, up to its limit", () =>
        withRepos(
          Effect.gen(function* () {
            const invites = yield* InviteRepo.InviteRepo;
            const users = yield* UserRepo.UserRepo;
            yield* invites.create(invite({ maxUses: 2 }));
            const hash = Option.some("a".repeat(64));

            yield* signUp(1, at(2 * DAY), hash);
            expect(
              Option.map(
                yield* invites.findRedeemable("a".repeat(64), at(2 * DAY)),
                (found) => found.uses,
              ),
            ).toEqual(Option.some(1));
            yield* signUp(2, at(2 * DAY), hash);
            expect(yield* invites.findRedeemable("a".repeat(64), at(2 * DAY))).toEqual(
              Option.none(),
            );

            const error = yield* Effect.flip(signUp(3, at(2 * DAY), hash));
            expect(error).toEqual(new InviteRepo.InviteNotRedeemable());
            // The transaction left nothing behind: no user, and the username is still free.
            expect(yield* users.findById("usr_3")).toEqual(Option.none());
            expect(yield* users.isUsernameTaken(yield* Username.parse("user-3"))).toBe(false);
          }),
        ),
      );

      it.effect("refuses an unknown, expired or revoked invite at registration", () =>
        withRepos(
          Effect.gen(function* () {
            const invites = yield* InviteRepo.InviteRepo;
            yield* invites.create(invite({ maxUses: 10 }));
            const hash = Option.some("a".repeat(64));

            expect(yield* Effect.flip(signUp(1, at(2 * DAY), Option.some("c".repeat(64))))).toEqual(
              new InviteRepo.InviteNotRedeemable(),
            );
            expect(yield* Effect.flip(signUp(2, at(8 * DAY), hash))).toEqual(
              new InviteRepo.InviteNotRedeemable(),
            );
            yield* invites.revoke("a".repeat(64));
            expect(yield* Effect.flip(signUp(3, at(2 * DAY), hash))).toEqual(
              new InviteRepo.InviteNotRedeemable(),
            );
            // Without an invite, registration doesn't touch one.
            yield* signUp(4, at(2 * DAY), Option.none());
          }),
        ),
      );

      it.effect("a single-use invite redeemed by concurrent sign-ups creates one account", () =>
        withRepos(
          Effect.gen(function* () {
            const invites = yield* InviteRepo.InviteRepo;
            const users = yield* UserRepo.UserRepo;
            yield* invites.create(invite());
            const results = yield* Effect.forEach(
              Arr.range(1, 8),
              (n) => Effect.result(signUp(n, at(2 * DAY), Option.some("a".repeat(64)))),
              { concurrency: "unbounded" },
            );
            const created = yield* Effect.forEach(
              Arr.range(1, 8),
              (n) => Effect.map(users.findById(`usr_${n}`), Option.isSome),
              { concurrency: 1 },
            );
            expect(Arr.filter(created, Boolean)).toHaveLength(1);
            expect(Arr.filter(results, Result.isSuccess)).toHaveLength(1);
            expect(Option.isNone(yield* invites.findRedeemable("a".repeat(64), at(2 * DAY)))).toBe(
              true,
            );
          }),
        ),
      );

      it.effect("counts invite misses per client and hour, stopping at the limit", () =>
        withRepos(
          Effect.gen(function* () {
            const limits = yield* SignupLimitRepo.SignupLimitRepo;
            const now = at(10 * 3_600_000);
            expect(yield* limits.inviteMisses("src", now)).toBe(0);
            yield* limits.recordInviteMiss("src", now, 2);
            yield* limits.recordInviteMiss("src", now, 2);
            yield* limits.recordInviteMiss("src", now, 2);
            expect(yield* limits.inviteMisses("src", now)).toBe(2);
            expect(yield* limits.inviteMisses("other", now)).toBe(0);
            expect(yield* limits.inviteMisses("src", at(11 * 3_600_000))).toBe(0);
          }),
        ),
      );
    });
  });
