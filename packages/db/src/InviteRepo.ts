import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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

/**
 * An invite code for sign-up during the private beta (PLAN.md §20.36), minted by the operator.
 * The code itself is never stored, and nothing records who redeemed it: only how often.
 */
export interface Invite {
  /** SHA-256 of the normalized code, the key a sign-up looks it up by. */
  readonly hash: string;
  /** The operator's own note (a batch, a channel), shown when listing codes. */
  readonly note: Option.Option<string>;
  /** Sign-ups the code allows; 1 for a personal invite. */
  readonly maxUses: number;
  readonly uses: number;
  readonly createdAt: DateTime.Utc;
  /** Readers ignore the code from then on; TTL deletes it later. */
  readonly expiresAt: DateTime.Utc;
}

/** The invite is unknown, revoked, expired or used up by the time the account is created. */
export class InviteNotRedeemable extends Schema.TaggedError<InviteNotRedeemable>()(
  "InviteNotRedeemable",
  {},
) {}

export class InviteRepo extends Context.Service<
  InviteRepo,
  {
    readonly create: (invite: Omit<Invite, "uses">) => Effect.Effect<void, DatabaseError>;
    /** The invite with this hash if it can still be redeemed at `now`. */
    readonly findRedeemable: (
      hash: string,
      now: DateTime.Utc,
    ) => Effect.Effect<Option.Option<Invite>, DatabaseError>;
    /** Every invite, oldest first, expired and used-up ones included until TTL removes them. */
    readonly list: () => Effect.Effect<ReadonlyArray<Invite>, DatabaseError>;
    /** Deletes the invite; false when there was none. */
    readonly revoke: (hash: string) => Effect.Effect<boolean, DatabaseError>;
  }
>()("@alias/db/InviteRepo") {}

const inviteKey = (hash: string) => ({ pk: { S: `INVITE#${hash}` }, sk: { S: "INVITE" } });
/** The gsi1 partition listing every invite for the operator. */
const INVITES = { S: "INVITES" };

const InviteItem = Item.codec(
  Schema.Struct({
    hash: Attribute.S,
    note: Schema.OptionFromOptionalKey(Attribute.S),
    maxUses: Attribute.N,
    uses: Attribute.N,
    createdAt: Attribute.EpochMillis,
    expiresAt: Attribute.EpochSeconds,
  }),
  "Invite",
);

const isRedeemable = (now: DateTime.Utc) => (invite: Invite) =>
  invite.uses < invite.maxUses && DateTime.isGreaterThan(invite.expiresAt, now);

/**
 * The conditional update that redeems an invite once, inside the transaction that creates the
 * user (`UserRepo.register`): it fails the whole transaction when the invite is gone, expired
 * (TTL deletes late) or used up, so two sign-ups racing for the last use can't both get it.
 */
export const redemption = Effect.fn("InviteRepo.redemption")(function* (
  TableName: string,
  hash: string,
  now: DateTime.Utc,
) {
  const nowSeconds = yield* Schema.encodeEffect(Attribute.EpochSeconds)(now).pipe(
    Effect.mapError(databaseError("EncodeInvite")),
  );
  return {
    TableName,
    Key: inviteKey(hash),
    UpdateExpression: "SET #uses = #uses + :one",
    ConditionExpression: "attribute_exists(pk) AND #uses < #maxUses AND expiresAt > :now",
    ExpressionAttributeNames: { "#uses": "uses", "#maxUses": "maxUses" },
    ExpressionAttributeValues: { ":one": { N: "1" }, ":now": nowSeconds },
  };
});

const make = Effect.fn("InviteRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  return InviteRepo.of({
    create: Effect.fn("InviteRepo.create")(function* (invite) {
      const attributes = yield* InviteItem.encode({ ...invite, uses: 0 });
      yield* DynamoDB.putItem({
        TableName,
        Item: {
          ...inviteKey(invite.hash),
          gsi1pk: INVITES,
          gsi1sk: { S: `${DateTime.formatIso(invite.createdAt)}#${invite.hash}` },
          ...attributes,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }).pipe(Effect.mapError(databaseError("PutItem")), Effect.provide(client));
    }),

    findRedeemable: Effect.fn("InviteRepo.findRedeemable")(function* (hash, now) {
      const result = yield* DynamoDB.getItem({
        TableName,
        Key: inviteKey(hash),
        ConsistentRead: true,
      }).pipe(Effect.mapError(databaseError("GetItem")), Effect.provide(client));
      const invite = yield* InviteItem.decodeOption(Option.fromUndefinedOr(result.Item));
      return Option.filter(invite, isRedeemable(now));
    }),

    list: () =>
      DynamoDB.query
        .items({
          TableName,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :invites",
          ExpressionAttributeValues: { ":invites": INVITES },
        })
        .pipe(
          Stream.mapError(databaseError("Query")),
          Stream.mapEffect(InviteItem.decode),
          Stream.runCollect,
          Effect.provide(client),
        ),

    revoke: (hash) =>
      DynamoDB.deleteItem({ TableName, Key: inviteKey(hash), ReturnValues: "ALL_OLD" }).pipe(
        Effect.map((result) => P.isNotUndefined(result.Attributes)),
        Effect.mapError(databaseError("DeleteItem")),
        Effect.provide(client),
      ),
  });
});

export const layer = Layer.effect(InviteRepo, make());
