import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import * as Quota from "./Quota.ts";

/** A personal API token (PLAN.md §20.20). The secret itself is never stored. */
export interface Token {
  /** `tok_<ulid>`: names the token in the API; sorts by creation. */
  readonly id: string;
  /** SHA-256 of the secret, the key a bearer request is looked up by. */
  readonly hash: string;
  readonly userId: string;
  /** Copied from the user (usernames never change), so authenticating takes one read. */
  readonly username: string;
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
  /** The secret's last four characters. */
  readonly hint: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: Option.Option<DateTime.Utc>;
  readonly lastUsedAt: Option.Option<DateTime.Utc>;
}

export type NewToken = Omit<Token, "lastUsedAt">;

export class NoSuchToken extends Schema.TaggedError<NoSuchToken>()("NoSuchToken", {
  tokenId: Schema.String,
}) {}

export class TokenRepo extends Context.Service<
  TokenRepo,
  {
    readonly create: (token: NewToken) => Effect.Effect<void, DatabaseError>;
    /** The live token with this hash: None for unknown, revoked and expired ones. */
    readonly findByHash: (hash: string) => Effect.Effect<Option.Option<Token>, DatabaseError>;
    /** The user's tokens, oldest first, expired ones included until TTL removes them. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<Token>, DatabaseError>;
    readonly revoke: (
      userId: string,
      tokenId: string,
    ) => Effect.Effect<void, NoSuchToken | DatabaseError>;
    /**
     * Records a use at `now`, unless one was recorded less than `every` before: at most one write
     * per token and interval, whatever the request rate.
     */
    readonly touch: (
      token: Token,
      now: DateTime.Utc,
      every: Duration.Duration,
    ) => Effect.Effect<void, DatabaseError>;
    /** Failed token attempts from `source` (a hashed client address) in the current hour. */
    readonly failures: (source: string, now: DateTime.Utc) => Effect.Effect<number, DatabaseError>;
    /** Counts one failed attempt from `source`, up to `max` an hour. */
    readonly recordFailure: (
      source: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<void, DatabaseError>;
  }
>()("@alias/db/TokenRepo") {}

const tokenKey = (hash: string) => ({ pk: { S: `TOKEN#${hash}` }, sk: { S: "TOKEN" } });
/** The gsi1 partition listing a user's tokens. */
export const userTokensKey = (userId: string) => `TOKENS#${userId}`;
const userTokens = (userId: string) => ({ S: userTokensKey(userId) });
const failureKey = (source: string, hour: string) => ({
  pk: { S: `AUTHFAIL#${source}` },
  sk: { S: `FAILURES#${hour}` },
});

const TokenItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    hash: Attribute.S,
    userId: Attribute.S,
    username: Attribute.S,
    name: Attribute.S,
    scopes: Attribute.StringList,
    hint: Attribute.S,
    createdAt: Attribute.EpochMillis,
    expiresAt: Schema.OptionFromOptionalKey(Attribute.EpochSeconds),
    lastUsedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
  }),
  "Token",
);

const CountItem = Item.codec(Schema.Struct({ count: Attribute.N }), "AuthFailures");

const isLive = (now: DateTime.Utc) => (token: Token) =>
  Option.match(token.expiresAt, {
    onNone: () => true,
    onSome: (expiresAt) => DateTime.isGreaterThan(expiresAt, now),
  });

const make = Effect.fn("TokenRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const list = (userId: string) =>
    DynamoDB.query
      .items({
        TableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :user",
        ExpressionAttributeValues: { ":user": userTokens(userId) },
      })
      .pipe(
        Stream.mapError(databaseError("Query")),
        Stream.mapEffect(TokenItem.decode),
        Stream.runCollect,
        Effect.provide(client),
      );

  return TokenRepo.of({
    create: Effect.fn("TokenRepo.create")(function* (token) {
      const attributes = yield* TokenItem.encode({ ...token, lastUsedAt: Option.none() });
      yield* DynamoDB.putItem({
        TableName,
        Item: {
          ...tokenKey(token.hash),
          gsi1pk: userTokens(token.userId),
          gsi1sk: { S: `TOKEN#${token.id}` },
          ...attributes,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }).pipe(Effect.mapError(databaseError("PutItem")), Effect.provide(client));
    }),

    findByHash: Effect.fn("TokenRepo.findByHash")(function* (hash) {
      const result = yield* DynamoDB.getItem({
        TableName,
        Key: tokenKey(hash),
        ConsistentRead: true,
      }).pipe(Effect.mapError(databaseError("GetItem")), Effect.provide(client));
      const token = yield* TokenItem.decodeOption(Option.fromUndefinedOr(result.Item));
      return Option.filter(token, isLive(yield* DateTime.now));
    }),

    list,

    // The index is eventually consistent; a token created a moment ago may not be found yet.
    revoke: Effect.fn("TokenRepo.revoke")(function* (userId, tokenId) {
      const found = Arr.findFirst(yield* list(userId), (token) => token.id === tokenId);
      if (Option.isNone(found)) return yield* new NoSuchToken({ tokenId });
      yield* DynamoDB.deleteItem({ TableName, Key: tokenKey(found.value.hash) }).pipe(
        Effect.mapError(databaseError("DeleteItem")),
        Effect.provide(client),
      );
    }),

    touch: Effect.fn("TokenRepo.touch")(function* (token, now, every) {
      const recent = DateTime.subtractDuration(now, every);
      if (Option.exists(token.lastUsedAt, (at) => DateTime.isGreaterThan(at, recent))) return;
      yield* DynamoDB.updateItem({
        TableName,
        Key: tokenKey(token.hash),
        UpdateExpression: "SET lastUsedAt = :now",
        // Another request may have recorded a use meanwhile; and a revoked token stays gone.
        ConditionExpression:
          "attribute_exists(pk) AND (attribute_not_exists(lastUsedAt) OR lastUsedAt < :recent)",
        ExpressionAttributeValues: {
          ":now": { N: String(DateTime.toEpochMillis(now)) },
          ":recent": { N: String(DateTime.toEpochMillis(recent)) },
        },
      }).pipe(
        Effect.asVoid,
        Effect.catchIf(
          (error) => P.isTagged(error, "ConditionalCheckFailedException"),
          () => Effect.void,
        ),
        Effect.mapError(databaseError("UpdateItem")),
        Effect.provide(client),
      );
    }),

    failures: Effect.fn("TokenRepo.failures")(function* (source, now) {
      const result = yield* DynamoDB.getItem({
        TableName,
        Key: failureKey(source, Quota.window(now, "hour").label),
      }).pipe(Effect.mapError(databaseError("GetItem")), Effect.provide(client));
      const counter = yield* CountItem.decodeOption(Option.fromUndefinedOr(result.Item));
      return Option.match(counter, { onNone: () => 0, onSome: ({ count }) => count });
    }),

    recordFailure: (source, now, max) => {
      const hour = Quota.window(now, "hour");
      return Quota.reserve(table, failureKey(source, hour.label), hour, max).pipe(
        Effect.asVoid,
        Effect.provide(client),
      );
    },
  });
});

export const layer = Layer.effect(TokenRepo, make());
