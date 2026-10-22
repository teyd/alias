import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Attribute from "./Attribute.ts";
import { databaseError } from "./DatabaseError.ts";
import type { DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";

/** An item's primary key, as DynamoDB takes it (a type, so it fits `AttributeMap`). */
export type Key = {
  readonly pk: { readonly S: string };
  readonly sk: { readonly S: string };
};

const KeyItem = Item.codec(Schema.Struct({ pk: Attribute.S, sk: Attribute.S }), "Key");

const toKey = (item: { readonly pk: string; readonly sk: string }): Key => ({
  pk: { S: item.pk },
  sk: { S: item.sk },
});

/**
 * The keys of every item in partition `pk`, or of those whose sort key starts with `prefix`. A
 * strongly consistent Query that reads only the keys.
 */
export const partitionKeys = (
  table: typeof DynamoTable.Service,
  pk: string,
  prefix: Option.Option<string>,
) =>
  DynamoDB.query
    .items({
      TableName: table.name,
      KeyConditionExpression: Option.match(prefix, {
        onNone: () => "pk = :pk",
        onSome: () => "pk = :pk AND begins_with(sk, :prefix)",
      }),
      ExpressionAttributeValues: {
        ":pk": { S: pk },
        ...Option.match(prefix, {
          onNone: () => ({}),
          onSome: (value) => ({ ":prefix": { S: value } }),
        }),
      },
      ProjectionExpression: "pk, sk",
      ConsistentRead: true,
    })
    .pipe(
      Stream.mapError(databaseError("Query")),
      Stream.mapEffect(KeyItem.decode),
      Stream.map(toKey),
      Stream.runCollect,
    );

/**
 * The full items under one `gsi1pk`. The index is eventually consistent: an item written a moment
 * ago may be missing, so callers that must see everything look again later (`AccountRepo`).
 */
export const indexItems = (table: typeof DynamoTable.Service, gsi1pk: string) =>
  DynamoDB.query
    .items({
      TableName: table.name,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: gsi1pk } },
    })
    .pipe(Stream.mapError(databaseError("Query")), Stream.runCollect);

/** The primary key of an item read from the table or an index. */
export const keyOf = (item: DynamoDB.AttributeMap) => Effect.map(KeyItem.decode(item), toKey);

/** Deletes every item by key. Deleting one that is already gone succeeds, so retries are safe. */
export const deleteAll = (table: typeof DynamoTable.Service, keys: ReadonlyArray<Key>) =>
  Effect.forEach(
    keys,
    (key) =>
      DynamoDB.deleteItem({ TableName: table.name, Key: key }).pipe(
        Effect.mapError(databaseError("DeleteItem")),
      ),
    { concurrency: 8, discard: true },
  );
