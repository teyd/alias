import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ProxyRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

/**
 * Behaviour every ProxyRepo backend must satisfy (PLAN.md §20.29). Runners pass the emulator;
 * each test gets its own table on it.
 */
export const proxyRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`ProxyRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(effect: Effect.Effect<A, E, ProxyRepo.ProxyRepo>) =>
        effect.pipe(Effect.provide(ProxyRepo.layer.pipe(Layer.provide(freshTable()))));

      it.effect("caps an owner's fetches per minute, apart from other owners and hosts", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ProxyRepo.ProxyRepo;
            const now = at("2026-10-22T09:41:05Z");
            const owner = yield* Effect.forEach(
              Arr.range(1, 4),
              () => repo.reserveOwner("usr_1", now, 3),
              { concurrency: 4 },
            );
            expect(Arr.filter(owner, Boolean)).toHaveLength(3);
            expect(yield* repo.reserveOwner("usr_2", now, 3)).toBe(true);
            // Another key space: a host named like a user id has its own count.
            expect(yield* repo.reserveHost("usr_1", now, 3)).toBe(true);
            // The next minute starts again.
            expect(yield* repo.reserveOwner("usr_1", at("2026-10-22T09:42:00Z"), 3)).toBe(true);
          }),
        ),
      );

      it.effect("caps a host's fetches per minute", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ProxyRepo.ProxyRepo;
            const now = at("2026-10-22T09:41:59.999Z");
            const results = yield* Effect.forEach(
              Arr.range(1, 3),
              () => repo.reserveHost("img.shop.example", now, 2),
              { concurrency: 1 },
            );
            expect(results).toEqual([true, true, false]);
            expect(yield* repo.reserveHost("cdn.shop.example", now, 2)).toBe(true);
          }),
        ),
      );

      it.effect("remembers a failed host until its time is up", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* ProxyRepo.ProxyRepo;
            const now = at("2026-10-22T09:41:00Z");
            expect(yield* repo.downUntil("slow.example", now)).toEqual(Option.none());
            const until = at("2026-10-22T09:42:00Z");
            yield* repo.markDown("slow.example", until);
            expect(yield* repo.downUntil("slow.example", now)).toEqual(Option.some(until));
            expect(yield* repo.downUntil("other.example", now)).toEqual(Option.none());
            // Expired but not yet deleted by TTL: counts as gone.
            expect(yield* repo.downUntil("slow.example", until)).toEqual(Option.none());
            // A later failure moves it on.
            const later = at("2026-10-22T09:45:00Z");
            yield* repo.markDown("slow.example", later);
            expect(yield* repo.downUntil("slow.example", until)).toEqual(Option.some(later));
          }),
        ),
      );
    });
  });
