import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { AliasRepo, ContactRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const contact = (overrides: Partial<ContactRepo.NewContact> = {}): ContactRepo.NewContact => ({
  id: "c1aaaaaaaaaaaaaa",
  aliasId: "al_1",
  address: "Orders@Store.example",
  name: Option.some("Store"),
  createdAt: DateTime.makeUnsafe(1_000),
  ...overrides,
});

/** The aliases the contacts belong to; each test's table starts with them. */
const shop = { domain: "alias.test", localPart: "shop" };
const bank = { domain: "alias.test", localPart: "bank" };

const seedAliases = AliasRepo.AliasRepo.use((repo) =>
  Effect.forEach(
    [
      { id: "al_1", ...shop },
      { id: "al_2", ...bank },
    ],
    (alias) => repo.insert({ ...alias, userId: "usr_1", mode: "forward", createdAt: 0 }),
    { concurrency: 1, discard: true },
  ),
);

/** Creates the contact on the seeded alias its `aliasId` names. */
const create = (repo: ContactRepo.ContactRepo["Service"], created: ContactRepo.NewContact) =>
  repo.create(created, created.aliasId === "al_2" ? bank : shop);

/**
 * Behaviour every ContactRepo backend must satisfy. Runners pass the emulator; each test gets
 * its own table on it.
 */
export const contactRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`ContactRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(
        effect: Effect.Effect<A, E, ContactRepo.ContactRepo | AliasRepo.AliasRepo>,
      ) =>
        Effect.andThen(seedAliases, effect).pipe(
          Effect.provide(
            Layer.mergeAll(ContactRepo.layer, AliasRepo.layer).pipe(Layer.provide(freshTable())),
          ),
        );

      it.effect("creates a contact, found by address in any case and by id", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ContactRepo.ContactRepo;
            yield* create(repo, contact());
            const stored = { ...contact(), isBlocked: false };

            expect(yield* repo.findByAddress("al_1", "orders@store.EXAMPLE")).toEqual(
              Option.some(stored),
            );
            expect(yield* repo.findById("al_1", "c1aaaaaaaaaaaaaa")).toEqual(Option.some(stored));
            // Contacts belong to one alias.
            expect(yield* repo.findByAddress("al_2", "orders@store.example")).toEqual(
              Option.none(),
            );
            expect(yield* repo.findById("al_2", "c1aaaaaaaaaaaaaa")).toEqual(Option.none());
            expect(yield* repo.findById("al_1", "nosuchcontactid0")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("keeps one contact per alias and address, even when created concurrently", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ContactRepo.ContactRepo;
            const results = yield* Effect.all(
              Arr.makeBy(4, (i) =>
                Effect.result(create(repo, contact({ id: `c${i}aaaaaaaaaaaaaa` }))),
              ),
              { concurrency: "unbounded" },
            );
            expect(Arr.filter(results, Result.isSuccess)).toHaveLength(1);
            expect(yield* repo.list("al_1")).toHaveLength(1);
            const error = yield* Effect.flip(create(repo, contact({ id: "c9aaaaaaaaaaaaaa" })));
            expect(error).toEqual(
              new ContactRepo.ContactExists({ address: "Orders@Store.example" }),
            );
          }),
        ),
      );

      it.effect("lists an alias's contacts oldest first, and only that alias's", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ContactRepo.ContactRepo;
            yield* create(
              repo,
              contact({ id: "new", address: "b@x.example", createdAt: DateTime.makeUnsafe(9) }),
            );
            yield* create(
              repo,
              contact({ id: "old", address: "a@x.example", createdAt: DateTime.makeUnsafe(2) }),
            );
            yield* create(repo, contact({ id: "other", aliasId: "al_2" }));

            expect(Arr.map(yield* repo.list("al_1"), (found) => found.id)).toEqual(["old", "new"]);
            expect(yield* repo.list("al_3")).toEqual([]);
          }),
        ),
      );

      it.effect("blocks and unblocks a contact", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ContactRepo.ContactRepo;
            yield* create(repo, contact());

            const blocked = yield* repo.setBlocked("al_1", "c1aaaaaaaaaaaaaa", true);
            expect(blocked.isBlocked).toBe(true);
            expect(yield* repo.findByAddress("al_1", "orders@store.example")).toEqual(
              Option.some(blocked),
            );
            const unblocked = yield* repo.setBlocked("al_1", "c1aaaaaaaaaaaaaa", false);
            expect(unblocked).toEqual({ ...contact(), isBlocked: false });

            expect(yield* Effect.flip(repo.setBlocked("al_2", "c1aaaaaaaaaaaaaa", true))).toEqual(
              new ContactRepo.NoSuchContact({ contactId: "c1aaaaaaaaaaaaaa" }),
            );
          }),
        ),
      );

      it.effect(
        "deletes a contact so its id finds nothing, even once the sender writes again",
        () =>
          withRepo(
            Effect.gen(function* () {
              const repo = yield* ContactRepo.ContactRepo;
              yield* create(repo, contact());
              yield* repo.delete("al_1", "c1aaaaaaaaaaaaaa");

              expect(yield* repo.findById("al_1", "c1aaaaaaaaaaaaaa")).toEqual(Option.none());
              expect(yield* repo.list("al_1")).toEqual([]);
              expect(yield* Effect.flip(repo.delete("al_1", "c1aaaaaaaaaaaaaa"))).toEqual(
                new ContactRepo.NoSuchContact({ contactId: "c1aaaaaaaaaaaaaa" }),
              );

              // The sender writes again: a new contact with a new id; the old id stays revoked.
              yield* create(repo, contact({ id: "c2bbbbbbbbbbbbbb" }));
              expect(yield* repo.findById("al_1", "c1aaaaaaaaaaaaaa")).toEqual(Option.none());
              expect(yield* repo.findById("al_1", "c2bbbbbbbbbbbbbb")).toEqual(
                Option.some(expect.objectContaining({ address: "Orders@Store.example" })),
              );
            }),
          ),
      );

      it.effect("refuses contacts for a deleted alias, and for another alias at its address", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ContactRepo.ContactRepo;
            const aliasRepo = yield* AliasRepo.AliasRepo;
            yield* aliasRepo.delete({ userId: "usr_1", domain: "alias.test", localPart: "shop" });
            const gone = new AliasRepo.NoSuchAlias({ address: "shop@alias.test" });

            expect(yield* Effect.flip(create(repo, contact()))).toEqual(gone);
            expect(yield* repo.list("al_1")).toEqual([]);

            // Recreated by its owner, the address has a new alias id; the old id gets nothing.
            yield* aliasRepo.insert({
              id: "al_3",
              userId: "usr_1",
              mode: "forward",
              createdAt: 1,
              ...shop,
            });
            expect(yield* Effect.flip(create(repo, contact()))).toEqual(gone);
            yield* repo.create(contact({ aliasId: "al_3" }), shop);
            expect(yield* repo.list("al_3")).toHaveLength(1);
          }),
        ),
      );
    });
  });
