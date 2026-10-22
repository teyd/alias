import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { RecipientRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const recipient = (
  overrides: Partial<RecipientRepo.NewRecipient> = {},
): RecipientRepo.NewRecipient => ({
  id: "rcp_1",
  userId: "usr_1",
  address: "ada@example.com",
  createdAt: at(1_000),
  ...overrides,
});

const confirmation = (
  overrides: Partial<RecipientRepo.Confirmation> = {},
): RecipientRepo.Confirmation => ({
  tokenHash: "hash_1",
  expiresAt: at(100_000),
  sentAt: at(1_000),
  ...overrides,
});

const MAX_PENDING = 3;

/** Finds the recipient or fails the test. */
const get = (repo: RecipientRepo.RecipientRepo["Service"], userId: string, id: string) =>
  Effect.flatMap(repo.find(userId, id), (found) => Effect.fromOption(found));

/**
 * Behaviour every RecipientRepo backend must satisfy. Runners pass the emulator; each test gets
 * its own table on it.
 */
export const recipientRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`RecipientRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(effect: Effect.Effect<A, E, RecipientRepo.RecipientRepo>) =>
        effect.pipe(Effect.provide(RecipientRepo.layer.pipe(Layer.provide(freshTable()))));

      it.effect("adds a pending recipient and lists the user's recipients oldest first", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            yield* repo.add(
              recipient({ id: "rcp_new", address: "b@example.com", createdAt: at(2_000) }),
              confirmation(),
              MAX_PENDING,
            );
            yield* repo.add(
              recipient({ id: "rcp_old", address: "z@example.com" }),
              confirmation(),
              MAX_PENDING,
            );
            yield* repo.add(
              recipient({ id: "rcp_other", userId: "usr_2" }),
              confirmation(),
              MAX_PENDING,
            );

            const listed = yield* repo.list("usr_1");
            expect(Arr.map(listed, (row) => row.id)).toEqual(["rcp_old", "rcp_new"]);
            expect(listed[0]).toEqual({
              id: "rcp_old",
              userId: "usr_1",
              address: "z@example.com",
              createdAt: at(1_000),
              verifiedAt: Option.none(),
              lastSentAt: at(1_000),
              isDefault: false,
              bouncedAt: Option.none(),
              complainedAt: Option.none(),
            });
            expect(Option.map(yield* repo.find("usr_2", "rcp_other"), (r) => r.address)).toEqual(
              Option.some("ada@example.com"),
            );
            expect(Option.isNone(yield* repo.find("usr_2", "rcp_old"))).toBe(true);
          }),
        ),
      );

      it.effect("rejects an address the user already has", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            yield* repo.add(recipient(), confirmation(), MAX_PENDING);
            const error = yield* Effect.flip(
              repo.add(recipient({ id: "rcp_2" }), confirmation(), MAX_PENDING),
            );
            expect(error).toEqual(
              new RecipientRepo.RecipientExists({ address: "ada@example.com" }),
            );
            expect(yield* repo.list("usr_1")).toHaveLength(1);
          }),
        ),
      );

      it.effect("caps pending recipients atomically, even under concurrent adds", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            const results = yield* Effect.forEach(
              Arr.range(1, 6),
              (n) =>
                Effect.result(
                  repo.add(
                    recipient({ id: `rcp_${n}`, address: `a${n}@example.com` }),
                    confirmation(),
                    MAX_PENDING,
                  ),
                ),
              { concurrency: "unbounded" },
            );
            const added = Arr.filter(results, Result.isSuccess);
            const stored = yield* repo.list("usr_1");
            // Racing transactions on one item may also cancel each other (TransactionConflict),
            // so fewer than the limit can win, but never more, and every winner is stored.
            expect(stored.length).toBeLessThanOrEqual(MAX_PENDING);
            expect(stored).toHaveLength(added.length);
          }),
        ),
      );

      it.effect("frees a pending slot when a recipient is confirmed or deleted", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            yield* Effect.forEach(
              Arr.range(1, MAX_PENDING),
              (n) =>
                repo.add(
                  recipient({ id: `rcp_${n}`, address: `a${n}@example.com` }),
                  confirmation({ tokenHash: `hash_${n}` }),
                  MAX_PENDING,
                ),
              { concurrency: 1 },
            );
            const full = yield* Effect.flip(
              repo.add(
                recipient({ id: "rcp_4", address: "a4@example.com" }),
                confirmation(),
                MAX_PENDING,
              ),
            );
            expect(full).toEqual(
              new RecipientRepo.TooManyPendingRecipients({ limit: MAX_PENDING }),
            );

            yield* repo.confirm(yield* get(repo, "usr_1", "rcp_1"), "hash_1", at(2_000));
            yield* repo.add(
              recipient({ id: "rcp_4", address: "a4@example.com" }),
              confirmation(),
              MAX_PENDING,
            );
            yield* repo.delete("usr_1", "rcp_2");
            yield* repo.add(
              recipient({ id: "rcp_5", address: "a5@example.com" }),
              confirmation(),
              MAX_PENDING,
            );
            // Deleting a verified recipient doesn't free a slot it never held.
            yield* repo.delete("usr_1", "rcp_1");
            expect(
              yield* Effect.flip(
                repo.add(
                  recipient({ id: "rcp_6", address: "a6@example.com" }),
                  confirmation(),
                  MAX_PENDING,
                ),
              ),
            ).toBeInstanceOf(RecipientRepo.TooManyPendingRecipients);
          }),
        ),
      );

      it.effect("confirms with the right live token exactly once", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            yield* repo.add(recipient(), confirmation(), MAX_PENDING);
            const pending = yield* get(repo, "usr_1", "rcp_1");
            const mismatch = new RecipientRepo.ConfirmationMismatch({ recipientId: "rcp_1" });

            expect(yield* Effect.flip(repo.confirm(pending, "wrong", at(2_000)))).toEqual(mismatch);
            yield* repo.confirm(pending, "hash_1", at(2_000));
            expect(yield* get(repo, "usr_1", "rcp_1")).toMatchObject({
              verifiedAt: Option.some(at(2_000)),
              isDefault: true,
            });
            expect(yield* Effect.flip(repo.confirm(pending, "hash_1", at(3_000)))).toEqual(
              mismatch,
            );
          }),
        ),
      );

      it.effect("refuses an expired token, and a renewed token replaces the old one", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            yield* repo.add(recipient(), confirmation(), MAX_PENDING);
            const pending = yield* get(repo, "usr_1", "rcp_1");
            expect(yield* Effect.flip(repo.confirm(pending, "hash_1", at(100_000)))).toBeInstanceOf(
              RecipientRepo.ConfirmationMismatch,
            );

            const renewed = confirmation({
              tokenHash: "hash_2",
              expiresAt: at(300_000),
              sentAt: at(200_000),
            });
            yield* repo.renewConfirmation(pending, renewed);
            expect((yield* get(repo, "usr_1", "rcp_1")).lastSentAt).toEqual(at(200_000));
            // The first read is stale now: renewing from it again loses the race.
            expect(yield* Effect.flip(repo.renewConfirmation(pending, renewed))).toEqual(
              new RecipientRepo.RecipientChanged({ recipientId: "rcp_1" }),
            );
            expect(yield* Effect.flip(repo.confirm(pending, "hash_1", at(200_001)))).toBeInstanceOf(
              RecipientRepo.ConfirmationMismatch,
            );
            yield* repo.confirm(pending, "hash_2", at(200_001));
          }),
        ),
      );

      it.effect("won't renew the token of a verified recipient", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            yield* repo.add(recipient(), confirmation(), MAX_PENDING);
            const pending = yield* get(repo, "usr_1", "rcp_1");
            yield* repo.confirm(pending, "hash_1", at(2_000));
            expect(
              yield* Effect.flip(repo.renewConfirmation(pending, confirmation())),
            ).toBeInstanceOf(RecipientRepo.RecipientChanged);
          }),
        ),
      );

      it.effect("defaults to the oldest verified recipient until the user picks one", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            const addVerified = (id: string, address: string, createdAt: number) =>
              repo
                .add(
                  recipient({ id, address, createdAt: at(createdAt) }),
                  confirmation(),
                  MAX_PENDING,
                )
                .pipe(
                  Effect.andThen(get(repo, "usr_1", id)),
                  Effect.flatMap((added) => repo.confirm(added, "hash_1", at(5_000))),
                );
            yield* repo.add(
              recipient({ id: "rcp_pending", address: "p@example.com", createdAt: at(1) }),
              confirmation(),
              MAX_PENDING,
            );
            yield* addVerified("rcp_a", "a@example.com", 10);
            yield* addVerified("rcp_b", "b@example.com", 20);
            const defaults = Effect.map(repo.list("usr_1"), (rows) =>
              Arr.map(
                Arr.filter(rows, (row) => row.isDefault),
                (row) => row.id,
              ),
            );
            expect(yield* defaults).toEqual(["rcp_a"]);

            yield* repo.setDefault(yield* get(repo, "usr_1", "rcp_b"));
            expect(yield* defaults).toEqual(["rcp_b"]);

            // A pending recipient can't be the default.
            expect(
              yield* Effect.flip(repo.setDefault(yield* get(repo, "usr_1", "rcp_pending"))),
            ).toEqual(new RecipientRepo.RecipientChanged({ recipientId: "rcp_pending" }));

            // Deleting the default falls back to the oldest verified recipient again.
            yield* repo.delete("usr_1", "rcp_b");
            expect(yield* defaults).toEqual(["rcp_a"]);
          }),
        ),
      );

      it.effect("deletes only the owner's recipient, freeing its address", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            yield* repo.add(recipient(), confirmation(), MAX_PENDING);
            const missing = new RecipientRepo.NoSuchRecipient({ recipientId: "rcp_1" });

            expect(yield* Effect.flip(repo.delete("usr_2", "rcp_1"))).toEqual(missing);
            yield* repo.delete("usr_1", "rcp_1");
            expect(yield* repo.list("usr_1")).toEqual([]);
            expect(yield* Effect.flip(repo.delete("usr_1", "rcp_1"))).toEqual(missing);
            yield* repo.add(recipient({ id: "rcp_2" }), confirmation(), MAX_PENDING);
          }),
        ),
      );

      it.effect("allows a fixed number of confirmation mails per user and UTC day", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            const day = 24 * 60 * 60 * 1000;
            const lateOnDayOne = at(day + day - 1);
            yield* Effect.forEach(Arr.range(1, 2), () => repo.reserveMail("usr_1", at(day), 2), {
              concurrency: "unbounded",
            });
            expect(yield* Effect.flip(repo.reserveMail("usr_1", lateOnDayOne, 2))).toEqual(
              new RecipientRepo.MailQuotaExceeded({ resetsAt: at(2 * day) }),
            );
            // Another user has their own allowance, and the next day starts afresh.
            yield* repo.reserveMail("usr_2", lateOnDayOne, 2);
            yield* repo.reserveMail("usr_1", at(2 * day), 2);
          }),
        ),
      );
      it.effect("records bounces and complaints; a resent confirmation clears the bounce", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* RecipientRepo.RecipientRepo;
            yield* repo.add(recipient(), confirmation(), MAX_PENDING);

            expect(yield* repo.markBounced("usr_1", "ADA@example.com", at(5_000))).toBe(true);
            expect(yield* repo.markComplained("usr_1", "ada@example.com", at(6_000))).toBe(true);
            const marked = yield* get(repo, "usr_1", "rcp_1");
            expect(marked).toMatchObject({
              bouncedAt: Option.some(at(5_000)),
              complainedAt: Option.some(at(6_000)),
            });

            // Another user's address, or an unknown one, is left alone and creates nothing.
            expect(yield* repo.markBounced("usr_2", "ada@example.com", at(5_000))).toBe(false);
            expect(yield* repo.markComplained("usr_1", "nobody@example.com", at(5_000))).toBe(
              false,
            );
            expect(yield* repo.list("usr_2")).toEqual([]);
            expect(yield* repo.list("usr_1")).toHaveLength(1);

            yield* repo.renewConfirmation(marked, confirmation({ sentAt: at(7_000) }));
            expect(yield* get(repo, "usr_1", "rcp_1")).toMatchObject({
              bouncedAt: Option.none(),
              complainedAt: Option.some(at(6_000)),
            });
          }),
        ),
      );
    });
  });
