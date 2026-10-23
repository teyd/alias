import { Rules } from "@alias/core";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";

/**
 * A user's blocklist and rules (PLAN.md §20.32), in one item of their partition: the inbound
 * Lambda reads both with one strongly consistent GetItem per message, however long the lists.
 * Both are bounded (`Blocklist.MAX_ENTRIES`, `Rules.MAX_RULES`), so the item stays far below
 * DynamoDB's 400 KB.
 */
export interface Filters {
  /** Stored entries (`Blocklist.entry` reads them), sorted. */
  readonly blocklist: ReadonlyArray<string>;
  /** In the order they apply. */
  readonly rules: ReadonlyArray<Rules.Rule>;
}

export class BlocklistFull extends Schema.TaggedError<BlocklistFull>()("BlocklistFull", {
  limit: Schema.Number,
}) {}

export class NoSuchEntry extends Schema.TaggedError<NoSuchEntry>()("NoSuchEntry", {
  entryId: Schema.String,
}) {}

export class FilterRepo extends Context.Service<
  FilterRepo,
  {
    readonly find: (userId: string) => Effect.Effect<Filters, DatabaseError>;
    /** Adds an entry; adding one already there changes nothing, even with the list full. */
    readonly block: (
      userId: string,
      entryId: string,
      limit: number,
    ) => Effect.Effect<void, BlocklistFull | DatabaseError>;
    readonly unblock: (
      userId: string,
      entryId: string,
    ) => Effect.Effect<void, NoSuchEntry | DatabaseError>;
    /**
     * Replaces the rules with what `change` makes of the stored ones. Concurrent changes don't
     * overwrite each other: the write is conditional on the version read, and a lost race reads
     * again and asks `change` again.
     */
    readonly updateRules: <E>(
      userId: string,
      change: (rules: ReadonlyArray<Rules.Rule>) => Result.Result<ReadonlyArray<Rules.Rule>, E>,
    ) => Effect.Effect<ReadonlyArray<Rules.Rule>, E | DatabaseError>;
  }
>()("@alias/db/FilterRepo") {}

const filtersKey = (userId: string) => ({ pk: { S: `USER#${userId}` }, sk: { S: "FILTERS" } });

const RulesJson = Attribute.S.pipe(
  Schema.decodeTo(Schema.fromJsonString(Schema.Array(Rules.Rule))),
);

const FiltersItem = Item.codec(
  Schema.Struct({
    blocked: Schema.optionalKey(Attribute.StringSet),
    rules: Schema.optionalKey(RulesJson),
    rulesVersion: Schema.optionalKey(Attribute.N),
  }),
  "Filters",
);

/** Attempts before a write that keeps losing races gives up. */
const MAX_ATTEMPTS = 5;

class RulesConflict extends Schema.TaggedError<RulesConflict>()("RulesConflict", {}) {}

const make = Effect.fn("FilterRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const read = (userId: string) =>
    DynamoDB.getItem({ TableName, Key: filtersKey(userId), ConsistentRead: true }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.flatMap((result) => FiltersItem.decodeOption(Option.fromUndefinedOr(result.Item))),
      Effect.map(
        Option.match({
          onNone: () => ({ blocked: [], rules: [], version: 0 }),
          onSome: (item) => ({
            blocked: Arr.sort(item.blocked ?? [], Order.String),
            rules: item.rules ?? [],
            version: item.rulesVersion ?? 0,
          }),
        }),
      ),
      Effect.provide(client),
    );

  const writeRules = (userId: string, rules: ReadonlyArray<Rules.Rule>, version: number) =>
    Effect.flatMap(
      Schema.encodeEffect(RulesJson)(rules).pipe(Effect.mapError(databaseError("EncodeFilters"))),
      (json) =>
        DynamoDB.updateItem({
          TableName,
          Key: filtersKey(userId),
          UpdateExpression: "SET #rules = :rules, rulesVersion = :next",
          // Version 0 is a user who never saved rules: no attribute yet.
          ConditionExpression: "attribute_not_exists(rulesVersion) OR rulesVersion = :version",
          ExpressionAttributeNames: { "#rules": "rules" },
          ExpressionAttributeValues: {
            ":rules": json,
            ":next": { N: String(version + 1) },
            ":version": { N: String(version) },
          },
        }).pipe(
          Effect.asVoid,
          Effect.mapError((error) =>
            P.isTagged(error, "ConditionalCheckFailedException")
              ? new RulesConflict()
              : databaseError("UpdateItem")(error),
          ),
          Effect.provide(client),
        ),
    );

  return FilterRepo.of({
    find: (userId) =>
      Effect.map(read(userId), ({ blocked, rules }) => ({ blocklist: blocked, rules })),

    block: (userId, entryId, limit) =>
      DynamoDB.updateItem({
        TableName,
        Key: filtersKey(userId),
        UpdateExpression: "ADD blocked :entry",
        ConditionExpression:
          "attribute_not_exists(blocked) OR size(blocked) < :limit OR contains(blocked, :id)",
        ExpressionAttributeValues: {
          ":entry": { SS: [entryId] },
          ":id": { S: entryId },
          ":limit": { N: String(limit) },
        },
      }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          P.isTagged(error, "ConditionalCheckFailedException")
            ? new BlocklistFull({ limit })
            : databaseError("UpdateItem")(error),
        ),
        Effect.provide(client),
      ),

    unblock: (userId, entryId) =>
      DynamoDB.updateItem({
        TableName,
        Key: filtersKey(userId),
        UpdateExpression: "DELETE blocked :entry",
        ConditionExpression: "contains(blocked, :id)",
        ExpressionAttributeValues: { ":entry": { SS: [entryId] }, ":id": { S: entryId } },
      }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          P.isTagged(error, "ConditionalCheckFailedException")
            ? new NoSuchEntry({ entryId })
            : databaseError("UpdateItem")(error),
        ),
        Effect.provide(client),
      ),

    updateRules: <E>(
      userId: string,
      change: (rules: ReadonlyArray<Rules.Rule>) => Result.Result<ReadonlyArray<Rules.Rule>, E>,
    ) =>
      Effect.gen(function* () {
        const stored = yield* read(userId);
        const changed = change(stored.rules);
        if (Result.isFailure(changed)) return yield* Effect.fail(changed.failure);
        yield* writeRules(userId, changed.success, stored.version);
        return changed.success;
      }).pipe(
        Effect.retry({ while: P.isTagged("RulesConflict"), times: MAX_ATTEMPTS - 1 }),
        Effect.catchTag("RulesConflict", () =>
          Effect.fail(databaseError("UpdateItem")("rules kept changing concurrently")),
        ),
      ),
  });
});

export const layer = Layer.effect(FilterRepo, make());
