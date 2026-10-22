import { Username } from "@alias/core";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
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
    /** True when the username or a lookalike of it is claimed. */
    readonly isUsernameTaken: (
      username: Username.Username,
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("@alias/db/UserRepo") {}

const userKey = (userId: string) => ({ pk: { S: `USER#${userId}` }, sk: { S: "USER" } });

/** Uniqueness is on the confusable skeleton, not the username itself. */
const usernameKey = (username: string) => ({
  pk: { S: `USERNAME#${Username.skeleton(username)}` },
  sk: { S: "USERNAME" },
});

const UserItem = Item.codec(
  Schema.Struct({ id: Attribute.S, username: Attribute.S, createdAt: Attribute.EpochMillis }),
  "User",
);

const UsernameItem = Item.codec(
  Schema.Struct({ userId: Attribute.S, username: Attribute.S }),
  "Username",
);

const mustNotExist = "attribute_not_exists(pk)";

const make = Effect.fn("UserRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

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

    findById: (userId) =>
      DynamoDB.getItem({ TableName: table.name, Key: userKey(userId), ConsistentRead: true }).pipe(
        Effect.mapError(databaseError("GetItem")),
        Effect.flatMap((result) => UserItem.decodeOption(Option.fromUndefinedOr(result.Item))),
        Effect.provide(client),
      ),

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
  });
});

export const layer = Layer.effect(UserRepo, make());
