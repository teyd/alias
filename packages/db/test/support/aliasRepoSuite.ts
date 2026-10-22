import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Str from "effect/String";
import { AliasRepo, ContactRepo, Dynamo, Table } from "../../src/index.ts";
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
                inboxExpiresAt: Option.none(),
                retentionDays: Option.none(),
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

      const at = (iso: string) => DateTime.makeUnsafe(iso);

      /** The alias repo plus contacts and raw table access, on one fresh table. */
      const withTable = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          AliasRepo.AliasRepo | ContactRepo.ContactRepo | Dynamo.Database
        >,
      ) =>
        effect.pipe(
          Effect.provide(
            Layer.mergeAll(AliasRepo.layer, ContactRepo.layer).pipe(
              Layer.provideMerge(freshTable()),
            ),
          ),
        );

      /** Every item in one partition, as stored. */
      const partition = (pk: string) =>
        Effect.flatMap(Effect.service(Dynamo.DynamoTable), (table) =>
          DynamoDB.query({
            TableName: table.name,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": { S: pk } },
            ConsistentRead: true,
          }),
        ).pipe(Effect.map((result) => result.Items ?? []));

      const contact = (id: string, address: string): ContactRepo.NewContact => ({
        id,
        aliasId: "al_1",
        address,
        name: Option.none(),
        createdAt: DateTime.makeUnsafe(1),
      });
      const shop = { domain: "alias.test", localPart: "shop" };

      it.effect("deletes an alias with its contacts and counters, leaving a tombstone", () =>
        withTable(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            const contacts = yield* ContactRepo.ContactRepo;
            yield* repo.insert(alias());
            yield* repo.increment("alias.test", "shop", "forwarded");
            yield* contacts.create(contact("c1aaaaaaaaaaaaaa", "a@store.example"), shop);
            yield* contacts.create(contact("c2aaaaaaaaaaaaaa", "b@store.example"), shop);
            yield* repo.reserveForward("alias.test", "shop", at("2026-10-22T09:30:00Z"), 5);

            yield* repo.delete({ ...owned, localPart: "SHOP" });

            expect(Option.isNone(yield* repo.findByAddress("alias.test", "shop"))).toBe(true);
            expect(yield* repo.isDeleted("ALIAS.test", "Shop")).toBe(true);
            expect(yield* repo.listByUser("usr_1")).toEqual([]);
            // The contacts, their id pointers and the hourly counter are gone.
            expect(yield* partition("CONTACTS#al_1")).toEqual([]);
            expect(yield* contacts.findById("al_1", "c1aaaaaaaaaaaaaa")).toEqual(Option.none());
            // The tombstone keeps who deleted it and when, nothing else.
            const items = yield* partition("ALIAS#alias.test#shop");
            expect(items).toHaveLength(1);
            expect(Arr.sort(R.keys(items[0] ?? {}), Str.Order)).toEqual([
              "deletedAt",
              "gsi1pk",
              "gsi1sk",
              "pk",
              "sk",
              "userId",
            ]);
            expect(items[0]).toMatchObject({
              userId: { S: "usr_1" },
              gsi1pk: { S: "DELETED-ALIASES#usr_1" },
            });
          }),
        ),
      );

      it.effect("keeps a deleted address from everyone but the user who deleted it", () =>
        withTable(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias());
            yield* repo.delete(owned);
            const missing = new AliasRepo.NoSuchAlias({ address: "shop@alias.test" });

            // A tombstone is no alias: nothing changes it, nothing counts on it.
            expect(yield* Effect.flip(repo.delete(owned))).toEqual(missing);
            expect(yield* Effect.flip(repo.update(owned, { isActive: true }))).toEqual(missing);
            expect(yield* Effect.flip(repo.increment("alias.test", "shop", "blocked"))).toEqual(
              missing,
            );
            expect(yield* repo.isDeleted("alias.test", "shop")).toBe(true);
            expect(yield* repo.isDeleted("alias.test", "nobody")).toBe(false);

            // Nobody else gets the address, in any letter case.
            expect(
              yield* Effect.flip(
                repo.insert(alias({ id: "al_2", userId: "usr_2", localPart: "SHOP" })),
              ),
            ).toEqual(new AliasRepo.AliasTaken({ address: "shop@alias.test" }));

            // Its owner may create it again: a new alias, with a new id and fresh counters.
            yield* repo.insert(alias({ id: "al_3", createdAt: 5 }));
            expect(yield* repo.findByAddress("alias.test", "shop")).toEqual(
              Option.some(
                expect.objectContaining({ id: "al_3", forwardedCount: 0, isActive: true }),
              ),
            );
            expect(yield* repo.isDeleted("alias.test", "shop")).toBe(false);
            expect(Arr.map(yield* repo.listByUser("usr_1"), (found) => found.id)).toEqual(["al_3"]);
          }),
        ),
      );

      it.effect("finishes a deletion that stopped before its contacts were purged", () =>
        withTable(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            const contacts = yield* ContactRepo.ContactRepo;
            const table = yield* Dynamo.DynamoTable;
            yield* repo.insert(alias());
            yield* contacts.create(contact("c1aaaaaaaaaaaaaa", "a@store.example"), shop);
            // The first step alone, as if the Lambda died right after it.
            expect(yield* AliasRepo.retire(table, owned)).toBe("al_1");

            expect(Option.isNone(yield* repo.findByAddress("alias.test", "shop"))).toBe(true);
            // Not even its owner reclaims it while the purge is pending, and nobody else can
            // finish it.
            expect(yield* Effect.flip(repo.insert(alias({ id: "al_2" })))).toBeInstanceOf(
              AliasRepo.AliasTaken,
            );
            expect(yield* Effect.flip(repo.delete({ ...owned, userId: "usr_2" }))).toBeInstanceOf(
              AliasRepo.NoSuchAlias,
            );
            expect(yield* contacts.list("al_1")).toHaveLength(1);

            // Deleting again finishes the job.
            yield* repo.delete(owned);
            expect(yield* partition("CONTACTS#al_1")).toEqual([]);
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

      it.effect("allows up to the hourly forward cap per alias, and the next hour afresh", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            const nine = at("2026-10-22T09:00:00Z");
            const late = at("2026-10-22T09:59:59.999Z");
            expect(yield* repo.reserveForward("alias.test", "shop", nine, 2)).toBe(true);
            expect(yield* repo.reserveForward("ALIAS.test", "Shop", late, 2)).toBe(true);
            expect(yield* repo.reserveForward("alias.test", "shop", late, 2)).toBe(false);
            // Another alias has its own allowance, and 10:00 starts a new hour.
            expect(yield* repo.reserveForward("alias.test", "news", late, 2)).toBe(true);
            expect(
              yield* repo.reserveForward("alias.test", "shop", at("2026-10-22T10:00:00Z"), 2),
            ).toBe(true);
          }),
        ),
      );

      it.effect("never lets concurrent forwards past the cap", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            const now = at("2026-10-22T09:30:00Z");
            const results = yield* Effect.all(
              Arr.replicate(repo.reserveForward("alias.test", "shop", now, 3), 8),
              { concurrency: "unbounded" },
            );
            expect(results.filter((isReserved) => isReserved)).toHaveLength(3);
          }),
        ),
      );

      it.effect(
        "keeps the forward counter apart from the alias, expiring an hour after its hour",
        () =>
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            const table = yield* Dynamo.DynamoTable;
            yield* repo.insert(alias());
            yield* repo.reserveForward("alias.test", "shop", at("2026-10-22T09:30:00Z"), 5);

            const { Item } = yield* DynamoDB.getItem({
              TableName: table.name,
              Key: { pk: { S: "ALIAS#alias.test#shop" }, sk: { S: "FORWARDS#2026-10-22T09" } },
              ConsistentRead: true,
            });
            expect(Item).toMatchObject({
              count: { N: "1" },
              expiresAt: { N: String(DateTime.toEpochMillis(at("2026-10-22T11:00:00Z")) / 1000) },
            });
            expect(yield* repo.listByUser("usr_1")).toHaveLength(1);
            expect(yield* repo.findByAddress("alias.test", "shop")).toEqual(
              Option.some(expect.objectContaining({ forwardedCount: 0 })),
            );
          }).pipe(Effect.provide(AliasRepo.layer.pipe(Layer.provideMerge(freshTable())))),
      );

      it.effect(
        "allows up to the daily on-the-fly creations per user, and the next day afresh",
        () =>
          withRepo(
            Effect.gen(function* () {
              const repo = yield* AliasRepo.AliasRepo;
              const morning = at("2026-10-22T00:00:00Z");
              const night = at("2026-10-22T23:59:59Z");
              const results = yield* Effect.all(
                Arr.replicate(repo.reserveCreation("usr_1", morning, 3), 5),
                { concurrency: "unbounded" },
              );
              expect(results.filter((isReserved) => isReserved)).toHaveLength(3);
              expect(yield* repo.reserveCreation("usr_1", night, 3)).toBe(false);
              expect(yield* repo.reserveCreation("usr_2", night, 3)).toBe(true);
              expect(yield* repo.reserveCreation("usr_1", at("2026-10-23T00:00:00Z"), 3)).toBe(
                true,
              );
              // The quota never shows up as an alias.
              expect(yield* repo.listByUser("usr_1")).toEqual([]);
            }),
          ),
      );

      it.effect("stores a temporary inbox's expiry and retention, and changes the retention", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            yield* repo.insert(alias());
            yield* repo.insert(
              alias({
                id: "al_temp",
                domain: "tmp.test",
                localPart: "k7m2qx9pzr",
                mode: "inbox",
                inboxExpiresAt: 86_400_000,
                retentionDays: 1,
              }),
            );
            const shop = yield* repo.findByAddress("alias.test", "shop");
            expect(
              Option.map(shop, (found) => [found.inboxExpiresAt, found.retentionDays]),
            ).toEqual(Option.some([Option.none(), Option.none()]));
            const temporary = yield* repo.findByAddress("tmp.test", "k7m2qx9pzr");
            expect(
              Option.map(temporary, (found) => [found.inboxExpiresAt, found.retentionDays]),
            ).toEqual(Option.some([Option.some(86_400_000), Option.some(1)]));
            const changed = yield* repo.update(
              { userId: "usr_1", domain: "alias.test", localPart: "shop" },
              { mode: "inbox", retentionDays: 30 },
            );
            expect([changed.mode, changed.retentionDays]).toEqual(["inbox", Option.some(30)]);
          }),
        ),
      );

      it.effect("caps temporary inboxes per user and UTC day", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            const morning = at("2026-10-22T00:00:00Z");
            const results = yield* Effect.all(
              Arr.replicate(repo.reserveTemporary("usr_1", morning, 3), 5),
              { concurrency: "unbounded" },
            );
            expect(results.filter((isReserved) => isReserved)).toHaveLength(3);
            expect(yield* repo.reserveTemporary("usr_2", morning, 3)).toBe(true);
            expect(yield* repo.reserveTemporary("usr_1", at("2026-10-23T00:00:00Z"), 3)).toBe(true);
            // Separate from the on-the-fly allowance.
            expect(yield* repo.reserveCreation("usr_1", morning, 3)).toBe(true);
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

      it.effect("releasing a custom domain deletes its aliases and tombstones, nothing else", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* AliasRepo.AliasRepo;
            const on = (domain: string, localPart: string, id: string) =>
              repo.insert(alias({ id, domain, localPart }));
            yield* on("custom.example", "shop", "al_live");
            yield* on("custom.example", "old", "al_old");
            yield* on("other.example", "keep", "al_other");
            yield* on("alias.test", "keep", "al_shared");
            yield* repo.delete({ userId: "usr_1", domain: "custom.example", localPart: "old" });
            yield* repo.delete({ userId: "usr_1", domain: "alias.test", localPart: "keep" });

            yield* repo.releaseDomain("usr_1", "Custom.Example");
            yield* repo.releaseDomain("usr_1", "custom.example");

            expect(Arr.map(yield* repo.listByUser("usr_1"), (found) => found.id)).toEqual([
              "al_other",
            ]);
            expect(yield* repo.isDeleted("custom.example", "old")).toBe(false);
            expect(yield* repo.isDeleted("alias.test", "keep")).toBe(true);
            // The domain's next owner may use every address on it.
            yield* on("custom.example", "shop", "al_next");
            yield* repo.insert(
              alias({
                id: "al_next2",
                userId: "usr_2",
                domain: "custom.example",
                localPart: "old",
              }),
            );
            yield* repo.insert(
              alias({
                id: "al_next3",
                userId: "usr_2",
                domain: "custom.example",
                localPart: "new",
              }),
            );
          }),
        ),
      );
    });
  });
