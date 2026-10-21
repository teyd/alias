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
                forwardedCount: 0,
                blockedCount: 0,
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
      const owned = { userId: "usr_1", domain: "ALIAS.test", localPart: "SHOP" };

      it.effect("updates mode and active flag, and returns the stored alias", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias());

            const deactivated = yield* repo.update(owned, { isActive: false });
            expect(deactivated).toMatchObject({ mode: "forward", isActive: false });

            const switched = yield* repo.update(owned, { mode: "inbox" });
            expect(switched).toMatchObject({ mode: "inbox", isActive: false });
            expect(yield* repo.findByAddress("alias.test", "shop")).toEqual(Option.some(switched));
          }),
        ),
      );

      it.effect("an empty update returns the alias unchanged", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias());
            expect(yield* repo.update(owned, {})).toMatchObject({ id: "al_1", isActive: true });
          }),
        ),
      );

      it.effect("won't update or delete another user's alias, or a missing one", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias());
            const missing = new AliasRepo.NoSuchAlias({ address: "shop@alias.test" });
            const stranger = { ...owned, userId: "usr_2" };

            expect(yield* Effect.flip(repo.update(stranger, { isActive: false }))).toEqual(missing);
            expect(yield* Effect.flip(repo.update(stranger, {}))).toEqual(missing);
            expect(yield* Effect.flip(repo.delete(stranger))).toEqual(missing);
            expect(yield* Effect.flip(repo.update({ ...owned, localPart: "shopx" }, {}))).toEqual(
              new AliasRepo.NoSuchAlias({ address: "shopx@alias.test" }),
            );
            expect(yield* repo.findByAddress("alias.test", "shop")).toEqual(
              Option.some(expect.objectContaining({ isActive: true })),
            );
          }),
        ),
      );

      it.effect("deletes an alias, freeing its address and dropping it from the list", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias());
            yield* repo.delete(owned);

            expect(Option.isNone(yield* repo.findByAddress("alias.test", "shop"))).toBe(true);
            expect(yield* repo.listByUser("usr_1")).toEqual([]);
            expect(yield* Effect.flip(repo.delete(owned))).toBeInstanceOf(AliasRepo.NoSuchAlias);
            yield* repo.insert(alias({ id: "al_2" }));
          }),
        ),
      );

      it.effect("counts forwarded and blocked mail atomically", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias());
            yield* Effect.all(Arr.replicate(repo.increment("ALIAS.test", "Shop", "forwarded"), 5), {
              concurrency: "unbounded",
            });
            yield* repo.increment("alias.test", "shop", "blocked");

            expect(yield* repo.findByAddress("alias.test", "shop")).toEqual(
              Option.some(expect.objectContaining({ forwardedCount: 5, blockedCount: 1 })),
            );
          }),
        ),
      );

      it.effect("counting a deleted alias fails instead of recreating it", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            const error = yield* Effect.flip(repo.increment("alias.test", "gone", "forwarded"));
            expect(error).toEqual(new AliasRepo.NoSuchAlias({ address: "gone@alias.test" }));
            expect(Option.isNone(yield* repo.findByAddress("alias.test", "gone"))).toBe(true);
          }),
        ),
      );
    });
  });
