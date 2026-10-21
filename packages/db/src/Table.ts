import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import { databaseError } from "./DatabaseError.ts";
import { DynamoTable } from "./Dynamo.ts";

/**
 * Single-table design. This spec is the one source of truth. `infra/alchemy.run.ts` deploys it and
 * the emulators create it with {@link ensure}, so tests run against the table production gets.
 *
 * | Item  | pk                          | sk      | gsi1pk         | gsi1sk                    |
 * | ----- | --------------------------- | ------- | -------------- | ------------------------- |
 * | Alias | `ALIAS#<domain>#<localPart>` | `ALIAS` | `USER#<userId>` | `ALIAS#<createdAt>#<id>` |
 *
 * Access patterns: look up an alias by address (GetItem, strongly consistent) and list a user's
 * aliases (gsi1 Query). `expiresAt` (epoch seconds) is the TTL attribute. TTL deletion runs late
 * and the emulators don't run it at all, so readers must still ignore expired items.
 */
export const spec = {
  partitionKey: "pk",
  sortKey: "sk",
  attributes: { pk: "S", sk: "S", gsi1pk: "S", gsi1sk: "S" },
  globalSecondaryIndexes: [{ indexName: "gsi1", partitionKey: "gsi1pk", sortKey: "gsi1sk" }],
  timeToLiveAttribute: "expiresAt",
} as const;

const createTableInput = (tableName: string): DynamoDB.CreateTableInput => ({
  TableName: tableName,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: Arr.map(R.toEntries(spec.attributes), ([name, type]) => ({
    AttributeName: name,
    AttributeType: type,
  })),
  KeySchema: [
    { AttributeName: spec.partitionKey, KeyType: "HASH" },
    { AttributeName: spec.sortKey, KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: Arr.map(spec.globalSecondaryIndexes, (index) => ({
    IndexName: index.indexName,
    KeySchema: [
      { AttributeName: index.partitionKey, KeyType: "HASH" },
      { AttributeName: index.sortKey, KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "ALL" },
  })),
});

/** Creates the table if it doesn't exist. Emulators and dev only; Alchemy deploys real stages. */
export const ensure = Effect.fn("Table.ensure")(function* () {
  const table = yield* DynamoTable;
  yield* DynamoDB.createTable(createTableInput(table.name)).pipe(
    // The SDK marks ResourceInUseException retryable (it also means "table is updating"), so
    // without this an existing table makes CreateTable retry instead of failing fast.
    Retry.none,
    Effect.asVoid,
    Effect.catchTag("ResourceInUseException", () => Effect.void),
    Effect.mapError(databaseError("CreateTable")),
  );
});
