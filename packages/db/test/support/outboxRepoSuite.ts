import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { OutboxRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);
const hour = 3_600_000;

const draft = (overrides: Partial<OutboxRepo.NewDraft> = {}): OutboxRepo.NewDraft => ({
  id: "drf_1",
  userId: "usr_1",
  aliasId: "al_1",
  aliasDomain: "alias.test",
  aliasLocal: "shop",
  contactId: "c0ntact00000001x",
  to: "grace@store.example",
  contactName: Option.some("Grace"),
  subject: "Your order",
  text: "Hello",
  clientName: "Claude",
  createdAt: at(0),
  pendingUntil: at(hour),
  expiresAt: at(24 * hour),
  ...overrides,
});

const tag = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure._tag : "Success";

/**
 * Behaviour every OutboxRepo backend must satisfy. Runners pass the emulator; each test gets its
 * own table on it.
 */
export const outboxRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`OutboxRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      // Tests in one layer share its TestClock, so each starts it at 0 again.
      const withRepo = <A, E>(effect: Effect.Effect<A, E, OutboxRepo.OutboxRepo>) =>
        TestClock.setTime(0).pipe(
          Effect.andThen(effect),
          Effect.provide(OutboxRepo.layer.pipe(Layer.provide(freshTable()))),
        );

      it.effect("keeps a draft for its user only, until its TTL", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* OutboxRepo.OutboxRepo;
            yield* repo.create(draft());
            yield* repo.create(draft({ id: "drf_2", contactName: Option.none() }));
            expect(yield* repo.find("usr_1", "drf_1")).toEqual(
              Option.some({ ...draft(), status: "pending" }),
            );
            expect(yield* repo.find("usr_1", "drf_2")).toEqual(
              Option.some({
                ...draft({ id: "drf_2", contactName: Option.none() }),
                status: "pending",
              }),
            );
            expect(yield* repo.find("usr_2", "drf_1")).toEqual(Option.none());
            yield* TestClock.setTime(24 * hour);
            expect(yield* repo.find("usr_1", "drf_1")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("sends a draft once, even when two sends race", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* OutboxRepo.OutboxRepo;
            yield* repo.create(draft());
            const results = yield* Effect.all(
              Arr.makeBy(3, () => Effect.result(repo.close("usr_1", "drf_1", "sent", at(1_000)))),
              { concurrency: "unbounded" },
            );
            expect(Arr.map(results, tag).toSorted()).toEqual([
              "DraftNotPending",
              "DraftNotPending",
              "Success",
            ]);
            expect(Option.map(yield* repo.find("usr_1", "drf_1"), (found) => found.status)).toEqual(
              Option.some("sent"),
            );
            const discard = yield* Effect.result(
              repo.close("usr_1", "drf_1", "discarded", at(2_000)),
            );
            expect(tag(discard)).toBe("DraftNotPending");
          }),
        ),
      );

      it.effect("lets a pending draft lapse, and refuses other users and unknown drafts", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* OutboxRepo.OutboxRepo;
            yield* repo.create(draft());
            expect(tag(yield* Effect.result(repo.close("usr_1", "drf_1", "sent", at(hour))))).toBe(
              "DraftNotPending",
            );
            expect(tag(yield* Effect.result(repo.close("usr_2", "drf_1", "sent", at(0))))).toBe(
              "DraftNotPending",
            );
            expect(tag(yield* Effect.result(repo.close("usr_1", "drf_9", "sent", at(0))))).toBe(
              "DraftNotPending",
            );
            const discarded = yield* repo.close("usr_1", "drf_1", "discarded", at(hour - 1));
            expect(discarded.status).toBe("discarded");
          }),
        ),
      );

      it.effect("reopens a sent draft after a failed send, and nothing else", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* OutboxRepo.OutboxRepo;
            yield* repo.create(draft());
            yield* repo.create(draft({ id: "drf_2" }));
            yield* repo.close("usr_1", "drf_1", "sent", at(0));
            yield* repo.close("usr_1", "drf_2", "discarded", at(0));
            yield* repo.reopen("usr_1", "drf_1");
            yield* repo.reopen("usr_1", "drf_2");
            yield* repo.reopen("usr_1", "drf_9");
            const status = (id: string) =>
              Effect.map(
                repo.find("usr_1", id),
                Option.map((found) => found.status),
              );
            expect(yield* status("drf_1")).toEqual(Option.some("pending"));
            expect(yield* status("drf_2")).toEqual(Option.some("discarded"));
            expect(yield* status("drf_9")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("counts sends per user and day, up to the cap", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* OutboxRepo.OutboxRepo;
            const now = DateTime.makeUnsafe("2026-10-22T09:00:00Z");
            const results = yield* Effect.all(
              Arr.makeBy(4, () => repo.reserveSend("usr_1", now, 3)),
              { concurrency: "unbounded" },
            );
            expect(Arr.filter(results, (ok) => ok)).toHaveLength(3);
            expect(yield* repo.reserveSend("usr_2", now, 3)).toBe(true);
            expect(
              yield* repo.reserveSend("usr_1", DateTime.makeUnsafe("2026-10-23T00:00:00Z"), 3),
            ).toBe(true);
          }),
        ),
      );
    });
  });
