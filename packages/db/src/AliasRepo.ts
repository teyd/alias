import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
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
});

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
  });
});

export const layer = Layer.effect(AliasRepo, make());
