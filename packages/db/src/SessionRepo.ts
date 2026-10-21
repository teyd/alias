import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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

export class SessionRepo extends Context.Service<
  SessionRepo,
  {
    readonly create: (session: Session) => Effect.Effect<void, DatabaseError>;
    /** None for unknown and for expired sessions, even before TTL has deleted them. */
    readonly find: (id: string) => Effect.Effect<Option.Option<Session>, DatabaseError>;
    /** Idempotent: deleting a missing session succeeds. */
    readonly delete: (id: string) => Effect.Effect<void, DatabaseError>;
  }
>()("@alias/db/SessionRepo") {}

const sessionKey = (id: string) => ({ pk: { S: `SESSION#${id}` }, sk: { S: "SESSION" } });

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
            Item: { ...sessionKey(session.id), ...item },
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
  });
});

export const layer = Layer.effect(SessionRepo, make());
