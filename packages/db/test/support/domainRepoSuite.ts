import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { DomainRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);

const claim = (overrides: Partial<DomainRepo.NewDomain> = {}): DomainRepo.NewDomain => ({
  domain: "custom.example",
  userId: "usr_1",
  verificationToken: "tok_1",
  createdAt: at(1_000),
  ...overrides,
});

const MAX = 3;

const checks: ReadonlyArray<DomainRepo.RecordState> = [
  { type: "TXT", name: "custom.example", state: "ok" },
  { type: "MX", name: "custom.example", state: "missing" },
];

/**
 * Behaviour every DomainRepo backend must satisfy. Runners pass the emulator; each test gets its
 * own table on it.
 */
export const domainRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`DomainRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(effect: Effect.Effect<A, E, DomainRepo.DomainRepo>) =>
        effect.pipe(Effect.provide(DomainRepo.layer.pipe(Layer.provide(freshTable()))));

      it.effect("claims a domain as pending, found by name and listed for its owner", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DomainRepo.DomainRepo;
            const claimed = yield* repo.claim(claim(), MAX);
            const expected: DomainRepo.Domain = {
              domain: "custom.example",
              userId: "usr_1",
              status: "pending",
              verificationToken: "tok_1",
              dkimTokens: [],
              dkimZone: "dkim.amazonses.com",
              isCatchAllEnabled: false,
              createdAt: at(1_000),
              verifiedAt: Option.none(),
              checkedAt: Option.none(),
              checks: [],
              nextCheckAt: at(1_000),
            };
            expect(claimed).toEqual(expected);
            expect(yield* repo.find("custom.example")).toEqual(Option.some(expected));
            yield* repo.claim(claim({ domain: "older.example", createdAt: at(500) }), MAX);
            expect(Arr.map(yield* repo.listByUser("usr_1"), (d) => d.domain)).toEqual([
              "older.example",
              "custom.example",
            ]);
            expect(yield* repo.listByUser("usr_2")).toEqual([]);
            expect(yield* repo.find("other.example")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("lets one user claim a domain, even when two try at once", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DomainRepo.DomainRepo;
            const results = yield* Effect.all(
              [
                Effect.result(repo.claim(claim({ userId: "usr_1" }), MAX)),
                Effect.result(repo.claim(claim({ userId: "usr_2" }), MAX)),
              ],
              { concurrency: 2 },
            );
            expect(Arr.filter(results, Result.isSuccess)).toHaveLength(1);
            const again = yield* Effect.flip(repo.claim(claim({ userId: "usr_3" }), MAX));
            expect(again._tag).toBe("DomainTaken");
            // A refused claim takes none of the user's allowance.
            yield* Effect.forEach(
              ["a.example", "b.example", "c.example"],
              (domain) => repo.claim(claim({ userId: "usr_3", domain }), MAX),
              { concurrency: 1 },
            );
          }),
        ),
      );

      it.effect("caps domains per user atomically", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DomainRepo.DomainRepo;
            const results = yield* Effect.all(
              Arr.makeBy(5, (i) =>
                Effect.result(repo.claim(claim({ domain: `d${i}.example` }), MAX)),
              ),
              { concurrency: 5 },
            );
            expect(Arr.filter(results, Result.isSuccess)).toHaveLength(MAX);
            const refused = Arr.getFailures(results);
            expect(Arr.map(refused, (error) => error._tag)).toEqual([
              "TooManyDomains",
              "TooManyDomains",
            ]);
            expect(yield* repo.listByUser("usr_1")).toHaveLength(MAX);
          }),
        ),
      );

      it.effect("stores the SES identity, check results and the catch-all choice", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DomainRepo.DomainRepo;
            yield* repo.claim(claim(), MAX);
            const withIdentity = yield* repo.setIdentity("usr_1", "custom.example", {
              dkimTokens: ["t1", "t2", "t3"],
              dkimZone: "dkim.eu-west-1.amazonses.com",
            });
            expect(withIdentity.dkimTokens).toEqual(["t1", "t2", "t3"]);

            const verified = yield* repo.recordCheck("usr_1", "custom.example", {
              status: "verified",
              checks,
              checkedAt: at(2_000),
              verifiedAt: Option.some(at(2_000)),
              nextCheckAt: at(90_000),
            });
            expect(verified).toMatchObject({
              status: "verified",
              checks,
              checkedAt: Option.some(at(2_000)),
              verifiedAt: Option.some(at(2_000)),
              nextCheckAt: at(90_000),
              dkimZone: "dkim.eu-west-1.amazonses.com",
            });
            const pending = yield* repo.recordCheck("usr_1", "custom.example", {
              status: "pending",
              checks: [],
              checkedAt: at(3_000),
              verifiedAt: Option.none(),
              nextCheckAt: at(4_000),
            });
            expect(pending.verifiedAt).toEqual(Option.none());

            const caught = yield* repo.setCatchAll("usr_1", "custom.example", true);
            expect(caught.isCatchAllEnabled).toBe(true);
            expect(yield* repo.find("custom.example")).toEqual(Option.some(caught));
          }),
        ),
      );

      it.effect("changes only the owner's domain", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DomainRepo.DomainRepo;
            yield* repo.claim(claim(), MAX);
            const errors = yield* Effect.all(
              [
                Effect.flip(repo.setCatchAll("usr_2", "custom.example", true)),
                Effect.flip(
                  repo.setIdentity("usr_2", "custom.example", { dkimTokens: [], dkimZone: "x" }),
                ),
                Effect.flip(
                  repo.recordCheck("usr_2", "custom.example", {
                    status: "verified",
                    checks: [],
                    checkedAt: at(1),
                    verifiedAt: Option.none(),
                    nextCheckAt: at(1),
                  }),
                ),
                Effect.flip(repo.remove("usr_2", "custom.example")),
                Effect.flip(repo.setCatchAll("usr_1", "missing.example", true)),
              ],
              { concurrency: 1 },
            );
            expect(Arr.map(errors, (error) => error._tag)).toEqual(
              Arr.makeBy(5, () => "NoSuchDomain"),
            );
            expect(
              Option.map(yield* repo.find("custom.example"), (d) => d.isCatchAllEnabled),
            ).toEqual(Option.some(false));
          }),
        ),
      );

      it.effect("removing a domain frees it and the owner's allowance", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DomainRepo.DomainRepo;
            yield* Effect.forEach(
              ["a.example", "b.example", "c.example"],
              (domain) => repo.claim(claim({ domain }), MAX),
              { concurrency: 1 },
            );
            yield* repo.remove("usr_1", "a.example");
            expect(yield* repo.find("a.example")).toEqual(Option.none());
            expect(Arr.map(yield* repo.listByUser("usr_1"), (d) => d.domain)).toEqual([
              "b.example",
              "c.example",
            ]);
            yield* repo.claim(claim({ domain: "d.example" }), MAX);
            yield* repo.claim(claim({ domain: "a.example", userId: "usr_2" }), MAX);
            const gone = yield* Effect.flip(repo.remove("usr_1", "a.example"));
            expect(gone._tag).toBe("NoSuchDomain");
          }),
        ),
      );

      it.effect("lists due domains soonest first", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* DomainRepo.DomainRepo;
            yield* repo.claim(claim({ domain: "late.example", createdAt: at(3_000) }), MAX);
            yield* repo.claim(
              claim({ domain: "early.example", createdAt: at(1_000), userId: "usr_2" }),
              MAX,
            );
            yield* repo.claim(
              claim({ domain: "mid.example", createdAt: at(2_000), userId: "usr_3" }),
              MAX,
            );
            const names = (domains: ReadonlyArray<DomainRepo.Domain>) =>
              Arr.map(domains, (d) => d.domain);

            expect(names(yield* repo.due(at(2_000), 10))).toEqual(["early.example", "mid.example"]);
            expect(names(yield* repo.due(at(5_000), 1))).toEqual(["early.example"]);
            yield* repo.recordCheck("usr_2", "early.example", {
              status: "pending",
              checks: [],
              checkedAt: at(5_000),
              verifiedAt: Option.none(),
              nextCheckAt: at(10_000),
            });
            expect(names(yield* repo.due(at(5_000), 10))).toEqual(["mid.example", "late.example"]);
            expect(names(yield* repo.due(at(10_000), 10))).toEqual([
              "mid.example",
              "late.example",
              "early.example",
            ]);
          }),
        ),
      );
    });
  });
