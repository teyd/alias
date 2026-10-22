import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { DeviceRepo, TokenRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const grant = (overrides: Partial<DeviceRepo.DeviceGrant> = {}): DeviceRepo.DeviceGrant => ({
  deviceHash: "d".repeat(64),
  userCode: "BCDFGHJK",
  clientId: "alias-cli",
  scopes: ["aliases:read", "aliases:write"],
  createdAt: at(0),
  expiresAt: at(600_000),
  pollSeconds: 5,
  nextPollAt: at(0),
  decision: DeviceRepo.Pending(),
  ...overrides,
});

const ada = { userId: "usr_1", username: "ada" };

const token = (hash = "t".repeat(64)): TokenRepo.NewToken => ({
  id: "tok_01",
  hash,
  ...ada,
  name: "Alias CLI",
  scopes: ["aliases:read", "aliases:write"],
  hint: "AbCd",
  createdAt: at(10_000),
  expiresAt: Option.some(at(90 * 86_400_000)),
});

type Repos = DeviceRepo.DeviceRepo | TokenRepo.TokenRepo;

/**
 * Behaviour every DeviceRepo backend must satisfy. Runners pass the emulator; each test gets its
 * own table on it.
 */
export const deviceRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`DeviceRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      // The layer's TestClock outlives each test, so every test starts the clock at zero again.
      const withRepo = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
        Effect.andThen(TestClock.setTime(0), effect).pipe(
          Effect.provide(
            Layer.mergeAll(DeviceRepo.layer, TokenRepo.layer).pipe(Layer.provide(freshTable())),
          ),
        );

      it.effect("finds a grant by its user code until it expires, and claims each code once", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeviceRepo.DeviceRepo;
            yield* repo.create(grant());
            expect(yield* repo.findByUserCode("BCDFGHJK")).toEqual(Option.some(grant()));
            expect(yield* repo.findByUserCode("BCDFGHJL")).toEqual(Option.none());

            const taken = yield* Effect.flip(repo.create(grant({ deviceHash: "e".repeat(64) })));
            expect(taken).toBeInstanceOf(DeviceRepo.UserCodeTaken);

            yield* TestClock.setTime(600_000);
            expect(yield* repo.findByUserCode("BCDFGHJK")).toEqual(Option.none());
            // An expired claim TTL hasn't removed yet doesn't block a new grant.
            yield* repo.create(
              grant({
                deviceHash: "e".repeat(64),
                createdAt: at(600_000),
                expiresAt: at(1_200_000),
              }),
            );
            expect(
              Option.map(yield* repo.findByUserCode("BCDFGHJK"), (found) => found.deviceHash),
            ).toEqual(Option.some("e".repeat(64)));
          }),
        ),
      );

      it.effect("decides a pending grant once, never an expired one", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeviceRepo.DeviceRepo;
            yield* repo.create(grant());
            yield* repo.decide("BCDFGHJK", DeviceRepo.Approved(ada));
            expect(
              Option.map(yield* repo.findByUserCode("BCDFGHJK"), (found) => found.decision),
            ).toEqual(Option.some(DeviceRepo.Approved(ada)));
            const again = yield* Effect.flip(repo.decide("BCDFGHJK", DeviceRepo.Denied()));
            expect(again).toBeInstanceOf(DeviceRepo.NoSuchDeviceGrant);

            yield* repo.create(grant({ deviceHash: "e".repeat(64), userCode: "CCCCCCCC" }));
            yield* TestClock.setTime(600_000);
            const late = yield* Effect.flip(repo.decide("CCCCCCCC", DeviceRepo.Approved(ada)));
            expect(late).toBeInstanceOf(DeviceRepo.NoSuchDeviceGrant);
            const unknown = yield* Effect.flip(repo.decide("DDDDDDDD", DeviceRepo.Denied()));
            expect(unknown).toBeInstanceOf(DeviceRepo.NoSuchDeviceGrant);
          }),
        ),
      );

      it.effect("slows down a device that polls before its interval, by 5 seconds each time", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeviceRepo.DeviceRepo;
            expect(yield* repo.poll("x".repeat(64))).toEqual(Option.none());
            yield* repo.create(grant());

            const first = yield* repo.poll(grant().deviceHash);
            expect(
              Option.map(first, (polled) => [polled.isTooSoon, polled.grant.pollSeconds]),
            ).toEqual(Option.some([false, 5]));
            yield* TestClock.setTime(2_000);
            const early = yield* repo.poll(grant().deviceHash);
            expect(
              Option.map(early, (polled) => [polled.isTooSoon, polled.grant.pollSeconds]),
            ).toEqual(Option.some([true, 10]));
            // The new interval counts from the early poll: 2 s + 10 s.
            yield* TestClock.setTime(11_000);
            expect(
              Option.map(yield* repo.poll(grant().deviceHash), (polled) => polled.isTooSoon),
            ).toEqual(Option.some(true));
            yield* TestClock.setTime(30_000);
            const patient = yield* repo.poll(grant().deviceHash);
            expect(
              Option.map(patient, (polled) => [polled.isTooSoon, polled.grant.pollSeconds]),
            ).toEqual(Option.some([false, 15]));
          }),
        ),
      );

      it.effect("lets only one of two concurrent polls through", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeviceRepo.DeviceRepo;
            yield* repo.create(grant());
            const polls = yield* Effect.all(
              [repo.poll(grant().deviceHash), repo.poll(grant().deviceHash)],
              { concurrency: 2 },
            );
            const tooSoon = polls.filter((polled) => Option.exists(polled, (p) => p.isTooSoon));
            expect(tooSoon).toHaveLength(1);
          }),
        ),
      );

      it.effect("redeems an approved grant into exactly one token, and forgets it", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeviceRepo.DeviceRepo;
            const tokens = yield* TokenRepo.TokenRepo;
            yield* repo.create(grant());
            yield* repo.decide("BCDFGHJK", DeviceRepo.Approved(ada));
            const approved = grant({ decision: DeviceRepo.Approved(ada) });

            yield* repo.redeem(approved, token());
            const twice = yield* Effect.flip(repo.redeem(approved, token("u".repeat(64))));
            expect(twice).toBeInstanceOf(DeviceRepo.GrantRedeemed);

            expect(Option.isSome(yield* tokens.findByHash("t".repeat(64)))).toBe(true);
            expect(yield* tokens.findByHash("u".repeat(64))).toEqual(Option.none());
            expect(yield* repo.poll(grant().deviceHash)).toEqual(Option.none());
            expect(yield* repo.findByUserCode("BCDFGHJK")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("won't redeem a grant that isn't approved", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeviceRepo.DeviceRepo;
            yield* repo.create(grant());
            const pending = yield* Effect.flip(
              repo.redeem(grant({ decision: DeviceRepo.Approved(ada) }), token()),
            );
            expect(pending).toBeInstanceOf(DeviceRepo.GrantRedeemed);
            yield* repo.decide("BCDFGHJK", DeviceRepo.Denied());
            yield* repo.remove(grant());
            expect(yield* repo.poll(grant().deviceHash)).toEqual(Option.none());
            expect(yield* repo.findByUserCode("BCDFGHJK")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("counts requests per source and misses per user, per hour", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DeviceRepo.DeviceRepo;
            const now = at(3_600_000);
            expect(yield* repo.reserveRequest("src", now, 2)).toBe(true);
            expect(yield* repo.reserveRequest("src", now, 2)).toBe(true);
            expect(yield* repo.reserveRequest("src", now, 2)).toBe(false);
            expect(yield* repo.reserveRequest("other", now, 2)).toBe(true);
            expect(yield* repo.reserveRequest("src", at(7_200_000), 2)).toBe(true);

            expect(yield* repo.misses("usr_1", now)).toBe(0);
            yield* repo.recordMiss("usr_1", now, 3);
            yield* repo.recordMiss("usr_1", now, 3);
            expect(yield* repo.misses("usr_1", now)).toBe(2);
            expect(yield* repo.misses("usr_2", now)).toBe(0);
            expect(yield* repo.misses("usr_1", at(7_200_000))).toBe(0);
          }),
        ),
      );
    });
  });
