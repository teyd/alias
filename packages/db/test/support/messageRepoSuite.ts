import type { DynamoDbEndpoint, EmulatorFailure } from "@alias/aws-emulators";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Str from "effect/String";
import { AliasRepo, Dynamo, MessageRepo } from "../../src/index.ts";
import { freshTable } from "./database.ts";

const at = (millis: number) => DateTime.makeUnsafe(millis);
/** Far in the future, so nothing expires unless a test says so. */
const LATER = at(9_000_000_000_000);

const inbox = { domain: "tmp.test", localPart: "k7m2qx9pzr" };

const message = (
  id: string,
  overrides: Partial<MessageRepo.StoredMessage> = {},
): MessageRepo.StoredMessage => ({
  id,
  aliasId: "al_temp",
  userId: "usr_1",
  receivedAt: at(1_000),
  expiresAt: LATER,
  size: 1_234,
  objectKey: `inbox/1d/al_temp/${id}`,
  keyVersion: 1,
  wrappedKey: new Uint8Array([1, 2, 3]),
  summary: new Uint8Array([4, 5, 6]),
  ...overrides,
});

const seedInbox = AliasRepo.AliasRepo.use((aliases) =>
  aliases.insert({
    id: "al_temp",
    userId: "usr_1",
    mode: "inbox",
    createdAt: 0,
    inboxExpiresAt: 86_400_000,
    retentionDays: 1,
    ...inbox,
  }),
);

const ids = (messages: ReadonlyArray<MessageRepo.StoredMessage>) => Arr.map(messages, (m) => m.id);

/**
 * Behaviour every MessageRepo backend must satisfy. Runners pass the emulator; each test gets
 * its own table on it.
 */
export const messageRepoSuite = (
  engine: string,
  emulator: Layer.Layer<DynamoDbEndpoint, EmulatorFailure>,
) =>
  describe(`MessageRepo (${engine})`, () => {
    it.layer(emulator, { timeout: 30_000 })((it) => {
      const withRepo = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          MessageRepo.MessageRepo | AliasRepo.AliasRepo | Dynamo.Database
        >,
      ) =>
        Effect.andThen(seedInbox, effect).pipe(
          Effect.provide(
            Layer.mergeAll(MessageRepo.layer, AliasRepo.layer).pipe(
              Layer.provideMerge(freshTable()),
            ),
          ),
        );

      it.effect("stores metadata as given and lists the newest first", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* MessageRepo.MessageRepo;
            yield* Effect.forEach(
              ["msg_01a", "msg_01c", "msg_01b"],
              (id) => repo.insert(message(id), inbox),
              { concurrency: 1, discard: true },
            );
            const page = yield* repo.list("al_temp", { after: Option.none(), limit: 10 });
            expect(ids(page)).toEqual(["msg_01c", "msg_01b", "msg_01a"]);
            expect(page[2]).toEqual(message("msg_01a"));
            expect(yield* repo.find("al_temp", "msg_01b")).toEqual(Option.some(message("msg_01b")));
            expect(yield* repo.find("al_temp", "msg_none")).toEqual(Option.none());
            expect(yield* repo.find("al_other", "msg_01b")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("pages: only messages after a given id, at most the limit", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* MessageRepo.MessageRepo;
            yield* Effect.forEach(
              ["msg_01a", "msg_01b", "msg_01c", "msg_01d"],
              (id) => repo.insert(message(id), inbox),
              { concurrency: 1, discard: true },
            );
            expect(
              ids(yield* repo.list("al_temp", { after: Option.some("msg_01b"), limit: 10 })),
            ).toEqual(["msg_01d", "msg_01c"]);
            expect(
              ids(yield* repo.list("al_temp", { after: Option.some("msg_01d"), limit: 10 })),
            ).toEqual([]);
            expect(ids(yield* repo.list("al_temp", { after: Option.none(), limit: 2 }))).toEqual([
              "msg_01d",
              "msg_01c",
            ]);
          }),
        ),
      );

      it.effect("ignores expired messages before TTL deletes them", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* MessageRepo.MessageRepo;
            const now = yield* DateTime.now;
            yield* repo.insert(
              message("msg_01a", { expiresAt: DateTime.subtract(now, { seconds: 5 }) }),
              inbox,
            );
            yield* repo.insert(message("msg_01b"), inbox);
            expect(ids(yield* repo.list("al_temp", { after: Option.none(), limit: 10 }))).toEqual([
              "msg_01b",
            ]);
            expect(yield* repo.find("al_temp", "msg_01a")).toEqual(Option.none());
          }),
        ),
      );

      it.effect("refuses a message for a deleted alias, and for its old id once recreated", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* MessageRepo.MessageRepo;
            const aliases = yield* AliasRepo.AliasRepo;
            yield* aliases.delete({ userId: "usr_1", ...inbox });
            expect(yield* Effect.flip(repo.insert(message("msg_01a"), inbox))).toBeInstanceOf(
              AliasRepo.NoSuchAlias,
            );
            yield* aliases.insert({
              id: "al_again",
              userId: "usr_1",
              mode: "inbox",
              createdAt: 1,
              ...inbox,
            });
            expect(yield* Effect.flip(repo.insert(message("msg_01a"), inbox))).toBeInstanceOf(
              AliasRepo.NoSuchAlias,
            );
            yield* repo.insert(message("msg_01a", { aliasId: "al_again" }), inbox);
            expect(ids(yield* repo.list("al_again", { after: Option.none(), limit: 10 }))).toEqual([
              "msg_01a",
            ]);
          }),
        ),
      );

      it.effect("deletes one message and returns its metadata once", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* MessageRepo.MessageRepo;
            yield* repo.insert(message("msg_01a"), inbox);
            yield* repo.insert(message("msg_01b"), inbox);
            expect(yield* repo.delete("al_temp", "msg_01a")).toEqual(
              Option.some(message("msg_01a")),
            );
            expect(yield* repo.delete("al_temp", "msg_01a")).toEqual(Option.none());
            expect(ids(yield* repo.list("al_temp", { after: Option.none(), limit: 10 }))).toEqual([
              "msg_01b",
            ]);
          }),
        ),
      );

      it.effect("deleting the alias purges its messages' metadata, keys and all", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* MessageRepo.MessageRepo;
            yield* repo.insert(message("msg_01a"), inbox);
            yield* repo.insert(message("msg_01b"), inbox);
            yield* (yield* AliasRepo.AliasRepo).delete({ userId: "usr_1", ...inbox });
            const table = yield* Dynamo.DynamoTable;
            const { Items } = yield* DynamoDB.scan({ TableName: table.name, ConsistentRead: true });
            expect(Arr.map(Items ?? [], (item) => item.pk?.S)).toEqual([
              "ALIAS#tmp.test#k7m2qx9pzr",
            ]);
            // The tombstone holds nothing of the inbox: no expiry, no retention.
            expect(Arr.sort(R.keys(Items?.[0] ?? {}), Str.Order)).toEqual([
              "deletedAt",
              "gsi1pk",
              "gsi1sk",
              "pk",
              "sk",
              "userId",
            ]);
          }),
        ),
      );

      it.effect("caps stored messages per user and day, under concurrency", () =>
        withRepo(
          Effect.gen(function* () {
            const repo = yield* MessageRepo.MessageRepo;
            const now = DateTime.makeUnsafe("2026-10-22T09:00:00Z");
            const results = yield* Effect.forEach(
              Arr.range(1, 8),
              () => repo.reserveStorage("usr_1", now, 5),
              { concurrency: 8 },
            );
            expect(Arr.filter(results, (ok) => ok)).toHaveLength(5);
            expect(yield* repo.reserveStorage("usr_2", now, 5)).toBe(true);
            // A new UTC day starts afresh.
            expect(yield* repo.reserveStorage("usr_1", DateTime.add(now, { days: 1 }), 5)).toBe(
              true,
            );
          }),
        ),
      );
    });
  });
