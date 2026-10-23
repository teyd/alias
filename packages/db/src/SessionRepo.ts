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
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";

export interface Session {
  /** A hash of the cookie token, never the token itself, so a table dump yields no sessions. */
  readonly id: string;
  readonly userId: string;
  /** Copied from the user (usernames never change), so authenticating takes one read. */
  readonly username: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export class NoSuchSession extends Schema.TaggedError<NoSuchSession>()("NoSuchSession", {
  sessionId: Schema.String,
}) {}

export class SessionRepo extends Context.Service<
  SessionRepo,
  {
    readonly create: (session: Session) => Effect.Effect<void, DatabaseError>;
    /** None for unknown and for expired sessions, even before TTL has deleted them. */
    readonly find: (id: string) => Effect.Effect<Option.Option<Session>, DatabaseError>;
    /** Idempotent: deleting a missing session succeeds. */
    readonly delete: (id: string) => Effect.Effect<void, DatabaseError>;
    /** The user's live sessions, oldest first (gsi1, so a just-created one may lag a moment). */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<Session>, DatabaseError>;
    /** Deletes the session if it is the user's; fails with `NoSuchSession` otherwise. */
    readonly deleteOwned: (
      userId: string,
      id: string,
    ) => Effect.Effect<void, NoSuchSession | DatabaseError>;
  }
>()("@alias/db/SessionRepo") {}

export const sessionKey = (id: string) => ({ pk: { S: `SESSION#${id}` }, sk: { S: "SESSION" } });

/** The gsi1 partition listing a user's sessions, so erasing the account finds them. */
export const userSessionsKey = (userId: string) => `SESSIONS#${userId}`;

const SessionItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    userId: Attribute.S,
    username: Attribute.S,
    createdAt: Attribute.EpochMillis,
    expiresAt: Attribute.EpochSeconds,
  }),
  "Session",
);

const make = Effect.fn("SessionRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

  return SessionRepo.of({
    create: (session) =>
      SessionItem.encode(session).pipe(
        Effect.flatMap((item) =>
          DynamoDB.putItem({
            TableName: table.name,
            Item: {
              ...sessionKey(session.id),
              gsi1pk: { S: userSessionsKey(session.userId) },
              gsi1sk: { S: `SESSION#${session.id}` },
              ...item,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }).pipe(Effect.mapError(databaseError("PutItem"))),
        ),
        Effect.asVoid,
        Effect.provide(client),
      ),

    find: Effect.fn("SessionRepo.find")(function* (id) {
      const result = yield* DynamoDB.getItem({
        TableName: table.name,
        Key: sessionKey(id),
        ConsistentRead: true,
      }).pipe(Effect.mapError(databaseError("GetItem")), Effect.provide(client));
      const session = yield* SessionItem.decodeOption(Option.fromUndefinedOr(result.Item));
      const now = yield* DateTime.now;
      return Option.filter(session, (found) => DateTime.isGreaterThan(found.expiresAt, now));
    }),

    delete: (id) =>
      DynamoDB.deleteItem({ TableName: table.name, Key: sessionKey(id) }).pipe(
        Effect.asVoid,
        Effect.mapError(databaseError("DeleteItem")),
        Effect.provide(client),
      ),

    list: Effect.fn("SessionRepo.list")(function* (userId) {
      const items = yield* DynamoDB.query
        .items({
          TableName: table.name,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :user",
          ExpressionAttributeValues: { ":user": { S: userSessionsKey(userId) } },
        })
        .pipe(
          Stream.mapError(databaseError("Query")),
          Stream.mapEffect(SessionItem.decode),
          Stream.runCollect,
          Effect.provide(client),
        );
      const now = yield* DateTime.now;
      return Arr.sort(
        Arr.filter(items, (session) => DateTime.isGreaterThan(session.expiresAt, now)),
        Order.mapInput(DateTime.Order, (session: Session) => session.createdAt),
      );
    }),

    deleteOwned: (userId, id) =>
      DynamoDB.deleteItem({
        TableName: table.name,
        Key: sessionKey(id),
        ConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": { S: userId } },
      }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          P.isTagged(error, "ConditionalCheckFailedException")
            ? new NoSuchSession({ sessionId: id })
            : databaseError("DeleteItem")(error),
        ),
        Effect.provide(client),
      ),
  });
});

export const layer = Layer.effect(SessionRepo, make());
