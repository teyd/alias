import { Username } from "@alias/core";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import { type Passkey, passkeyItem } from "./PasskeyRepo.ts";
import { conditionFailedAt } from "./Transaction.ts";

export interface User {
  readonly id: string;
  readonly username: string;
  readonly createdAt: DateTime.Utc;
}

export interface NewUser {
  readonly id: string;
  readonly username: Username.Username;
  readonly createdAt: DateTime.Utc;
}

/** What the user chose for their account. A user who never chose anything has the defaults. */
export interface UserSettings {
  /**
   * Mail to an unknown address on the user's own subdomain creates that alias on the fly instead
   * of being dropped. Opt-in: off by default.
   */
  readonly isOnTheFlyEnabled: boolean;
}

const defaultSettings: UserSettings = { isOnTheFlyEnabled: false };

/** The username, or a lookalike of it (same `Username.skeleton`), already belongs to someone. */
export class UsernameTaken extends Schema.TaggedError<UsernameTaken>()("UsernameTaken", {
  username: Schema.String,
}) {}

/** The authenticator returned a credential ID that is already registered. */
export class CredentialTaken extends Schema.TaggedError<CredentialTaken>()("CredentialTaken", {
  credentialId: Schema.String,
}) {}

export class UserRepo extends Context.Service<
  UserRepo,
  {
    /**
     * Creates the user, claims the username's skeleton and stores the first passkey in one
     * transaction, so there is never a user without a passkey or two users per skeleton.
     */
    readonly register: (
      user: NewUser,
      passkey: Passkey,
    ) => Effect.Effect<void, UsernameTaken | CredentialTaken | DatabaseError>;
    readonly findById: (userId: string) => Effect.Effect<Option.Option<User>, DatabaseError>;
    /**
     * True when the username or a lookalike of it is claimed, now or by an erased account: an
     * erased username is never given out again.
     */
    readonly isUsernameTaken: (
      username: Username.Username,
    ) => Effect.Effect<boolean, DatabaseError>;
    /**
     * The user with exactly this username (lowercase, as subdomains carry it). A lookalike that
     * merely shares its skeleton finds none, and neither does an erased username.
     */
    readonly findByUsername: (
      username: string,
    ) => Effect.Effect<Option.Option<User>, DatabaseError>;
    readonly settings: (userId: string) => Effect.Effect<UserSettings, DatabaseError>;
    /** Applies the given changes and returns the settings as stored afterwards. */
    readonly updateSettings: (
      userId: string,
      changes: Partial<UserSettings>,
    ) => Effect.Effect<UserSettings, DatabaseError>;
  }
>()("@alias/db/UserRepo") {}

export const userKey = (userId: string) => ({ pk: { S: `USER#${userId}` }, sk: { S: "USER" } });

/** Uniqueness is on the confusable skeleton, not the username itself. */
export const usernameKey = (username: string) => ({
  pk: { S: `USERNAME#${Username.skeleton(username)}` },
  sk: { S: "USERNAME" },
});

/** Settings live next to the user, in their partition; no item means the defaults. */
const settingsKey = (userId: string) => ({ pk: { S: `USER#${userId}` }, sk: { S: "SETTINGS" } });

const SettingsItem = Item.codec(
  Schema.Struct({ isOnTheFlyEnabled: Schema.optionalKey(Attribute.BOOL) }),
  "UserSettings",
);

const withDefaults = (stored: { readonly isOnTheFlyEnabled?: boolean }): UserSettings => ({
  isOnTheFlyEnabled: stored.isOnTheFlyEnabled ?? defaultSettings.isOnTheFlyEnabled,
});

const UserItem = Item.codec(
  Schema.Struct({ id: Attribute.S, username: Attribute.S, createdAt: Attribute.EpochMillis }),
  "User",
);

const UsernameItem = Item.codec(
  Schema.Struct({ userId: Attribute.S, username: Attribute.S }),
  "Username",
);

/** An erased account's username keeps its claim as a tombstone: `deletedAt`, no owner. */
const isClaimed = (item: DynamoDB.AttributeMap) => P.hasProperty(item, "userId");

const mustNotExist = "attribute_not_exists(pk)";

const make = Effect.fn("UserRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

  const findById = (userId: string) =>
    DynamoDB.getItem({ TableName: table.name, Key: userKey(userId), ConsistentRead: true }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.flatMap((result) => UserItem.decodeOption(Option.fromUndefinedOr(result.Item))),
      Effect.provide(client),
    );

  const settings = (userId: string) =>
    DynamoDB.getItem({
      TableName: table.name,
      Key: settingsKey(userId),
      ConsistentRead: true,
    }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.flatMap((result) => SettingsItem.decodeOption(Option.fromUndefinedOr(result.Item))),
      Effect.map(Option.match({ onNone: () => defaultSettings, onSome: withDefaults })),
      Effect.provide(client),
    );

  return UserRepo.of({
    register: Effect.fn("UserRepo.register")(function* (user, passkey) {
      const userItem = yield* UserItem.encode(user);
      const usernameItem = yield* UsernameItem.encode({
        userId: user.id,
        username: user.username,
      });
      const credential = yield* passkeyItem(passkey);
      yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Put: {
              TableName: table.name,
              Item: { ...userKey(user.id), ...userItem },
              ConditionExpression: mustNotExist,
            },
          },
          {
            Put: {
              TableName: table.name,
              Item: { ...usernameKey(user.username), ...usernameItem },
              ConditionExpression: mustNotExist,
            },
          },
          { Put: { TableName: table.name, Item: credential, ConditionExpression: mustNotExist } },
        ],
      }).pipe(
        Effect.mapError((error) => {
          if (conditionFailedAt(error, 1)) {
            return new UsernameTaken({ username: user.username });
          }
          if (conditionFailedAt(error, 2)) {
            return new CredentialTaken({ credentialId: passkey.id });
          }
          return databaseError("TransactWriteItems")(error);
        }),
        Effect.provide(client),
      );
    }),

    findById,

    isUsernameTaken: (username) =>
      DynamoDB.getItem({
        TableName: table.name,
        Key: usernameKey(username),
        ConsistentRead: true,
      }).pipe(
        Effect.mapError(databaseError("GetItem")),
        Effect.map((result) => P.isNotUndefined(result.Item)),
        Effect.provide(client),
      ),

    findByUsername: Effect.fn("UserRepo.findByUsername")(function* (username) {
      const claim = yield* DynamoDB.getItem({
        TableName: table.name,
        Key: usernameKey(username),
        ConsistentRead: true,
      }).pipe(
        Effect.mapError(databaseError("GetItem")),
        Effect.flatMap((result) =>
          UsernameItem.decodeOption(Option.filter(Option.fromUndefinedOr(result.Item), isClaimed)),
        ),
        Effect.provide(client),
      );
      const owner = Option.filter(claim, (found) => found.username === username);
      return Option.isNone(owner) ? Option.none() : yield* findById(owner.value.userId);
    }),

    settings,

    updateSettings: Effect.fn("UserRepo.updateSettings")(function* (userId, changes) {
      const values = R.getSomes<string, DynamoDB.AttributeValue>({
        isOnTheFlyEnabled: Option.map(
          Option.fromUndefinedOr(changes.isOnTheFlyEnabled),
          (isEnabled) => ({ BOOL: isEnabled }),
        ),
      });
      const names = R.keys(values);
      if (!Arr.isArrayNonEmpty(names)) return yield* settings(userId);
      const result = yield* DynamoDB.updateItem({
        TableName: table.name,
        Key: settingsKey(userId),
        UpdateExpression: `SET ${Arr.join(
          Arr.map(names, (name) => `#${name} = :${name}`),
          ", ",
        )}`,
        ExpressionAttributeNames: R.fromEntries(Arr.map(names, (name) => [`#${name}`, name])),
        ExpressionAttributeValues: R.mapKeys(values, (name) => `:${name}`),
        ReturnValues: "ALL_NEW",
      }).pipe(Effect.mapError(databaseError("UpdateItem")), Effect.provide(client));
      return withDefaults(yield* SettingsItem.decode({ ...result.Attributes }));
    }),
  });
});

export const layer = Layer.effect(UserRepo, make());
