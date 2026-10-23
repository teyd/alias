import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { NoSuchAlias, userPartition } from "./AliasRepo.ts";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import { aliasKey, failuresPartition } from "./Keys.ts";
import * as Quota from "./Quota.ts";
import { conditionFailedAt } from "./Transaction.ts";

/**
 * Mail the inbound Lambda could not forward for good (PLAN.md §20.33): SES refused it, the
 * owner's forwarding address is paused, its OpenPGP key no longer encrypts, or it was too large.
 * Metadata only by default (when, which alias, who wrote, why); with the owner's opt-in the
 * forwarded message is kept too, sealed in the inbox bucket like stored mail (`Inbox.keep`), so
 * it can be downloaded or sent again. Either way it is gone after a week.
 */

/** The sealed copy of a failed message, for its owner to download or send again. */
export interface Kept {
  /** Where the sealed body lives in the inbox bucket. */
  readonly objectKey: string;
  readonly keyVersion: number;
  readonly wrappedKey: Uint8Array;
  /** The reverse alias the forward came from, which a resend comes from again. */
  readonly envelopeFrom: string;
}

export interface Failure {
  readonly id: string;
  readonly aliasId: string;
  readonly userId: string;
  /** The alias's address. */
  readonly alias: string;
  /** Who wrote: the `From` address, else the envelope sender. A third party's address. */
  readonly sender: Option.Option<string>;
  /** The pipeline's drop reason (`rejected`, `recipient-bounced`, `key-unusable`, `too-large`). */
  readonly reason: string;
  readonly receivedAt: DateTime.Utc;
  /** Readers ignore the failure from then on; TTL deletes the item some time later. */
  readonly expiresAt: DateTime.Utc;
  /** Size of the original message in bytes. */
  readonly size: number;
  readonly kept: Option.Option<Kept>;
}

/** The alias the failure belongs to, which must still exist when it is recorded. */
interface AliasAddress {
  readonly domain: string;
  readonly localPart: string;
}

export class FailureRepo extends Context.Service<
  FailureRepo,
  {
    /**
     * Records a failure. Fails with `NoSuchAlias` when the alias was deleted since it was read, so
     * the purge of its partition can't miss one recorded meanwhile.
     */
    readonly insert: (
      failure: Failure,
      alias: AliasAddress,
    ) => Effect.Effect<void, NoSuchAlias | DatabaseError>;
    /**
     * The user's live failures, newest first. From the user's index partition, which is
     * eventually consistent: a failure recorded a moment ago may be missing.
     */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<Failure>, DatabaseError>;
    /** The user's failure; None for someone else's, an unknown one and an expired one. */
    readonly find: (
      userId: string,
      failureId: string,
    ) => Effect.Effect<Option.Option<Failure>, DatabaseError>;
    /** Deletes the user's failure and returns it, so its kept body can go too. */
    readonly delete: (
      userId: string,
      failureId: string,
    ) => Effect.Effect<Option.Option<Failure>, DatabaseError>;
    /**
     * Counts one recorded failure against the user's allowance of `maxPerDay` for the UTC day
     * `now` falls in. False, and nothing counted, when it is used up: a flood of failing mail
     * writes a bounded number of items.
     */
    readonly reserve: (
      userId: string,
      now: DateTime.Utc,
      maxPerDay: number,
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("@alias/db/FailureRepo") {}

const failureKey = (aliasId: string, failureId: string) => ({
  pk: { S: failuresPartition(aliasId) },
  sk: { S: `FAILURE#${failureId}` },
});

/** Lists a user's failures across their aliases. */
const indexPartition = (userId: string) => `FAILED-DELIVERIES#${userId}`;

const quotaKey = (userId: string, day: string) => ({
  pk: { S: userPartition(userId) },
  sk: { S: `FAILURES#${day}` },
});

const FailureFields = Schema.Struct({
  id: Attribute.S,
  aliasId: Attribute.S,
  userId: Attribute.S,
  alias: Attribute.S,
  sender: Schema.OptionFromOptionalKey(Attribute.S),
  reason: Attribute.S,
  receivedAt: Attribute.EpochMillis,
  expiresAt: Attribute.EpochSeconds,
  size: Attribute.N,
  objectKey: Schema.OptionFromOptionalKey(Attribute.S),
  keyVersion: Schema.OptionFromOptionalKey(Attribute.N),
  wrappedKey: Schema.OptionFromOptionalKey(Attribute.B),
  envelopeFrom: Schema.OptionFromOptionalKey(Attribute.S),
});
type FailureFields = typeof FailureFields.Type;
const FailureItem = Item.codec(FailureFields, "Failure");

const toFailure = (fields: FailureFields): Failure => ({
  id: fields.id,
  aliasId: fields.aliasId,
  userId: fields.userId,
  alias: fields.alias,
  sender: fields.sender,
  reason: fields.reason,
  receivedAt: fields.receivedAt,
  expiresAt: fields.expiresAt,
  size: fields.size,
  kept: Option.all({
    objectKey: fields.objectKey,
    keyVersion: fields.keyVersion,
    wrappedKey: fields.wrappedKey,
    envelopeFrom: fields.envelopeFrom,
  }),
});

const toFields = (failure: Failure): FailureFields => ({
  id: failure.id,
  aliasId: failure.aliasId,
  userId: failure.userId,
  alias: failure.alias,
  sender: failure.sender,
  reason: failure.reason,
  receivedAt: failure.receivedAt,
  expiresAt: failure.expiresAt,
  size: failure.size,
  objectKey: Option.map(failure.kept, (kept) => kept.objectKey),
  keyVersion: Option.map(failure.kept, (kept) => kept.keyVersion),
  wrappedKey: Option.map(failure.kept, (kept) => kept.wrappedKey),
  envelopeFrom: Option.map(failure.kept, (kept) => kept.envelopeFrom),
});

const isLive = (now: DateTime.Utc) => (failure: Failure) =>
  DateTime.isGreaterThan(failure.expiresAt, now);

const newestFirst = Order.flip(
  Order.mapInput(DateTime.Order, (failure: Failure) => failure.receivedAt),
);

const make = Effect.fn("FailureRepo.make")(function* () {
  const table = yield* DynamoTable;
  const TableName = table.name;
  const client = yield* Effect.context<Database>();

  const decode = (item: DynamoDB.AttributeMap) => Effect.map(FailureItem.decode(item), toFailure);

  const insert = Effect.fn("FailureRepo.insert")(function* (failure: Failure, alias: AliasAddress) {
    const attributes = yield* FailureItem.encode(toFields(failure));
    yield* DynamoDB.transactWriteItems({
      TransactItems: [
        {
          Put: {
            TableName,
            Item: {
              ...failureKey(failure.aliasId, failure.id),
              gsi1pk: { S: indexPartition(failure.userId) },
              gsi1sk: { S: `FAILURE#${failure.id}` },
              ...attributes,
            },
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
            ExpressionAttributeValues: { ":aliasId": { S: failure.aliasId } },
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

  const list = Effect.fn("FailureRepo.list")(function* (userId: string) {
    const now = yield* DateTime.now;
    const failures = yield* DynamoDB.query
      .items({
        TableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: indexPartition(userId) } },
      })
      .pipe(Stream.mapError(databaseError("Query")), Stream.mapEffect(decode), Stream.runCollect);
    return Arr.sort(Arr.filter(failures, isLive(now)), newestFirst);
  });

  /** Where the failure lives: its alias isn't in its id, so the user's index names it. */
  const locate = Effect.fn("FailureRepo.locate")(function* (userId: string, failureId: string) {
    const result = yield* DynamoDB.query({
      TableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk AND gsi1sk = :sk",
      ExpressionAttributeValues: {
        ":pk": { S: indexPartition(userId) },
        ":sk": { S: `FAILURE#${failureId}` },
      },
    }).pipe(Effect.mapError(databaseError("Query")));
    const found = yield* Effect.forEach(result.Items ?? [], decode, { concurrency: 1 });
    return Arr.head(Arr.filter(found, (failure) => failure.userId === userId));
  });

  const find = Effect.fn("FailureRepo.find")(function* (userId: string, failureId: string) {
    const now = yield* DateTime.now;
    const located = yield* locate(userId, failureId);
    if (Option.isNone(located)) return Option.none<Failure>();
    // The index may lag a deletion; the table itself is read strongly.
    const item = yield* DynamoDB.getItem({
      TableName,
      Key: failureKey(located.value.aliasId, failureId),
      ConsistentRead: true,
    }).pipe(
      Effect.map((read) => Option.fromUndefinedOr(read.Item)),
      Effect.mapError(databaseError("GetItem")),
    );
    const failure = yield* Option.match(item, {
      onNone: () => Effect.succeedNone,
      onSome: (present) => Effect.asSome(decode(present)),
    });
    return Option.filter(failure, (live) => live.userId === userId && isLive(now)(live));
  });

  const remove = Effect.fn("FailureRepo.delete")(function* (userId: string, failureId: string) {
    const located = yield* locate(userId, failureId);
    if (Option.isNone(located)) return Option.none<Failure>();
    const item = yield* DynamoDB.deleteItem({
      TableName,
      Key: failureKey(located.value.aliasId, failureId),
      ConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": { S: userId } },
      ReturnValues: "ALL_OLD",
    }).pipe(
      Effect.map((result) =>
        Option.filter(Option.fromUndefinedOr(result.Attributes), (old) => P.hasProperty(old, "pk")),
      ),
      Effect.catchIf(
        (error) => P.isTagged(error, "ConditionalCheckFailedException"),
        () => Effect.succeedNone,
      ),
      Effect.mapError(databaseError("DeleteItem")),
    );
    return yield* Option.match(item, {
      onNone: () => Effect.succeedNone,
      onSome: (old) => Effect.asSome(decode(old)),
    });
  });

  return FailureRepo.of({
    insert: (failure, alias) => Effect.provide(insert(failure, alias), client),
    list: (userId) => Effect.provide(list(userId), client),
    find: (userId, failureId) => Effect.provide(find(userId, failureId), client),
    delete: (userId, failureId) => Effect.provide(remove(userId, failureId), client),
    reserve: (userId, now, maxPerDay) => {
      const day = Quota.window(now, "day");
      return Quota.reserve(table, quotaKey(userId, day.label), day, maxPerDay).pipe(
        Effect.provide(client),
      );
    },
  });
});

export const layer = Layer.effect(FailureRepo, make());
