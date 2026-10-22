import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { NoSuchAlias, userPartition } from "./AliasRepo.ts";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import { aliasKey, inboxPartition } from "./Keys.ts";
import * as Quota from "./Quota.ts";
import { conditionFailedAt } from "./Transaction.ts";

/**
 * Metadata of a message stored for an inbox alias (PLAN.md §20.22). The body lives encrypted in
 * S3 under `objectKey`; this item holds its data key, wrapped by the inbox key `keyVersion`, and
 * the encrypted summary (sender, subject, preview, extracted code and link). Nothing here is
 * readable without the inbox key: deleting the item destroys the only copy of the data key.
 */
export interface StoredMessage {
  readonly id: string;
  readonly aliasId: string;
  readonly userId: string;
  readonly receivedAt: DateTime.Utc;
  /** Readers ignore the message from then on; TTL deletes the item some time later. */
  readonly expiresAt: DateTime.Utc;
  /** Size of the original message in bytes. */
  readonly size: number;
  readonly objectKey: string;
  readonly keyVersion: number;
  readonly wrappedKey: Uint8Array;
  readonly summary: Uint8Array;
}

/** The alias the message belongs to, which must still exist when it is stored. */
interface AliasAddress {
  readonly domain: string;
  readonly localPart: string;
}

export interface Page {
  /** Only messages stored after this one (ids sort by time). */
  readonly after: Option.Option<string>;
  readonly limit: number;
}

export class MessageRepo extends Context.Service<
  MessageRepo,
  {
    /**
     * Stores the metadata. Fails with `NoSuchAlias` when the alias was deleted since it was read
     * (or recreated with a new id), so a purge can't miss a message stored meanwhile.
     */
    readonly insert: (
      message: StoredMessage,
      alias: AliasAddress,
    ) => Effect.Effect<void, NoSuchAlias | DatabaseError>;
    /** The alias's live messages, newest first. */
    readonly list: (
      aliasId: string,
      page: Page,
    ) => Effect.Effect<ReadonlyArray<StoredMessage>, DatabaseError>;
    /** None when missing or expired. */
    readonly find: (
      aliasId: string,
      messageId: string,
    ) => Effect.Effect<Option.Option<StoredMessage>, DatabaseError>;
    /** Deletes the metadata and returns what was deleted, so its object can go too. */
    readonly delete: (
      aliasId: string,
      messageId: string,
    ) => Effect.Effect<Option.Option<StoredMessage>, DatabaseError>;
    /**
     * Counts one stored message against the user's allowance of `maxPerDay` for the UTC day
     * `now` falls in. False, and nothing counted, when it is used up.
     */
    readonly reserveStorage: (
      userId: string,
      now: DateTime.Utc,
      maxPerDay: number,
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("@alias/db/MessageRepo") {}

const messageKey = (aliasId: string, messageId: string) => ({
  pk: { S: inboxPartition(aliasId) },
  sk: { S: `MESSAGE#${messageId}` },
});

/** The user's count of messages stored in one UTC day, in their partition. */
const storageQuotaKey = (userId: string, day: string) => ({
  pk: { S: userPartition(userId) },
  sk: { S: `STORED#${day}` },
});

const MessageItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    aliasId: Attribute.S,
    userId: Attribute.S,
    receivedAt: Attribute.EpochMillis,
    expiresAt: Attribute.EpochSeconds,
    size: Attribute.N,
    objectKey: Attribute.S,
    keyVersion: Attribute.N,
    wrappedKey: Attribute.B,
    summary: Attribute.B,
  }),
  "Message",
);

const isLive = (now: DateTime.Utc) => (message: StoredMessage) =>
  DateTime.isGreaterThan(message.expiresAt, now);

const make = Effect.fn("MessageRepo.make")(function* () {
  const table = yield* DynamoTable;
  const TableName = table.name;
  const client = yield* Effect.context<Database>();

  const insert = Effect.fn("MessageRepo.insert")(function* (
    message: StoredMessage,
    alias: AliasAddress,
  ) {
    const attributes = yield* MessageItem.encode(message);
    yield* DynamoDB.transactWriteItems({
      TransactItems: [
        {
          Put: {
            TableName,
            Item: { ...messageKey(message.aliasId, message.id), ...attributes },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          // The live alias has this id; its tombstone has none or keeps it marked deleted.
          ConditionCheck: {
            TableName,
            Key: aliasKey(alias.domain, alias.localPart),
            ConditionExpression: "#id = :aliasId AND attribute_not_exists(deletedAt)",
            ExpressionAttributeNames: { "#id": "id" },
            ExpressionAttributeValues: { ":aliasId": { S: message.aliasId } },
          },
        },
      ],
    }).pipe(
      Effect.mapError((error) =>
        conditionFailedAt(error, 1)
          ? new NoSuchAlias({ address: `${alias.localPart}@${alias.domain}`.toLowerCase() })
          : databaseError("TransactWriteItems")(error),
      ),
    );
  });

  const list = Effect.fn("MessageRepo.list")(function* (aliasId: string, page: Page) {
    const now = yield* DateTime.now;
    const items = yield* DynamoDB.query({
      TableName,
      KeyConditionExpression: Option.match(page.after, {
        onNone: () => "pk = :pk AND begins_with(sk, :prefix)",
        onSome: () => "pk = :pk AND sk > :after",
      }),
      ExpressionAttributeValues: {
        ":pk": { S: inboxPartition(aliasId) },
        ...Option.match(page.after, {
          onNone: () => ({ ":prefix": { S: "MESSAGE#" } }),
          onSome: (after) => ({ ":after": messageKey(aliasId, after).sk }),
        }),
      },
      ScanIndexForward: false,
      Limit: page.limit,
      ConsistentRead: true,
    }).pipe(
      Effect.map((result) => result.Items ?? []),
      Effect.mapError(databaseError("Query")),
    );
    const messages = yield* Effect.forEach(items, MessageItem.decode, { concurrency: 1 });
    return Arr.filter(messages, isLive(now));
  });

  const find = Effect.fn("MessageRepo.find")(function* (aliasId: string, messageId: string) {
    const now = yield* DateTime.now;
    const item = yield* DynamoDB.getItem({
      TableName,
      Key: messageKey(aliasId, messageId),
      ConsistentRead: true,
    }).pipe(
      Effect.map((result) => Option.fromUndefinedOr(result.Item)),
      Effect.mapError(databaseError("GetItem")),
    );
    return Option.filter(yield* MessageItem.decodeOption(item), isLive(now));
  });

  const remove = Effect.fn("MessageRepo.delete")(function* (aliasId: string, messageId: string) {
    const item = yield* DynamoDB.deleteItem({
      TableName,
      Key: messageKey(aliasId, messageId),
      ReturnValues: "ALL_OLD",
    }).pipe(
      Effect.map((result) =>
        Option.filter(Option.fromUndefinedOr(result.Attributes), (old) => P.hasProperty(old, "pk")),
      ),
      Effect.mapError(databaseError("DeleteItem")),
    );
    return yield* MessageItem.decodeOption(item);
  });

  return MessageRepo.of({
    insert: (message, alias) => Effect.provide(insert(message, alias), client),
    list: (aliasId, page) => Effect.provide(list(aliasId, page), client),
    find: (aliasId, messageId) => Effect.provide(find(aliasId, messageId), client),
    delete: (aliasId, messageId) => Effect.provide(remove(aliasId, messageId), client),
    reserveStorage: (userId, now, maxPerDay) => {
      const day = Quota.window(now, "day");
      return Quota.reserve(table, storageQuotaKey(userId, day.label), day, maxPerDay).pipe(
        Effect.provide(client),
      );
    },
  });
});

export const layer = Layer.effect(MessageRepo, make());
