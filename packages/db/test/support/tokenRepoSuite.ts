import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { TokenRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const token = (overrides: Partial<TokenRepo.NewToken> = {}): TokenRepo.NewToken => ({
  id: "tok_01",
  hash: "a".repeat(64),
  userId: "usr_1",
  username: "ada",
  name: "laptop CLI",
  scopes: ["aliases:read", "aliases:write"],
  hint: "AbCd",
  createdAt: at(1_000),
  expiresAt: Option.none(),
  ...overrides,
});

/**
 * Behaviour every TokenRepo backend must satisfy. Runners pass the emulator; each test gets its
 * own table on it.
 */
export const tokenRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`TokenRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(effect: Effect.Effect<A, E, TokenRepo.TokenRepo>) =>
        effect.pipe(Effect.provide(TokenRepo.layer.pipe(Layer.provide(freshTable()))));

      it.effect("finds a token by the hash of its secret, and lists it for its user only", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* TokenRepo.TokenRepo;
            yield* repo.create(token());
            yield* repo.create(token({ id: "tok_02", hash: "b".repeat(64), name: "CI" }));
            yield* repo.create(token({ id: "tok_03", hash: "c".repeat(64), userId: "usr_2" }));
            const stored = { ...token(), lastUsedAt: Option.none() };

            expect(yield* repo.findByHash("a".repeat(64))).toEqual(Option.some(stored));
            expect(yield* repo.findByHash("d".repeat(64))).toEqual(Option.none());
            expect(Arr.map(yield* repo.list("usr_1"), (found) => found.id)).toEqual([
              "tok_01",
              "tok_02",
            ]);
            expect(yield* repo.list("usr_3")).toEqual([]);
          }),
        ),
      );

      it.effect("ignores an expired token that TTL has not deleted yet", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* TokenRepo.TokenRepo;
            yield* repo.create(token({ expiresAt: Option.some(at(60_000)) }));
            yield* TestClock.setTime(59_000);
            expect(Option.isSome(yield* repo.findByHash("a".repeat(64)))).toBe(true);
            yield* TestClock.setTime(60_000);
            expect(yield* repo.findByHash("a".repeat(64))).toEqual(Option.none());
            // Still listed, so the owner sees it expired.
            expect(yield* repo.list("usr_1")).toHaveLength(1);
          }),
        ),
      );

      it.effect("revokes only the owner's token, for good", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* TokenRepo.TokenRepo;
            yield* repo.create(token());
            const foreign = yield* Effect.result(repo.revoke("usr_2", "tok_01"));
            expect(Result.isFailure(foreign) && foreign.failure._tag).toBe("NoSuchToken");
            expect(Option.isSome(yield* repo.findByHash("a".repeat(64)))).toBe(true);

            yield* repo.revoke("usr_1", "tok_01");
            expect(yield* repo.findByHash("a".repeat(64))).toEqual(Option.none());
            expect(yield* repo.list("usr_1")).toEqual([]);
            const again = yield* Effect.result(repo.revoke("usr_1", "tok_01"));
            expect(Result.isFailure(again) && again.failure._tag).toBe("NoSuchToken");
          }),
        ),
      );

      it.effect("records a use at most once per interval and never revives a revoked token", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* TokenRepo.TokenRepo;
            const every = Duration.minutes(5);
            const hash = "a".repeat(64);
            const lastUsed = Effect.map(repo.findByHash(hash), (found) =>
              Option.flatMap(found, (live) => live.lastUsedAt),
            );
            yield* repo.create(token());
            const fresh = yield* Effect.flatMap(repo.findByHash(hash), Effect.fromOption);

            yield* repo.touch(fresh, at(100_000), every);
            expect(yield* lastUsed).toEqual(Option.some(at(100_000)));
            // A concurrent request that read the token before the first use was recorded.
            yield* repo.touch(fresh, at(160_000), every);
            expect(yield* lastUsed).toEqual(Option.some(at(100_000)));
            const used = yield* Effect.flatMap(repo.findByHash(hash), Effect.fromOption);
            yield* repo.touch(used, at(399_999), every);
            expect(yield* lastUsed).toEqual(Option.some(at(100_000)));
            yield* repo.touch(used, at(400_001), every);
            expect(yield* lastUsed).toEqual(Option.some(at(400_001)));

            yield* repo.revoke("usr_1", "tok_01");
            yield* repo.touch(fresh, at(900_000), every);
            expect(yield* repo.list("usr_1")).toEqual([]);
          }),
        ),
      );

      it.effect("counts failed attempts per source and hour, up to the cap", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* TokenRepo.TokenRepo;
            const now = DateTime.makeUnsafe("2026-10-22T09:15:00Z");
            expect(yield* repo.failures("ip-1", now)).toBe(0);
            yield* Effect.all(
              Arr.makeBy(4, () => repo.recordFailure("ip-1", now, 3)),
              { concurrency: "unbounded" },
            );
            expect(yield* repo.failures("ip-1", now)).toBe(3);
            expect(yield* repo.failures("ip-2", now)).toBe(0);
            expect(yield* repo.failures("ip-1", DateTime.makeUnsafe("2026-10-22T10:00:00Z"))).toBe(
              0,
            );
          }),
        ),
      );
    });
  });
