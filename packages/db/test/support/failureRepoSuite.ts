import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { AliasRepo, Dynamo, FailureRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);
/** Far in the future, so nothing expires unless a test says so. */
const LATER = at(9_000_000_000_000);

const shop = { domain: "alias.test", localPart: "shop" };
const club = { domain: "alias.test", localPart: "club" };

const failure = (
  id: string,
  overrides: Partial<FailureRepo.Failure> = {},
): FailureRepo.Failure => ({
  id,
  aliasId: "al_shop",
  userId: "usr_1",
  alias: "shop@alias.test",
  sender: Option.some("grace@example.com"),
  reason: "recipient-bounced",
  receivedAt: at(1_000),
  expiresAt: LATER,
  size: 2_048,
  kept: Option.none(),
  ...overrides,
});

const kept: FailureRepo.Kept = {
  objectKey: "inbox/7d/al_shop/fail_01a",
  keyVersion: 1,
  wrappedKey: new Uint8Array([1, 2, 3]),
  envelopeFrom: "shop+r.token@alias.test",
};

const seed = AliasRepo.AliasRepo.use((aliases) =>
  Effect.all(
    [
      aliases.insert({ id: "al_shop", userId: "usr_1", mode: "forward", createdAt: 0, ...shop }),
      aliases.insert({ id: "al_club", userId: "usr_1", mode: "forward", createdAt: 0, ...club }),
    ],
    { concurrency: 1 },
  ),
);

const ids = (failures: ReadonlyArray<FailureRepo.Failure>) => Arr.map(failures, (f) => f.id);

/**
 * Behaviour every FailureRepo backend must satisfy (PLAN.md §20.33). Runners pass the emulator;
 * each test gets its own table on it.
 */
export const failureRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`FailureRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          FailureRepo.FailureRepo | AliasRepo.AliasRepo | Dynamo.Database
        >,
      ) =>
        Effect.andThen(seed, effect).pipe(
          Effect.provide(
            Layer.mergeAll(FailureRepo.layer, AliasRepo.layer).pipe(
              Layer.provideMerge(freshTable()),
            ),
          ),
        );

      it.effect("lists the user's failures across aliases, newest first, as stored", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FailureRepo.FailureRepo;
            yield* repo.insert(failure("fail_01a", { kept: Option.some(kept) }), shop);
            yield* repo.insert(
              failure("fail_01c", {
                aliasId: "al_club",
                alias: "club@alias.test",
                receivedAt: at(3_000),
                sender: Option.none(),
                reason: "too-large",
              }),
              club,
            );
            yield* repo.insert(failure("fail_01b", { receivedAt: at(2_000) }), shop);
            yield* repo.insert(failure("fail_01z", { userId: "usr_2" }), shop);
            const listed = yield* repo.list("usr_1");
            expect(ids(listed)).toEqual(["fail_01c", "fail_01b", "fail_01a"]);
            expect(listed[2]).toEqual(failure("fail_01a", { kept: Option.some(kept) }));
            expect(ids(yield* repo.list("usr_2"))).toEqual(["fail_01z"]);
            expect(yield* repo.find("usr_1", "fail_01c")).toEqual(Option.some(listed[0]));
            // Someone else's failure, and an unknown one, are not found.
            expect(yield* repo.find("usr_2", "fail_01a")).toEqual(Option.none());
            expect(yield* repo.find("usr_1", "fail_none")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("ignores expired failures before TTL deletes them", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FailureRepo.FailureRepo;
            const now = yield* DateTime.now;
            yield* repo.insert(
              failure("fail_01a", { expiresAt: DateTime.subtract(now, { seconds: 5 }) }),
              shop,
            );
            yield* repo.insert(failure("fail_01b"), shop);
            expect(ids(yield* repo.list("usr_1"))).toEqual(["fail_01b"]);
            expect(yield* repo.find("usr_1", "fail_01a")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("deletes only the owner's failure, once, and returns what it held", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FailureRepo.FailureRepo;
            yield* repo.insert(failure("fail_01a", { kept: Option.some(kept) }), shop);
            expect(yield* repo.delete("usr_2", "fail_01a")).toEqual(Option.none());
            expect(yield* repo.delete("usr_1", "fail_01a")).toEqual(
              Option.some(failure("fail_01a", { kept: Option.some(kept) })),
            );
            expect(yield* repo.delete("usr_1", "fail_01a")).toEqual(Option.none());
            expect(yield* repo.find("usr_1", "fail_01a")).toEqual(Option.none());
          }),
        ),
      );

      it.effect(
        "refuses a failure for a deleted alias; deleting an alias purges its failures",
        () =>
          withRepo(
            Effect.gen(function* () {
              const repo = yield* FailureRepo.FailureRepo;
              const aliases = yield* AliasRepo.AliasRepo;
              yield* repo.insert(failure("fail_01a", { kept: Option.some(kept) }), shop);
              yield* aliases.delete({ userId: "usr_1", ...shop });
              expect(yield* Effect.flip(repo.insert(failure("fail_01b"), shop))).toBeInstanceOf(
                AliasRepo.NoSuchAlias,
              );
              const table = yield* Dynamo.DynamoTable;
              const { Items } = yield* DynamoDB.scan({
                TableName: table.name,
                ConsistentRead: true,
              });
              // Only the two aliases' items are left: the deleted one's tombstone and the other.
              expect(
                Arr.sort(
                  Arr.map(Items ?? [], (item) => item.pk?.S ?? ""),
                  Str.Order,
                ),
              ).toEqual(["ALIAS#alias.test#club", "ALIAS#alias.test#shop"]);
              expect(yield* repo.list("usr_1")).toEqual([]);
            }),
          ),
      );

      it.effect("caps recorded failures per user and day, under concurrency", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FailureRepo.FailureRepo;
            const now = DateTime.makeUnsafe("2026-10-22T09:00:00Z");
            const results = yield* Effect.forEach(
              Arr.range(1, 6),
              () => repo.reserve("usr_1", now, 4),
              {
                concurrency: 6,
              },
            );
            expect(Arr.filter(results, (ok) => ok)).toHaveLength(4);
            expect(yield* repo.reserve("usr_2", now, 4)).toBe(true);
            expect(yield* repo.reserve("usr_1", DateTime.add(now, { days: 1 }), 4)).toBe(true);
          }),
        ),
      );
    });
  });
