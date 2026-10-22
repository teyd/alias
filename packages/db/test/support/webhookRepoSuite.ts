import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { WebhookRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

/** Stand-in for a sealed secret: the repository stores the bytes it is given. */
const sealed = (label: string) => new TextEncoder().encode(`sealed:${label}`);

const at = (millis: number) => DateTime.makeUnsafe(millis);

const webhook = (overrides: Partial<WebhookRepo.NewWebhook> = {}): WebhookRepo.NewWebhook => ({
  id: "wh_01",
  userId: "usr_1",
  url: "https://hooks.example.com/alias",
  eventTypes: ["mail.forwarded", "alias.created"],
  sealedSecret: sealed("first"),
  createdAt: at(1_000),
  ...overrides,
});

/**
 * Behaviour every WebhookRepo backend must satisfy. Runners pass the emulator; each test gets its
 * own table on it.
 */
export const webhookRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`WebhookRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(effect: Effect.Effect<A, E, WebhookRepo.WebhookRepo>) =>
        effect.pipe(Effect.provide(WebhookRepo.layer.pipe(Layer.provide(freshTable()))));

      const stored = {
        ...webhook(),
        previousSealedSecret: Option.none(),
        previousSecretUntil: Option.none(),
        isEnabled: true,
      };

      it.effect("stores webhooks in their user's partition, listed oldest first", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* WebhookRepo.WebhookRepo;
            yield* repo.create(webhook());
            yield* repo.create(webhook({ id: "wh_02", url: "https://b.example.com/" }));
            yield* repo.create(webhook({ id: "wh_03", userId: "usr_2" }));

            expect(yield* repo.find("usr_1", "wh_01")).toEqual(Option.some(stored));
            expect(yield* repo.find("usr_2", "wh_02")).toEqual(Option.none());
            expect(Arr.map(yield* repo.list("usr_1"), (found) => found.id)).toEqual([
              "wh_01",
              "wh_02",
            ]);
            expect(yield* repo.list("usr_9")).toEqual([]);
          }),
        ),
      );

      it.effect("changes what is given, and only the owner's webhook", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* WebhookRepo.WebhookRepo;
            yield* repo.create(webhook());
            expect(yield* repo.update("usr_1", "wh_01", { isEnabled: false })).toEqual({
              ...stored,
              isEnabled: false,
            });
            expect(
              yield* repo.update("usr_1", "wh_01", { eventTypes: ["recipient.bounced"] }),
            ).toEqual({ ...stored, isEnabled: false, eventTypes: ["recipient.bounced"] });
            expect(yield* repo.update("usr_1", "wh_01", {})).toMatchObject({ isEnabled: false });

            const foreign = yield* Effect.result(
              repo.update("usr_2", "wh_01", { isEnabled: true }),
            );
            expect(Result.isFailure(foreign) && foreign.failure._tag).toBe("NoSuchWebhook");
            // A failed condition must not have created an item for usr_2.
            expect(yield* repo.list("usr_2")).toEqual([]);
          }),
        ),
      );

      it.effect("rotates the secret, keeping the old one for the grace period", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* WebhookRepo.WebhookRepo;
            yield* repo.create(webhook());
            const rotated = yield* repo.rotateSecret("usr_1", "wh_01", sealed("second"), at(9_000));
            expect(rotated).toEqual({
              ...stored,
              sealedSecret: sealed("second"),
              previousSealedSecret: Option.some(sealed("first")),
              previousSecretUntil: Option.some(at(9_000)),
            });
            const again = yield* repo.rotateSecret("usr_1", "wh_01", sealed("third"), at(19_000));
            expect(again.previousSealedSecret).toEqual(Option.some(sealed("second")));
            const missing = yield* Effect.result(
              repo.rotateSecret("usr_1", "wh_09", sealed("x"), at(1)),
            );
            expect(Result.isFailure(missing) && missing.failure._tag).toBe("NoSuchWebhook");
          }),
        ),
      );

      it.effect("deletes only the owner's webhook", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* WebhookRepo.WebhookRepo;
            yield* repo.create(webhook());
            const foreign = yield* Effect.result(repo.delete("usr_2", "wh_01"));
            expect(Result.isFailure(foreign) && foreign.failure._tag).toBe("NoSuchWebhook");
            yield* repo.delete("usr_1", "wh_01");
            expect(yield* repo.list("usr_1")).toEqual([]);
            const again = yield* Effect.result(repo.delete("usr_1", "wh_01"));
            expect(Result.isFailure(again) && again.failure._tag).toBe("NoSuchWebhook");
          }),
        ),
      );
    });
  });
