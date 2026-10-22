import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Attribute from "./Attribute.ts";
import * as Item from "./Item.ts";
import { aliasKey, contactsPartition } from "./Keys.ts";
import * as Purge from "./Purge.ts";
import * as Quota from "./Quota.ts";

const AliasMode = Schema.Literals(["forward", "inbox", "both"]);
type AliasMode = typeof AliasMode.Type;

export const Alias = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  domain: Schema.String,
  localPart: Schema.String,
  mode: AliasMode,
  isActive: Schema.Boolean,
  createdAt: Schema.Number,
  forwardedCount: Schema.Number,
  blockedCount: Schema.Number,
});
export type Alias = typeof Alias.Type;

export interface NewAlias {
  readonly id: string;
  readonly userId: string;
  readonly domain: string;
  readonly localPart: string;
  readonly mode: AliasMode;
  readonly createdAt: number;
}

export class AliasTaken extends Schema.TaggedError<AliasTaken>()("AliasTaken", {
  address: Schema.String,
}) {}

/** An owned alias. Mutations name the owner so they can't touch someone else's alias. */
interface OwnedAddress {
  readonly userId: string;
  readonly domain: string;
  readonly localPart: string;
}

interface AliasChanges {
  readonly mode?: AliasMode;
  readonly isActive?: boolean;
}

type Counter = "forwarded" | "blocked";

/** The alias doesn't exist, or (for owned mutations) belongs to another user. */
export class NoSuchAlias extends Schema.TaggedError<NoSuchAlias>()("NoSuchAlias", {
  address: Schema.String,
}) {}

export class AliasRepo extends Context.Service<
  AliasRepo,
  {
    /**
     * Fails with `AliasTaken` when the address exists, whatever its letter case, or was deleted:
     * a deleted address stays taken for good, except that the user who deleted it may create it
     * again.
     */
    readonly insert: (alias: NewAlias) => Effect.Effect<void, AliasTaken | DatabaseError>;
    /** None for unknown and for deleted addresses. */
    readonly findByAddress: (
      domain: string,
      localPart: string,
    ) => Effect.Effect<Option.Option<Alias>, DatabaseError>;
    /** True when an alias at this address was deleted (its tombstone is all that is left). */
    readonly isDeleted: (
      domain: string,
      localPart: string,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Oldest first. */
    readonly listByUser: (userId: string) => Effect.Effect<ReadonlyArray<Alias>, DatabaseError>;
    /** Applies the given changes and returns the alias as stored afterwards. */
    readonly update: (
      address: OwnedAddress,
      changes: AliasChanges,
    ) => Effect.Effect<Alias, NoSuchAlias | DatabaseError>;
    /**
     * Deletes the alias for good: its contacts and forward counters go too, and a tombstone keeps
     * the address from ever being claimed by anyone else (see `Table.ts`). Calling it again on a
     * deletion that failed halfway finishes it; on a finished one it fails with `NoSuchAlias`.
     */
    readonly delete: (address: OwnedAddress) => Effect.Effect<void, NoSuchAlias | DatabaseError>;
    /**
     * Deletes every alias the user has on `domain`, and their tombstones too, so nothing is left
     * of them. For a custom domain its owner removes (PLAN.md §20.18.1): whoever owns the domain
     * next controls its mail anyway, so a tombstone would protect nobody and only keep the next
     * owner from those addresses. Safe to run again.
     */
    readonly releaseDomain: (userId: string, domain: string) => Effect.Effect<void, DatabaseError>;
    /** Atomically adds one to a counter. Never recreates a deleted alias. */
    readonly increment: (
      domain: string,
      localPart: string,
      counter: Counter,
    ) => Effect.Effect<void, NoSuchAlias | DatabaseError>;
    /**
     * Counts one forward against the alias's allowance of `maxPerHour` for the UTC hour `now`
     * falls in. False, and nothing counted, when the allowance is used up. Concurrent callers
     * never exceed it.
     */
    readonly reserveForward: (
      domain: string,
      localPart: string,
      now: DateTime.Utc,
      maxPerHour: number,
    ) => Effect.Effect<boolean, DatabaseError>;
    /**
     * Counts one alias created on the fly (by mail to the user's subdomain) against the user's
     * allowance of `maxPerDay` for the UTC day `now` falls in. False when it is used up.
     */
    readonly reserveCreation: (
      userId: string,
      now: DateTime.Utc,
      maxPerDay: number,
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("@alias/db/AliasRepo") {}

/** The alias's forward counter for one UTC hour, next to the alias in its partition. */
const forwardQuotaKey = (domain: string, localPart: string, hour: string) => ({
  pk: aliasKey(domain, localPart).pk,
  sk: { S: `FORWARDS#${hour}` },
});

/** The user's partition, and the gsi1 partition listing their aliases. */
export const userPartition = (userId: string) => `USER#${userId}`;

/** The gsi1 partition listing a user's tombstones, so erasing the account finds them. */
export const deletedKey = (userId: string) => `DELETED-ALIASES#${userId}`;

/** The user's count of aliases created on the fly in one UTC day, in their partition. */
const creationQuotaKey = (userId: string, day: string) => ({
  pk: { S: userPartition(userId) },
  sk: { S: `ALIASES#${day}` },
});

/** Zero-padded so string order on the index matches creation order. */
const userSortKey = (alias: NewAlias) =>
  `ALIAS#${String(alias.createdAt).padStart(15, "0")}#${alias.id}`;

/** An alias item as stored. The repository doesn't read key attributes back. */
const AliasItem = Schema.Struct({
  id: Attribute.S,
  userId: Attribute.S,
  domain: Attribute.S,
  localPart: Attribute.S,
  mode: Attribute.S,
  isActive: Attribute.BOOL,
  createdAt: Attribute.N,
  forwardedCount: Attribute.N,
  blockedCount: Attribute.N,
});

const counterAttribute = { forwarded: "forwardedCount", blocked: "blockedCount" } as const;

const formatAddress = (domain: string, localPart: string) =>
  `${localPart.toLowerCase()}@${domain.toLowerCase()}`;

/** Maps a failed condition (missing or not owned) to `NoSuchAlias`. */
const missingOn =
  (operation: string, domain: string, localPart: string) =>
  <E>(error: E) =>
    P.isTagged(error, "ConditionalCheckFailedException")
      ? new NoSuchAlias({ address: formatAddress(domain, localPart) })
      : databaseError(operation)(error);

/**
 * What a deleted alias leaves behind, in place of the alias item. `userId` names who deleted it
 * (gone once their account is erased); `id` is the deleted alias's id, kept only until its
 * contacts are purged.
 */
const TombstoneItem = Item.codec(
  Schema.Struct({
    deletedAt: Attribute.EpochMillis,
    userId: Schema.OptionFromOptionalKey(Attribute.S),
    id: Schema.OptionFromOptionalKey(Attribute.S),
  }),
  "Tombstone",
);

const isTombstone = (item: DynamoDB.AttributeMap) => P.hasProperty(item, "deletedAt");

const decodeItem = Schema.decodeUnknownEffect(AliasItem);
const decodeFields = Schema.decodeUnknownEffect(Alias);

const decodeAlias = (item: DynamoDB.AttributeMap) =>
  decodeItem(item).pipe(
    Effect.flatMap(decodeFields),
    Effect.mapError(databaseError("DecodeAlias")),
  );

/**
 * Turns the owner's alias at `key` into its tombstone and returns the deleted alias's id, whose
 * contacts are still to purge. A tombstone left halfway by an earlier call returns the same id,
 * so retries finish the job.
 */
export const retire = Effect.fn("AliasRepo.retire")(function* (
  table: typeof DynamoTable.Service,
  address: OwnedAddress,
) {
  const key = aliasKey(address.domain, address.localPart);
  const deletedAt = yield* Schema.encodeEffect(Attribute.EpochMillis)(yield* DateTime.now).pipe(
    Effect.mapError(databaseError("EncodeTombstone")),
  );
  const retired = yield* DynamoDB.updateItem({
    TableName: table.name,
    Key: key,
    UpdateExpression:
      "SET deletedAt = :deletedAt, gsi1pk = :deleted, gsi1sk = :address " +
      "REMOVE #domain, #localPart, #mode, #isActive, #createdAt, #forwarded, #blocked",
    ConditionExpression: "userId = :userId AND attribute_not_exists(deletedAt)",
    ExpressionAttributeNames: {
      "#domain": "domain",
      "#localPart": "localPart",
      "#mode": "mode",
      "#isActive": "isActive",
      "#createdAt": "createdAt",
      "#forwarded": "forwardedCount",
      "#blocked": "blockedCount",
    },
    ExpressionAttributeValues: {
      ":userId": { S: address.userId },
      ":deletedAt": deletedAt,
      ":deleted": { S: deletedKey(address.userId) },
      ":address": key.pk,
    },
    ReturnValues: "ALL_NEW",
  }).pipe(
    Effect.map((result) => Option.some(result.Attributes ?? {})),
    Effect.catchIf(
      (error) => P.isTagged(error, "ConditionalCheckFailedException"),
      () =>
        DynamoDB.getItem({ TableName: table.name, Key: key, ConsistentRead: true }).pipe(
          Effect.map((result) => Option.fromUndefinedOr(result.Item)),
        ),
    ),
    Effect.mapError(databaseError("UpdateItem")),
  );
  const tombstone = yield* TombstoneItem.decodeOption(Option.filter(retired, isTombstone));
  const pending = Option.flatMap(
    Option.filter(tombstone, (found) => Option.contains(found.userId, address.userId)),
    (found) => found.id,
  );
  return yield* Option.match(pending, {
    onNone: () =>
      Effect.fail(new NoSuchAlias({ address: formatAddress(address.domain, address.localPart) })),
    onSome: Effect.succeed,
  });
});

/**
 * Deletes everything a deleted alias left besides its tombstone: its contacts (partition
 * `CONTACTS#<aliasId>`, both the contacts and their id pointers) and its forward counters, then
 * marks the tombstone done by dropping the alias id. Safe to run again.
 */
export const purge = Effect.fn("AliasRepo.purge")(function* (
  table: typeof DynamoTable.Service,
  key: Purge.Key,
  aliasId: string,
) {
  yield* Purge.deleteAll(
    table,
    yield* Purge.partitionKeys(table, contactsPartition(aliasId), Option.none()),
  );
  yield* Purge.deleteAll(
    table,
    yield* Purge.partitionKeys(table, key.pk.S, Option.some("FORWARDS#")),
  );
  yield* DynamoDB.updateItem({
    TableName: table.name,
    Key: key,
    UpdateExpression: "REMOVE #id",
    ConditionExpression: "#id = :id AND attribute_exists(deletedAt)",
    ExpressionAttributeNames: { "#id": "id" },
    ExpressionAttributeValues: { ":id": { S: aliasId } },
  }).pipe(
    Effect.asVoid,
    // Already done by a concurrent call.
    Effect.catchIf(
      (error) => P.isTagged(error, "ConditionalCheckFailedException"),
      () => Effect.void,
    ),
    Effect.mapError(databaseError("UpdateItem")),
  );
});

export const make = Effect.fn("AliasRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

  return AliasRepo.of({
    insert: (alias) => {
      const domain = alias.domain.toLowerCase();
      const localPart = alias.localPart.toLowerCase();
      return DynamoDB.putItem({
        TableName: table.name,
        Item: {
          ...aliasKey(domain, localPart),
          gsi1pk: { S: userPartition(alias.userId) },
          gsi1sk: { S: userSortKey(alias) },
          id: { S: alias.id },
          userId: { S: alias.userId },
          domain: { S: domain },
          localPart: { S: localPart },
          mode: { S: alias.mode },
          isActive: { BOOL: true },
          createdAt: { N: String(alias.createdAt) },
          forwardedCount: { N: "0" },
          blockedCount: { N: "0" },
        },
        // A tombstone whose contacts are purged gives the address back to the user who deleted it.
        ConditionExpression:
          "attribute_not_exists(pk) OR " +
          "(attribute_exists(deletedAt) AND userId = :userId AND attribute_not_exists(#id))",
        ExpressionAttributeNames: { "#id": "id" },
        ExpressionAttributeValues: { ":userId": { S: alias.userId } },
      }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          P.isTagged(error, "ConditionalCheckFailedException")
            ? new AliasTaken({ address: `${localPart}@${domain}` })
            : databaseError("PutItem")(error),
        ),
        Effect.provide(client),
      );
    },

    findByAddress: (domain, localPart) =>
      DynamoDB.getItem({
        TableName: table.name,
        Key: aliasKey(domain, localPart),
        ConsistentRead: true,
      }).pipe(
        Effect.mapError(databaseError("GetItem")),
        Effect.flatMap((result) =>
          Option.match(
            Option.filter(Option.fromUndefinedOr(result.Item), (item) => !isTombstone(item)),
            {
              onNone: () => Effect.succeedNone,
              onSome: (item) => Effect.asSome(decodeAlias(item)),
            },
          ),
        ),
        Effect.provide(client),
      ),

    isDeleted: (domain, localPart) =>
      DynamoDB.getItem({
        TableName: table.name,
        Key: aliasKey(domain, localPart),
        ConsistentRead: true,
        ProjectionExpression: "deletedAt",
      }).pipe(
        Effect.mapError(databaseError("GetItem")),
        Effect.map((result) => Option.exists(Option.fromUndefinedOr(result.Item), isTombstone)),
        Effect.provide(client),
      ),

    listByUser: (userId) =>
      DynamoDB.query
        .items({
          TableName: table.name,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :user",
          ExpressionAttributeValues: { ":user": { S: userPartition(userId) } },
        })
        .pipe(
          Stream.mapError(databaseError("Query")),
          Stream.mapEffect(decodeAlias),
          Stream.runCollect,
          Effect.provide(client),
        ),

    update: (address, changes) => {
      const values = R.getSomes<string, DynamoDB.AttributeValue>({
        mode: Option.map(Option.fromUndefinedOr(changes.mode), (mode) => ({ S: mode })),
        isActive: Option.map(Option.fromUndefinedOr(changes.isActive), (isActive) => ({
          BOOL: isActive,
        })),
      });
      const names = R.keys(values);
      return DynamoDB.updateItem({
        TableName: table.name,
        Key: aliasKey(address.domain, address.localPart),
        // With nothing to change, a no-op SET still checks ownership and returns the item.
        UpdateExpression: Arr.match(names, {
          onEmpty: () => "SET userId = userId",
          onNonEmpty: (list) =>
            `SET ${Arr.join(
              Arr.map(list, (name) => `#${name} = :${name}`),
              ", ",
            )}`,
        }),
        ConditionExpression: "userId = :userId AND attribute_not_exists(deletedAt)",
        // Placeholders keep attribute names clear of DynamoDB's reserved words.
        ...Arr.match(names, {
          onEmpty: () => ({}),
          onNonEmpty: (list) => ({
            ExpressionAttributeNames: R.fromEntries(Arr.map(list, (name) => [`#${name}`, name])),
          }),
        }),
        ExpressionAttributeValues: {
          ":userId": { S: address.userId },
          ...R.mapKeys(values, (name) => `:${name}`),
        },
        ReturnValues: "ALL_NEW",
      }).pipe(
        Effect.mapError(missingOn("UpdateItem", address.domain, address.localPart)),
        Effect.flatMap((result) => decodeAlias({ ...result.Attributes })),
        Effect.provide(client),
      );
    },

    delete: (address) =>
      retire(table, address).pipe(
        Effect.flatMap((aliasId) =>
          purge(table, aliasKey(address.domain, address.localPart), aliasId),
        ),
        Effect.provide(client),
      ),

    releaseDomain: Effect.fn("AliasRepo.releaseDomain")(function* (userId, domain) {
      const name = domain.toLowerCase();
      const onDomain = `ALIAS#${name}#`;
      const live = yield* Purge.indexItems(table, userPartition(userId)).pipe(
        Effect.provide(client),
      );
      yield* Effect.forEach(
        live,
        Effect.fnUntraced(function* (item) {
          const alias = yield* decodeAlias(item);
          if (alias.domain !== name) return;
          const key = aliasKey(alias.domain, alias.localPart);
          yield* retire(table, { userId, domain: alias.domain, localPart: alias.localPart }).pipe(
            Effect.flatMap((aliasId) => purge(table, key, aliasId)),
            Effect.catchTag("NoSuchAlias", () => Effect.void),
          );
        }),
        { concurrency: 4, discard: true },
      ).pipe(Effect.provide(client));
      const retired = yield* Purge.indexItems(table, deletedKey(userId)).pipe(
        Effect.provide(client),
      );
      yield* Effect.forEach(
        retired,
        Effect.fnUntraced(function* (item) {
          const key = yield* Purge.keyOf(item);
          if (!key.pk.S.startsWith(onDomain)) return;
          const tombstone = yield* TombstoneItem.decode(item);
          if (Option.isSome(tombstone.id)) yield* purge(table, key, tombstone.id.value);
          yield* DynamoDB.deleteItem({
            TableName: table.name,
            Key: key,
            ConditionExpression: "attribute_exists(deletedAt) AND userId = :userId",
            ExpressionAttributeValues: { ":userId": { S: userId } },
          }).pipe(
            Effect.catchIf(
              (error) => P.isTagged(error, "ConditionalCheckFailedException"),
              () => Effect.void,
            ),
            Effect.mapError(databaseError("DeleteItem")),
          );
        }),
        { concurrency: 4, discard: true },
      ).pipe(Effect.provide(client));
    }),

    increment: (domain, localPart, counter) =>
      DynamoDB.updateItem({
        TableName: table.name,
        Key: aliasKey(domain, localPart),
        UpdateExpression: "ADD #counter :one",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(deletedAt)",
        ExpressionAttributeNames: { "#counter": counterAttribute[counter] },
        ExpressionAttributeValues: { ":one": { N: "1" } },
      }).pipe(
        Effect.asVoid,
        Effect.mapError(missingOn("UpdateItem", domain, localPart)),
        Effect.provide(client),
      ),

    reserveForward: (domain, localPart, now, maxPerHour) => {
      const hour = Quota.window(now, "hour");
      return Quota.reserve(
        table,
        forwardQuotaKey(domain, localPart, hour.label),
        hour,
        maxPerHour,
      ).pipe(Effect.provide(client));
    },

    reserveCreation: (userId, now, maxPerDay) => {
      const day = Quota.window(now, "day");
      return Quota.reserve(table, creationQuotaKey(userId, day.label), day, maxPerDay).pipe(
        Effect.provide(client),
      );
    },
  });
});

export const layer = Layer.effect(AliasRepo, make());
