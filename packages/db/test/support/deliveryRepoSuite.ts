import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { DeliveryRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const delivery: DeliveryRepo.Delivery = { messageId: "msg_1", recipient: "shop@alias.test" };

/** A week from the test clock's start (epoch 0). */
const inAWeek = DateTime.makeUnsafe(Duration.toMillis(Duration.weeks(1)));

/**
 * Behaviour every DeliveryRepo backend must satisfy. Runners pass the emulator; each test gets
 * its own table on it.
 */
export const deliveryRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`DeliveryRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(effect: Effect.Effect<A, E, DeliveryRepo.DeliveryRepo>) =>
        effect.pipe(Effect.provide(DeliveryRepo.layer.pipe(Layer.provide(freshTable()))));

      it.effect("claims a delivery once; a redelivery finds the claim", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeliveryRepo.DeliveryRepo;
            expect(yield* repo.claim(delivery, inAWeek)).toBe(true);
            expect(yield* repo.claim(delivery, inAWeek)).toBe(false);
            expect(yield* repo.claim({ ...delivery, recipient: "SHOP@Alias.test" }, inAWeek)).toBe(
              false,
            );
          }),
        ),
      );

      it.effect("claims each recipient of a message and each message separately", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeliveryRepo.DeliveryRepo;
            expect(yield* repo.claim(delivery, inAWeek)).toBe(true);
            expect(yield* repo.claim({ ...delivery, recipient: "news@alias.test" }, inAWeek)).toBe(
              true,
            );
            expect(yield* repo.claim({ ...delivery, messageId: "msg_2" }, inAWeek)).toBe(true);
          }),
        ),
      );

      it.effect("lets only one of many concurrent claims win", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeliveryRepo.DeliveryRepo;
            const results = yield* Effect.all(
              Array.from({ length: 8 }, () => repo.claim(delivery, inAWeek)),
              { concurrency: "unbounded" },
            );
            expect(results.filter((won) => won)).toHaveLength(1);
          }),
        ),
      );

      it.effect("can be claimed again once released, and releasing twice is fine", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeliveryRepo.DeliveryRepo;
            yield* repo.claim(delivery, inAWeek);
            yield* repo.release(delivery);
            yield* repo.release(delivery);
            expect(yield* repo.claim(delivery, inAWeek)).toBe(true);
          }),
        ),
      );

      it.effect("treats an expired claim as absent, even before TTL deletes it", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeliveryRepo.DeliveryRepo;
            yield* repo.claim(delivery, DateTime.makeUnsafe(60_000));
            expect(yield* repo.claim(delivery, inAWeek)).toBe(false);
            yield* TestClock.adjust(Duration.minutes(2));
            expect(yield* repo.claim(delivery, inAWeek)).toBe(true);
          }),
        ),
      );
    });
  });
