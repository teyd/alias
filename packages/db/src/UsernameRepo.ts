import type { Username } from "@alias/core";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import { conditionFailedAt } from "./Transaction.ts";
import { UsernameTaken, userKey, usernameKey } from "./UserRepo.ts";

/**
 * A username a user added next to the one they signed up with (PLAN.md §20.34): its own
 * subdomain of every shared domain, with its own on-the-fly setting and default recipient. The
 * primary username stays the login handle; its settings are the account's (`UserRepo.settings`,
 * the default recipient).
 */
export interface AdditionalUsername {
  readonly username: string;
  readonly userId: string;
  readonly createdAt: DateTime.Utc;
  /** Mail to an unknown address on its subdomains creates the alias. Off until turned on. */
  readonly isOnTheFlyEnabled: boolean;
  /** Where its aliases forward to; none means the account's default recipient. */
  readonly defaultRecipientId: Option.Option<string>;
}

export interface NewUsername {
  readonly userId: string;
  readonly username: Username.Username;
  readonly createdAt: DateTime.Utc;
}

/**
 * Only what is `some` changes; `defaultRecipientId: some(none)` goes back to the account's
 * default.
 */
export interface UsernameChanges {
  readonly isOnTheFlyEnabled: Option.Option<boolean>;
  readonly defaultRecipientId: Option.Option<Option.Option<string>>;
}

/** Who a subdomain's username belongs to, as the inbound Lambda and the API resolve it. */
export interface Owner {
  readonly userId: string;
  readonly username: string;
  /** None for the primary username, whose settings are the account's. */
  readonly additional: Option.Option<AdditionalUsername>;
}

export class TooManyUsernames extends Schema.TaggedError<TooManyUsernames>()("TooManyUsernames", {
  limit: Schema.Number,
}) {}

/** Not one of the user's additional usernames (unknown, someone else's, or the primary). */
export class NoSuchUsername extends Schema.TaggedError<NoSuchUsername>()("NoSuchUsername", {
  username: Schema.String,
}) {}

export class UsernameRepo extends Context.Service<
  UsernameRepo,
  {
    /**
     * Claims the username's skeleton for the user, as sign-up does, and adds it to their list.
     * Fails when anyone has it or a lookalike (erased and deleted ones included), or the user has
     * `maxPerUser` additional usernames. Both checks are atomic.
     */
    readonly add: (
      username: NewUsername,
      maxPerUser: number,
    ) => Effect.Effect<AdditionalUsername, UsernameTaken | TooManyUsernames | DatabaseError>;
    /** Oldest first; strongly consistent. Includes one whose deletion is still unfinished. */
    readonly listByUser: (
      userId: string,
    ) => Effect.Effect<ReadonlyArray<AdditionalUsername>, DatabaseError>;
    /** The user's additional username, by its exact name. */
    readonly find: (
      userId: string,
      username: string,
    ) => Effect.Effect<Option.Option<AdditionalUsername>, DatabaseError>;
    /**
     * Who has exactly this username (lowercase, as subdomains carry it), primary or additional.
     * A lookalike that merely shares its skeleton finds no one, and neither does a deleted or
     * erased username.
     */
    readonly findOwner: (username: string) => Effect.Effect<Option.Option<Owner>, DatabaseError>;
    /** Applies the given changes and returns the username as stored afterwards. */
    readonly update: (
      userId: string,
      username: string,
      changes: UsernameChanges,
    ) => Effect.Effect<AdditionalUsername, NoSuchUsername | DatabaseError>;
    /**
     * The first step of deleting an additional username: its claim becomes a tombstone
     * (`deletedAt`, no owner), so nobody ever gets it or a lookalike again and nothing new is
     * created on its subdomains. The user's list keeps it until {@link remove}, so a deletion
     * that fails halfway can be retried. Safe to run again.
     */
    readonly retire: (
      userId: string,
      username: string,
    ) => Effect.Effect<void, NoSuchUsername | DatabaseError>;
    /** The last step: takes it off the user's list, freeing its slot. */
    readonly remove: (
      userId: string,
      username: string,
    ) => Effect.Effect<void, NoSuchUsername | DatabaseError>;
  }
>()("@alias/db/UsernameRepo") {}

/** The user's entry for an additional username, holding its settings. */
const entryKey = (userId: string, username: string) => ({
  pk: { S: `USER#${userId}` },
  sk: { S: `USERNAME#${username}` },
});

/** How many additional usernames the user has, kept in the same transactions as the claims. */
const countKey = (userId: string) => ({ pk: { S: `USER#${userId}` }, sk: { S: "USERNAMES" } });

const EntryItem = Item.codec(
  Schema.Struct({
    username: Attribute.S,
    userId: Attribute.S,
    createdAt: Attribute.EpochMillis,
    isOnTheFlyEnabled: Attribute.BOOL,
    defaultRecipientId: Schema.OptionFromOptionalKey(Attribute.S),
  }),
  "AdditionalUsername",
);

/** A claim as the sign-up and this repository write it; an additional one says so. */
const ClaimItem = Item.codec(
  Schema.Struct({
    userId: Attribute.S,
    username: Attribute.S,
    isAdditional: Schema.optionalKey(Attribute.BOOL),
  }),
  "Username",
);

/** A deleted or erased username keeps its claim as a tombstone: `deletedAt`, no owner. */
const isClaimed = (item: DynamoDB.AttributeMap) => P.hasProperty(item, "userId");

const oldestFirst = Order.mapInput(
  DateTime.Order,
  (username: AdditionalUsername) => username.createdAt,
);

const make = Effect.fn("UsernameRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const getItem = (key: { readonly pk: { S: string }; readonly sk: { S: string } }) =>
    DynamoDB.getItem({ TableName, Key: key, ConsistentRead: true }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.map((result) => Option.fromUndefinedOr(result.Item)),
    );

  const find = (userId: string, username: string) =>
    getItem(entryKey(userId, username)).pipe(
      Effect.flatMap(EntryItem.decodeOption),
      Effect.provide(client),
    );

  const notFound = (username: string) => new NoSuchUsername({ username });

  return UsernameRepo.of({
    add: Effect.fn("UsernameRepo.add")(function* (requested, maxPerUser) {
      const stored: AdditionalUsername = {
        username: requested.username,
        userId: requested.userId,
        createdAt: requested.createdAt,
        isOnTheFlyEnabled: false,
        defaultRecipientId: Option.none(),
      };
      const entry = yield* EntryItem.encode(stored);
      const claim = yield* ClaimItem.encode({
        userId: requested.userId,
        username: requested.username,
        isAdditional: true,
      });
      yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Update: {
              TableName,
              Key: countKey(requested.userId),
              UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one",
              ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
              ExpressionAttributeNames: { "#count": "count" },
              ExpressionAttributeValues: {
                ":zero": { N: "0" },
                ":one": { N: "1" },
                ":max": { N: String(maxPerUser) },
              },
            },
          },
          {
            Put: {
              TableName,
              Item: { ...usernameKey(requested.username), ...claim },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName,
              Item: { ...entryKey(requested.userId, requested.username), ...entry },
            },
          },
        ],
      }).pipe(
        Effect.mapError((error) => {
          if (conditionFailedAt(error, 1)) {
            return new UsernameTaken({ username: requested.username });
          }
          if (conditionFailedAt(error, 0)) return new TooManyUsernames({ limit: maxPerUser });
          return databaseError("TransactWriteItems")(error);
        }),
        Effect.provide(client),
      );
      return stored;
    }),

    listByUser: (userId) =>
      DynamoDB.query
        .items({
          TableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": { S: `USER#${userId}` },
            ":prefix": { S: "USERNAME#" },
          },
          ConsistentRead: true,
        })
        .pipe(
          Stream.mapError(databaseError("Query")),
          Stream.mapEffect(EntryItem.decode),
          Stream.runCollect,
          Effect.map(Arr.sort(oldestFirst)),
          Effect.provide(client),
        ),

    find,

    findOwner: Effect.fn("UsernameRepo.findOwner")(function* (username) {
      const claim = yield* getItem(usernameKey(username)).pipe(
        Effect.flatMap((item) => ClaimItem.decodeOption(Option.filter(item, isClaimed))),
        Effect.provide(client),
      );
      const exact = Option.filter(claim, (found) => found.username === username);
      if (Option.isNone(exact)) return Option.none<Owner>();
      const { userId } = exact.value;
      if (exact.value.isAdditional === true) {
        const additional = yield* find(userId, username);
        return Option.map(additional, (found): Owner => ({
          userId,
          username,
          additional: Option.some(found),
        }));
      }
      // Sign-up writes the claim with the user; the user may be on their way out (erasure).
      const user = yield* getItem(userKey(userId)).pipe(Effect.provide(client));
      return Option.map(user, (): Owner => ({ userId, username, additional: Option.none() }));
    }),

    update: Effect.fn("UsernameRepo.update")(function* (userId, username, changes) {
      const recipient = changes.defaultRecipientId;
      const values = R.getSomes<string, DynamoDB.AttributeValue>({
        isOnTheFlyEnabled: Option.map(changes.isOnTheFlyEnabled, (isEnabled) => ({
          BOOL: isEnabled,
        })),
        defaultRecipientId: Option.map(Option.flatten(recipient), (id) => ({ S: id })),
      });
      const names = R.keys(values);
      const clauses = [
        ...Arr.match(names, {
          onEmpty: () => [],
          onNonEmpty: (list) => [
            `SET ${Arr.join(
              Arr.map(list, (name) => `${name} = :${name}`),
              ", ",
            )}`,
          ],
        }),
        ...(Option.exists(recipient, Option.isNone) ? ["REMOVE defaultRecipientId"] : []),
      ];
      const result = yield* DynamoDB.updateItem({
        TableName,
        Key: entryKey(userId, username),
        // With nothing to change, a no-op SET still checks the entry exists and returns it.
        UpdateExpression: Arr.isArrayNonEmpty(clauses)
          ? Arr.join(clauses, " ")
          : "SET userId = userId",
        ConditionExpression: "attribute_exists(pk)",
        ...Arr.match(names, {
          onEmpty: () => ({}),
          onNonEmpty: () => ({
            ExpressionAttributeValues: R.mapKeys(values, (name) => `:${name}`),
          }),
        }),
        ReturnValues: "ALL_NEW",
      }).pipe(
        Effect.mapError((error) =>
          P.isTagged(error, "ConditionalCheckFailedException")
            ? notFound(username)
            : databaseError("UpdateItem")(error),
        ),
        Effect.provide(client),
      );
      return yield* EntryItem.decode({ ...result.Attributes });
    }),

    retire: Effect.fn("UsernameRepo.retire")(function* (userId, username) {
      if (Option.isNone(yield* find(userId, username))) return yield* notFound(username);
      const deletedAt = yield* Schema.encodeEffect(Attribute.EpochMillis)(yield* DateTime.now).pipe(
        Effect.mapError(databaseError("EncodeTombstone")),
      );
      yield* DynamoDB.updateItem({
        TableName,
        Key: usernameKey(username),
        UpdateExpression:
          "SET deletedAt = if_not_exists(deletedAt, :deletedAt) " +
          "REMOVE #userId, #username, isAdditional",
        // Already a tombstone (an earlier attempt) passes; someone else's claim never does.
        ConditionExpression: "attribute_not_exists(#userId) OR #userId = :userId",
        ExpressionAttributeNames: { "#userId": "userId", "#username": "username" },
        ExpressionAttributeValues: { ":userId": { S: userId }, ":deletedAt": deletedAt },
      }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          P.isTagged(error, "ConditionalCheckFailedException")
            ? notFound(username)
            : databaseError("UpdateItem")(error),
        ),
        Effect.provide(client),
      );
    }),

    remove: (userId, username) =>
      DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Delete: {
              TableName,
              Key: entryKey(userId, username),
              ConditionExpression: "attribute_exists(pk)",
            },
          },
          {
            Update: {
              TableName,
              Key: countKey(userId),
              UpdateExpression: "ADD #count :minusOne",
              ExpressionAttributeNames: { "#count": "count" },
              ExpressionAttributeValues: { ":minusOne": { N: "-1" } },
            },
          },
        ],
      }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          conditionFailedAt(error, 0)
            ? notFound(username)
            : databaseError("TransactWriteItems")(error),
        ),
        Effect.provide(client),
      ),
  });
});

export const layer = Layer.effect(UsernameRepo, make());
