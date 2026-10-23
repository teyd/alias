import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { SentRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const forward: SentRepo.Sent = {
  messageId: "0100018f-ses-message",
  userId: "usr_1",
  kind: "forward",
  recipientId: Option.some("rcp_1"),
  sentAt: DateTime.makeUnsafe(0),
};

/**
 * Behaviour every SentRepo backend must satisfy. Runners pass the emulator; each test gets its
 * own table on it.
 */
export const sentRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`SentRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(effect: Effect.Effect<A, E, SentRepo.SentRepo>) =>
        effect.pipe(Effect.provide(SentRepo.layer.pipe(Layer.provide(freshTable()))));

      it.effect("finds a recorded send by its SES message id, and nothing for others", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* SentRepo.SentRepo;
            const reply: SentRepo.Sent = {
              ...forward,
              messageId: "0100018f-ses-reply",
              kind: "reply",
              recipientId: Option.none(),
            };
            yield* repo.record(forward);
            yield* repo.record(reply);
            // Recording again is harmless.
            yield* repo.record(forward);
            expect(yield* repo.find("usr_1", forward.messageId)).toEqual(Option.some(forward));
            expect(yield* repo.find("usr_1", reply.messageId)).toEqual(Option.some(reply));
            expect(yield* repo.find("usr_1", "unknown")).toEqual(Option.none());
            // Another user's event can't name this send.
            expect(yield* repo.find("usr_2", forward.messageId)).toEqual(Option.none());
          }),
        ),
      );

      it.effect("forgets a send after its lifetime, even before TTL deletes it", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* SentRepo.SentRepo;
            yield* repo.record(forward);
            yield* TestClock.adjust(Duration.subtract(SentRepo.LIFETIME, Duration.minutes(1)));
            expect(Option.isSome(yield* repo.find("usr_1", forward.messageId))).toBe(true);
            yield* TestClock.adjust(Duration.minutes(2));
            expect(yield* repo.find("usr_1", forward.messageId)).toEqual(Option.none());
          }),
        ),
      );
    });
  });
