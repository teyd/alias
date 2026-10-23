import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import type { Rules } from "@alias/core";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import { Dynamo, FilterRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const rule = (id: string, name = id): Rules.Rule => ({
  id,
  name,
  isEnabled: true,
  match: "all",
  conditions: [
    { field: "sender-domain", match: "equals", value: "shop.example", isNegated: false },
  ],
  actions: [{ type: "prefix-subject", value: "[shop]" }],
});

const append =
  (added: Rules.Rule) =>
  (rules: ReadonlyArray<Rules.Rule>): Result.Result<ReadonlyArray<Rules.Rule>, never> =>
    Result.succeed(Arr.append(rules, added));

/**
 * Behaviour every FilterRepo backend must satisfy. Runners pass the emulator; each test gets its
 * own table on it.
 */
export const filterRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`FilterRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(
        effect: Effect.Effect<A, E, FilterRepo.FilterRepo | Dynamo.Database>,
      ) => effect.pipe(Effect.provide(FilterRepo.layer.pipe(Layer.provideMerge(freshTable()))));

      it.effect("starts empty, and keeps each user's blocklist apart, sorted", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FilterRepo.FilterRepo;
            expect(yield* repo.find("usr_1")).toEqual({ blocklist: [], rules: [] });
            yield* repo.block("usr_1", "spam@x.example", 10);
            yield* repo.block("usr_1", "*.ads.example", 10);
            yield* repo.block("usr_2", "other.example", 10);
            expect((yield* repo.find("usr_1")).blocklist).toEqual([
              "*.ads.example",
              "spam@x.example",
            ]);
            expect((yield* repo.find("usr_2")).blocklist).toEqual(["other.example"]);
          }),
        ),
      );

      it.effect("stores one item in the user's partition: a string set and the rules", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FilterRepo.FilterRepo;
            yield* repo.block("usr_1", "spam@x.example", 10);
            yield* repo.updateRules("usr_1", append(rule("rl_1")));
            const table = yield* Dynamo.DynamoTable;
            const { Items } = yield* DynamoDB.scan({ TableName: table.name, ConsistentRead: true });
            expect(Items).toHaveLength(1);
            const [item] = Items ?? [];
            expect(item?.pk).toEqual({ S: "USER#usr_1" });
            expect(item?.sk).toEqual({ S: "FILTERS" });
            expect(item?.blocked).toEqual({ SS: ["spam@x.example"] });
            expect(item?.rulesVersion).toEqual({ N: "1" });
          }),
        ),
      );

      it.effect("adds an entry once, and refuses new ones past the limit but not old ones", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FilterRepo.FilterRepo;
            yield* repo.block("usr_1", "a.example", 2);
            yield* repo.block("usr_1", "a.example", 2);
            yield* repo.block("usr_1", "b.example", 2);
            const full = yield* Effect.flip(repo.block("usr_1", "c.example", 2));
            expect(full).toEqual(new FilterRepo.BlocklistFull({ limit: 2 }));
            yield* repo.block("usr_1", "a.example", 2);
            expect((yield* repo.find("usr_1")).blocklist).toEqual(["a.example", "b.example"]);
          }),
        ),
      );

      it.effect("keeps the limit under concurrent adds", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FilterRepo.FilterRepo;
            const results = yield* Effect.forEach(
              Arr.range(1, 8),
              (n) => Effect.result(repo.block("usr_1", `n${n}.example`, 5)),
              { concurrency: 8 },
            );
            expect(Arr.filter(results, Result.isSuccess)).toHaveLength(5);
            expect((yield* repo.find("usr_1")).blocklist).toHaveLength(5);
          }),
        ),
      );

      it.effect("removes an entry, and says when there was none", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FilterRepo.FilterRepo;
            const missing = yield* Effect.flip(repo.unblock("usr_1", "a.example"));
            expect(missing).toEqual(new FilterRepo.NoSuchEntry({ entryId: "a.example" }));
            yield* repo.block("usr_1", "a.example", 10);
            yield* repo.block("usr_1", "b.example", 10);
            yield* repo.unblock("usr_1", "a.example");
            expect((yield* repo.find("usr_1")).blocklist).toEqual(["b.example"]);
            // The last entry's removal leaves no empty set behind (DynamoDB has none).
            yield* repo.unblock("usr_1", "b.example");
            expect((yield* repo.find("usr_1")).blocklist).toEqual([]);
            const again = yield* Effect.flip(repo.unblock("usr_1", "b.example"));
            expect(again._tag).toBe("NoSuchEntry");
          }),
        ),
      );

      it.effect("stores rules in order, next to the blocklist, which stays", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FilterRepo.FilterRepo;
            yield* repo.block("usr_1", "a.example", 10);
            yield* repo.updateRules("usr_1", append(rule("rl_1")));
            yield* repo.updateRules("usr_1", append(rule("rl_2")));
            const reversed = yield* repo.updateRules("usr_1", (rules) =>
              Result.succeed(Arr.reverse(rules)),
            );
            expect(Arr.map(reversed, (found) => found.id)).toEqual(["rl_2", "rl_1"]);
            expect(yield* repo.find("usr_1")).toEqual({
              blocklist: ["a.example"],
              rules: [rule("rl_2"), rule("rl_1")],
            });
            yield* repo.unblock("usr_1", "a.example");
            expect((yield* repo.find("usr_1")).rules).toHaveLength(2);
          }),
        ),
      );

      it.effect("passes a refusal through and writes nothing", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FilterRepo.FilterRepo;
            const refused = yield* Effect.flip(
              repo.updateRules("usr_1", () => Result.fail("too-many" as const)),
            );
            expect(refused).toBe("too-many");
            expect(yield* repo.find("usr_1")).toEqual({ blocklist: [], rules: [] });
          }),
        ),
      );

      it.effect("loses no rule when changes race: each retries on the version it read", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* FilterRepo.FilterRepo;
            yield* Effect.forEach(
              Arr.range(1, 4),
              (n) => repo.updateRules("usr_1", append(rule(`rl_${n}`))),
              { concurrency: 4, discard: true },
            );
            const ids = Arr.map((yield* repo.find("usr_1")).rules, (found) => found.id);
            expect(Arr.sort(ids, Order.String)).toEqual(["rl_1", "rl_2", "rl_3", "rl_4"]);
          }),
        ),
      );
    });
  });
