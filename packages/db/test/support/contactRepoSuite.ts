import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ContactRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const contact = (overrides: Partial<ContactRepo.NewContact> = {}): ContactRepo.NewContact => ({
  id: "c1aaaaaaaaaaaaaa",
  aliasId: "al_1",
  address: "Orders@Store.example",
  name: Option.some("Store"),
  createdAt: DateTime.makeUnsafe(1_000),
  ...overrides,
});

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
      const withRepo = <A, E>(effect: Effect.Effect<A, E, ContactRepo.ContactRepo>) =>
        effect.pipe(Effect.provide(ContactRepo.layer.pipe(Layer.provide(freshTable()))));

      it.effect("creates a contact, found by address in any case and by id", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ContactRepo.ContactRepo;
            yield* repo.create(contact());
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
                Effect.result(repo.create(contact({ id: `c${i}aaaaaaaaaaaaaa` }))),
              ),
              { concurrency: "unbounded" },
            );
            expect(Arr.filter(results, Result.isSuccess)).toHaveLength(1);
            expect(yield* repo.list("al_1")).toHaveLength(1);
            const error = yield* Effect.flip(repo.create(contact({ id: "c9aaaaaaaaaaaaaa" })));
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
            yield* repo.create(
              contact({ id: "new", address: "b@x.example", createdAt: DateTime.makeUnsafe(9) }),
            );
            yield* repo.create(
              contact({ id: "old", address: "a@x.example", createdAt: DateTime.makeUnsafe(2) }),
            );
            yield* repo.create(contact({ id: "other", aliasId: "al_2" }));

            expect(Arr.map(yield* repo.list("al_1"), (found) => found.id)).toEqual(["old", "new"]);
            expect(yield* repo.list("al_3")).toEqual([]);
          }),
        ),
      );

      it.effect("blocks and unblocks a contact", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ContactRepo.ContactRepo;
            yield* repo.create(contact());

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
              yield* repo.create(contact());
              yield* repo.delete("al_1", "c1aaaaaaaaaaaaaa");

              expect(yield* repo.findById("al_1", "c1aaaaaaaaaaaaaa")).toEqual(Option.none());
              expect(yield* repo.list("al_1")).toEqual([]);
              expect(yield* Effect.flip(repo.delete("al_1", "c1aaaaaaaaaaaaaa"))).toEqual(
                new ContactRepo.NoSuchContact({ contactId: "c1aaaaaaaaaaaaaa" }),
              );

              // The sender writes again: a new contact with a new id; the old id stays revoked.
              yield* repo.create(contact({ id: "c2bbbbbbbbbbbbbb" }));
              expect(yield* repo.findById("al_1", "c1aaaaaaaaaaaaaa")).toEqual(Option.none());
              expect(yield* repo.findById("al_1", "c2bbbbbbbbbbbbbb")).toEqual(
                Option.some(expect.objectContaining({ address: "Orders@Store.example" })),
              );
            }),
          ),
      );
    });
  });
