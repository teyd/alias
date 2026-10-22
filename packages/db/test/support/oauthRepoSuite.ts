import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { OAuthRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);
const hour = 3_600_000;
const day = 24 * hour;

const code = (overrides: Partial<OAuthRepo.NewCode> = {}): OAuthRepo.NewCode => ({
  hash: "c".repeat(64),
  clientId: "mcp_client",
  clientName: "Claude",
  redirectUri: "http://127.0.0.1:5555/callback",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  scopes: ["aliases:read"],
  resource: "https://alias.test/mcp",
  userId: "usr_1",
  username: "ada",
  expiresAt: at(5 * 60_000),
  ...overrides,
});

const grant = (overrides: Partial<OAuthRepo.Grant> = {}): OAuthRepo.Grant => ({
  id: "grt_1",
  userId: "usr_1",
  username: "ada",
  clientId: "mcp_client",
  clientName: "Claude",
  scopes: ["aliases:read"],
  resource: "https://alias.test/mcp",
  createdAt: at(0),
  expiresAt: at(30 * day),
  ...overrides,
});

/** The tokens one request issues for `grantId`; `n` tells the generations apart. */
const issued = (n: number, grantId = "grt_1", userId = "usr_1"): OAuthRepo.Issued => ({
  access: {
    hash: `a${n}`.padEnd(64, "0"),
    grantId,
    clientId: "mcp_client",
    userId,
    username: "ada",
    scopes: ["aliases:read"],
    resource: "https://alias.test/mcp",
    expiresAt: at(n * hour + hour),
  },
  refresh: {
    hash: `r${n}`.padEnd(64, "0"),
    grantId,
    clientId: "mcp_client",
    userId,
    expiresAt: at(n * hour + 30 * day),
  },
});

const failureTag = <A, E extends { readonly _tag: string }>(result: Result.Result<A, E>) =>
  Result.isFailure(result) ? result.failure._tag : "Success";

/**
 * Behaviour every OAuthRepo backend must satisfy. Runners pass the emulator; each test gets its
 * own table on it.
 */
export const oauthRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`OAuthRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      // Tests in one layer share its TestClock, so each starts it at 0 again.
      const withRepo = <A, E>(effect: Effect.Effect<A, E, OAuthRepo.OAuthRepo>) =>
        TestClock.setTime(0).pipe(
          Effect.andThen(effect),
          Effect.provide(OAuthRepo.layer.pipe(Layer.provide(freshTable()))),
        );

      /** A redeemed code: grant `grt_1` with generation 0's tokens. */
      const redeem = Effect.fn("redeem")(function* () {
        const repo = yield* OAuthRepo.OAuthRepo;
        yield* repo.createCode(code());
        const stored = yield* Effect.flatMap(repo.findCode(code().hash), Effect.fromOption);
        yield* repo.redeemCode(stored, grant(), issued(0));
        return repo;
      });

      const findRefresh = (repo: OAuthRepo.OAuthRepo["Service"], n: number) =>
        Effect.flatMap(repo.findRefresh(issued(n).refresh.hash), Effect.fromOption);

      it.effect("registers clients and finds them by id", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* OAuthRepo.OAuthRepo;
            const client: OAuthRepo.Client = {
              id: "mcp_01",
              name: "Claude Code",
              redirectUris: ["http://localhost/callback", "https://claude.ai/callback"],
              uri: Option.some("https://claude.ai"),
              createdAt: at(1_000),
            };
            yield* repo.registerClient(client);
            yield* repo.registerClient({ ...client, id: "mcp_02", uri: Option.none() });
            expect(yield* repo.findClient("mcp_01")).toEqual(Option.some(client));
            expect(yield* repo.findClient("mcp_02")).toEqual(
              Option.some({ ...client, id: "mcp_02", uri: Option.none() }),
            );
            expect(yield* repo.findClient("mcp_03")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("counts registrations per source and hour, up to the cap", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* OAuthRepo.OAuthRepo;
            const now = DateTime.makeUnsafe("2026-10-22T09:15:00Z");
            const results = yield* Effect.all(
              Arr.makeBy(4, () => repo.reserveRegistration("ip-1", now, 3)),
              { concurrency: "unbounded" },
            );
            expect(Arr.filter(results, (ok) => ok)).toHaveLength(3);
            expect(yield* repo.reserveRegistration("ip-2", now, 3)).toBe(true);
            expect(
              yield* repo.reserveRegistration(
                "ip-1",
                DateTime.makeUnsafe("2026-10-22T10:00:00Z"),
                3,
              ),
            ).toBe(true);
          }),
        ),
      );

      it.effect("ignores a code past its expiry, before TTL deletes it", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* OAuthRepo.OAuthRepo;
            yield* repo.createCode(code());
            yield* TestClock.setTime(5 * 60_000 - 1);
            expect(yield* repo.findCode(code().hash)).toEqual(
              Option.some({ ...code(), grantId: Option.none() }),
            );
            yield* TestClock.setTime(5 * 60_000);
            expect(yield* repo.findCode(code().hash)).toEqual(Option.none());
          }),
        ),
      );

      it.effect("redeems a code once for a grant and its tokens", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* redeem();
            expect(yield* repo.findAccess(issued(0).access.hash)).toEqual(
              Option.some(issued(0).access),
            );
            expect(yield* repo.findRefresh(issued(0).refresh.hash)).toEqual(
              Option.some({ ...issued(0).refresh, usedAt: Option.none() }),
            );
            expect(yield* repo.findGrant("grt_1")).toEqual(Option.some(grant()));
            expect(yield* repo.findCode(code().hash)).toEqual(
              Option.some({ ...code(), grantId: Option.some("grt_1") }),
            );
            expect(yield* repo.listGrants("usr_1")).toEqual([grant()]);
            expect(yield* repo.listGrants("usr_2")).toEqual([]);
          }),
        ),
      );

      it.effect("revokes what a code issued when it is redeemed again", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* redeem();
            const stored = yield* Effect.flatMap(repo.findCode(code().hash), Effect.fromOption);
            const again = yield* Effect.result(
              repo.redeemCode(stored, grant({ id: "grt_2" }), issued(1, "grt_2")),
            );
            expect(failureTag(again)).toBe("CodeUnusable");
            expect(yield* repo.findGrant("grt_1")).toEqual(Option.none());
            expect(yield* repo.findGrant("grt_2")).toEqual(Option.none());
            expect(yield* repo.findAccess(issued(0).access.hash)).toEqual(Option.none());
            expect(yield* repo.findRefresh(issued(0).refresh.hash)).toEqual(Option.none());
            expect(yield* repo.findAccess(issued(1, "grt_2").access.hash)).toEqual(Option.none());
          }),
        ),
      );

      it.effect("redeems one of two concurrent redemptions, then revokes it", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* OAuthRepo.OAuthRepo;
            yield* repo.createCode(code());
            const stored = yield* Effect.flatMap(repo.findCode(code().hash), Effect.fromOption);
            const results = yield* Effect.all(
              [
                Effect.result(repo.redeemCode(stored, grant(), issued(0))),
                Effect.result(repo.redeemCode(stored, grant({ id: "grt_2" }), issued(1, "grt_2"))),
              ],
              { concurrency: "unbounded" },
            );
            expect(Arr.map(results, failureTag).toSorted()).toEqual(["CodeUnusable", "Success"]);
            expect(yield* repo.listGrants("usr_1")).toEqual([]);
          }),
        ),
      );

      it.effect("rotates refresh tokens and keeps the grant alive", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* redeem();
            yield* TestClock.setTime(hour);
            yield* repo.rotate(yield* findRefresh(repo, 0), issued(1), at(hour + 30 * day));

            expect(yield* repo.findAccess(issued(1).access.hash)).toEqual(
              Option.some(issued(1).access),
            );
            expect(yield* repo.findRefresh(issued(0).refresh.hash)).toEqual(
              Option.some({ ...issued(0).refresh, usedAt: Option.some(at(hour)) }),
            );
            expect(yield* repo.findGrant("grt_1")).toEqual(
              Option.some(grant({ expiresAt: at(hour + 30 * day) })),
            );
            // The first access token lived its hour.
            expect(yield* repo.findAccess(issued(0).access.hash)).toEqual(Option.none());

            yield* repo.rotate(yield* findRefresh(repo, 1), issued(2), at(2 * hour + 30 * day));
            expect(Option.isSome(yield* repo.findAccess(issued(2).access.hash))).toBe(true);
          }),
        ),
      );

      it.effect("revokes the grant when a refresh token is used twice", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* redeem();
            const first = yield* findRefresh(repo, 0);
            yield* repo.rotate(first, issued(1), at(30 * day));

            const stale = yield* Effect.result(
              repo.rotate(yield* findRefresh(repo, 0), issued(2), at(30 * day)),
            );
            expect(failureTag(stale)).toBe("RefreshUnusable");
            // So did the copy read before the first exchange.
            const replay = yield* Effect.result(repo.rotate(first, issued(3), at(30 * day)));
            expect(failureTag(replay)).toBe("RefreshUnusable");

            expect(yield* repo.findGrant("grt_1")).toEqual(Option.none());
            expect(yield* repo.findAccess(issued(1).access.hash)).toEqual(Option.none());
            expect(yield* repo.findRefresh(issued(1).refresh.hash)).toEqual(Option.none());
            expect(yield* repo.findAccess(issued(3).access.hash)).toEqual(Option.none());
          }),
        ),
      );

      it.effect("lets one of two concurrent refreshes through, then revokes the grant", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* redeem();
            const refresh = yield* findRefresh(repo, 0);
            const results = yield* Effect.all(
              [
                Effect.result(repo.rotate(refresh, issued(1), at(30 * day))),
                Effect.result(repo.rotate(refresh, issued(2), at(30 * day))),
              ],
              { concurrency: "unbounded" },
            );
            expect(Arr.map(results, failureTag).toSorted()).toEqual(["RefreshUnusable", "Success"]);
            expect(yield* repo.findGrant("grt_1")).toEqual(Option.none());
            expect(yield* repo.findAccess(issued(1).access.hash)).toEqual(Option.none());
            expect(yield* repo.findAccess(issued(2).access.hash)).toEqual(Option.none());
          }),
        ),
      );

      it.effect("revokes a grant for its user only, with every token it issued", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* redeem();
            const refresh = yield* findRefresh(repo, 0);
            yield* repo.rotate(refresh, issued(1), at(30 * day));

            const foreign = yield* Effect.result(repo.revokeUserGrant("usr_2", "grt_1"));
            expect(failureTag(foreign)).toBe("NoSuchGrant");
            expect(Option.isSome(yield* repo.findAccess(issued(1).access.hash))).toBe(true);

            yield* repo.revokeUserGrant("usr_1", "grt_1");
            expect(yield* repo.findAccess(issued(1).access.hash)).toEqual(Option.none());
            expect(yield* repo.findRefresh(issued(1).refresh.hash)).toEqual(Option.none());
            // Used refresh tokens go too.
            expect(yield* repo.findRefresh(issued(0).refresh.hash)).toEqual(Option.none());
            expect(yield* repo.listGrants("usr_1")).toEqual([]);
            const rotated = yield* Effect.result(repo.rotate(refresh, issued(2), at(30 * day)));
            expect(failureTag(rotated)).toBe("RefreshUnusable");
            const again = yield* Effect.result(repo.revokeUserGrant("usr_1", "grt_1"));
            expect(failureTag(again)).toBe("NoSuchGrant");
          }),
        ),
      );

      it.effect("refuses to rotate for a grant revoked after the refresh token was read", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* redeem();
            const refresh = yield* findRefresh(repo, 0);
            yield* repo.revokeGrant("grt_1");
            const rotated = yield* Effect.result(repo.rotate(refresh, issued(1), at(30 * day)));
            expect(failureTag(rotated)).toBe("RefreshUnusable");
            expect(yield* repo.findAccess(issued(1).access.hash)).toEqual(Option.none());
          }),
        ),
      );

      it.effect("revokes a single access token", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* redeem();
            yield* repo.revokeAccess(issued(0).access.hash);
            yield* repo.revokeAccess(issued(0).access.hash);
            expect(yield* repo.findAccess(issued(0).access.hash)).toEqual(Option.none());
            expect(Option.isSome(yield* repo.findGrant("grt_1"))).toBe(true);
          }),
        ),
      );
    });
  });
