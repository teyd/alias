import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
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
    /** Fails with `AliasTaken` when the address exists, whatever its letter case. */
    readonly insert: (alias: NewAlias) => Effect.Effect<void, AliasTaken | DatabaseError>;
    readonly findByAddress: (
      domain: string,
      localPart: string,
    ) => Effect.Effect<Option.Option<Alias>, DatabaseError>;
    /** Oldest first. */
    readonly listByUser: (userId: string) => Effect.Effect<ReadonlyArray<Alias>, DatabaseError>;
    /** Applies the given changes and returns the alias as stored afterwards. */
    readonly update: (
      address: OwnedAddress,
      changes: AliasChanges,
    ) => Effect.Effect<Alias, NoSuchAlias | DatabaseError>;
    readonly delete: (address: OwnedAddress) => Effect.Effect<void, NoSuchAlias | DatabaseError>;
    /** Atomically adds one to a counter. Never recreates a deleted alias. */
    readonly increment: (
      domain: string,
      localPart: string,
      counter: Counter,
    ) => Effect.Effect<void, NoSuchAlias | DatabaseError>;
  }
>()("@alias/db/AliasRepo") {}

/** Addresses are case-insensitive, so keys use the lowercased address. */
const addressKey = (domain: string, localPart: string) => ({
  pk: { S: `ALIAS#${domain.toLowerCase()}#${localPart.toLowerCase()}` },
  sk: { S: "ALIAS" },
});

const userKey = (userId: string) => `USER#${userId}`;

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

const decodeItem = Schema.decodeUnknownEffect(AliasItem);
const decodeFields = Schema.decodeUnknownEffect(Alias);

const decodeAlias = (item: DynamoDB.AttributeMap) =>
  decodeItem(item).pipe(
    Effect.flatMap(decodeFields),
    Effect.mapError(databaseError("DecodeAlias")),
  );

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
          ...addressKey(domain, localPart),
          gsi1pk: { S: userKey(alias.userId) },
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
        ConditionExpression: "attribute_not_exists(pk)",
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
        Key: addressKey(domain, localPart),
        ConsistentRead: true,
      }).pipe(
        Effect.mapError(databaseError("GetItem")),
        Effect.flatMap((result) =>
          Option.match(Option.fromUndefinedOr(result.Item), {
            onNone: () => Effect.succeedNone,
            onSome: (item) => Effect.asSome(decodeAlias(item)),
          }),
        ),
        Effect.provide(client),
      ),

    listByUser: (userId) =>
      DynamoDB.query
        .items({
          TableName: table.name,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :user",
          ExpressionAttributeValues: { ":user": { S: userKey(userId) } },
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
        Key: addressKey(address.domain, address.localPart),
        // With nothing to change, a no-op SET still checks ownership and returns the item.
        UpdateExpression: Arr.match(names, {
          onEmpty: () => "SET userId = userId",
          onNonEmpty: (list) =>
            `SET ${Arr.join(
              Arr.map(list, (name) => `#${name} = :${name}`),
              ", ",
            )}`,
        }),
        ConditionExpression: "userId = :userId",
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
      DynamoDB.deleteItem({
        TableName: table.name,
        Key: addressKey(address.domain, address.localPart),
        ConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": { S: address.userId } },
      }).pipe(
        Effect.asVoid,
        Effect.mapError(missingOn("DeleteItem", address.domain, address.localPart)),
        Effect.provide(client),
      ),

    increment: (domain, localPart, counter) =>
      DynamoDB.updateItem({
        TableName: table.name,
        Key: addressKey(domain, localPart),
        UpdateExpression: "ADD #counter :one",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#counter": counterAttribute[counter] },
        ExpressionAttributeValues: { ":one": { N: "1" } },
      }).pipe(
        Effect.asVoid,
        Effect.mapError(missingOn("UpdateItem", domain, localPart)),
        Effect.provide(client),
      ),
  });
});

export const layer = Layer.effect(AliasRepo, make());
