import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AliasRepo, Table } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const alias = (overrides: Partial<AliasRepo.NewAlias> = {}): AliasRepo.NewAlias => ({
  id: "al_1",
  userId: "usr_1",
  domain: "alias.test",
  localPart: "shop",
  mode: "forward",
  createdAt: 1,
  ...overrides,
});

/**
 * Behaviour every AliasRepo backend must satisfy. Runners pass the emulator to run against;
 * each test gets its own table on it.
 */
export const aliasRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`AliasRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(effect: Effect.Effect<A, E, AliasRepo.AliasRepo>) =>
        effect.pipe(Effect.provide(AliasRepo.layer.pipe(Layer.provide(freshTable()))));

      it.effect("finds an alias by address, ignoring letter case", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias({ localPart: "Shop" }));

            const found = yield* repo.findByAddress("ALIAS.test", "SHOP");
            expect(found).toEqual(
              Option.some({
                id: "al_1",
                userId: "usr_1",
                domain: "alias.test",
                localPart: "shop",
                mode: "forward",
                isActive: true,
                createdAt: 1,
              }),
            );
          }),
        ),
      );

      it.effect("creating the table again is a no-op (dev restarts on persistent data)", () =>
        Effect.gen(function* () {
          yield* Table.ensure();
          yield* Table.ensure();
        }).pipe(Effect.provide(freshTable())),
      );

      it.effect("returns none for unknown addresses", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            expect(Option.isNone(yield* repo.findByAddress("alias.test", "nobody"))).toBe(true);
          }),
        ),
      );

      it.effect("rejects an address that already exists", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias());
            const error = yield* Effect.flip(repo.insert(alias({ id: "al_2", localPart: "SHOP" })));
            expect(error).toEqual(new AliasRepo.AliasTaken({ address: "shop@alias.test" }));
          }),
        ),
      );

      it.effect("lists a user's aliases oldest first, and only theirs", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias({ id: "al_new", localPart: "b", createdAt: 20 }));
            yield* repo.insert(alias({ id: "al_old", localPart: "a", createdAt: 3 }));
            yield* repo.insert(alias({ id: "al_other", userId: "usr_2", localPart: "c" }));

            const listed = yield* repo.listByUser("usr_1");
            expect(Arr.map(listed, (row) => row.id)).toEqual(["al_old", "al_new"]);
          }),
        ),
      );
    });
  });
