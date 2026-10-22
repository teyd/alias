import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";

/** A WebAuthn credential (passkey) as the relying party stores it. */
export interface Passkey {
  /** The credential ID, base64url, as the authenticator reports it. */
  readonly id: string;
  readonly userId: string;
  /** COSE-encoded public key. */
  readonly publicKey: Uint8Array;
  /** Signature counter; 0 for authenticators that don't count (most passkeys). */
  readonly counter: number;
  readonly transports: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
  /** The last successful assertion; none before the first. */
  readonly lastUsedAt: Option.Option<DateTime.Utc>;
}

/** The credential is gone, e.g. deleted between the lookup and the update. */
export class PasskeyNotFound extends Schema.TaggedError<PasskeyNotFound>()("PasskeyNotFound", {
  credentialId: Schema.String,
}) {}

/**
 * The assertion's counter isn't above the stored one, though the authenticator counts: another
 * assertion got there first with a higher one, or the credential was cloned (WebAuthn §6.1.1).
 */
export class CounterNotIncreased extends Schema.TaggedError<CounterNotIncreased>()(
  "CounterNotIncreased",
  { credentialId: Schema.String },
) {}

export class PasskeyRepo extends Context.Service<
  PasskeyRepo,
  {
    readonly findById: (
      credentialId: string,
    ) => Effect.Effect<Option.Option<Passkey>, DatabaseError>;
    /**
     * Stores the counter the last successful assertion reported, and when. A counting
     * authenticator's counter only moves up: a write that wouldn't raise it fails with
     * `CounterNotIncreased`, so two racing assertions can't both pass (SR-26). A counter of 0
     * (most passkeys don't count) always passes.
     */
    readonly recordUse: (
      credentialId: string,
      counter: number,
      usedAt: DateTime.Utc,
    ) => Effect.Effect<void, PasskeyNotFound | CounterNotIncreased | DatabaseError>;
    /** The user's passkeys, oldest first. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<Passkey>, DatabaseError>;
  }
>()("@alias/db/PasskeyRepo") {}

const passkeyKey = (credentialId: string) => ({
  pk: { S: `PASSKEY#${credentialId}` },
  sk: { S: "PASSKEY" },
});

/** The gsi1 partition listing a user's passkeys, so erasing the account finds them. */
export const userPasskeysKey = (userId: string) => `PASSKEYS#${userId}`;

const PasskeyItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    userId: Attribute.S,
    publicKey: Attribute.B,
    counter: Attribute.N,
    transports: Attribute.StringList,
    createdAt: Attribute.EpochMillis,
    lastUsedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
  }),
  "Passkey",
);

/** The full item, keys included. `UserRepo.register` writes it inside its transaction. */
export const passkeyItem = (passkey: Passkey) =>
  Effect.map(PasskeyItem.encode(passkey), (attributes) => ({
    ...passkeyKey(passkey.id),
    gsi1pk: { S: userPasskeysKey(passkey.userId) },
    gsi1sk: { S: `PASSKEY#${passkey.id}` },
    ...attributes,
  }));

const make = Effect.fn("PasskeyRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

  const findById = (credentialId: string) =>
    DynamoDB.getItem({
      TableName: table.name,
      Key: passkeyKey(credentialId),
      ConsistentRead: true,
    }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.flatMap((result) => PasskeyItem.decodeOption(Option.fromUndefinedOr(result.Item))),
      Effect.provide(client),
    );

  return PasskeyRepo.of({
    findById,

    recordUse: Effect.fn("PasskeyRepo.recordUse")(function* (credentialId, counter, usedAt) {
      const at = yield* Schema.encodeEffect(Attribute.EpochMillis)(usedAt).pipe(
        Effect.mapError(databaseError("EncodePasskey")),
      );
      const outcome = yield* DynamoDB.updateItem({
        TableName: table.name,
        Key: passkeyKey(credentialId),
        UpdateExpression: "SET #counter = :counter, lastUsedAt = :at",
        ConditionExpression: "attribute_exists(pk) AND (:counter = :zero OR #counter < :counter)",
        ExpressionAttributeNames: { "#counter": "counter" },
        ExpressionAttributeValues: {
          ":counter": { N: String(counter) },
          ":zero": { N: "0" },
          ":at": at,
        },
      }).pipe(
        Effect.as("recorded" as const),
        Effect.catchIf(
          (error) => P.isTagged(error, "ConditionalCheckFailedException"),
          () => Effect.succeed("refused" as const),
        ),
        Effect.mapError(databaseError("UpdateItem")),
        Effect.provide(client),
      );
      if (outcome === "recorded") return;
      // Refused: gone, or the counter didn't go up. One read tells which.
      const stored = yield* findById(credentialId);
      return yield* Option.isNone(stored)
        ? new PasskeyNotFound({ credentialId })
        : new CounterNotIncreased({ credentialId });
    }),

    list: (userId) =>
      DynamoDB.query
        .items({
          TableName: table.name,
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :user",
          ExpressionAttributeValues: { ":user": { S: userPasskeysKey(userId) } },
        })
        .pipe(
          Stream.mapError(databaseError("Query")),
          Stream.mapEffect(PasskeyItem.decode),
          Stream.runCollect,
          Effect.map(
            Arr.sort(Order.mapInput(DateTime.Order, (passkey: Passkey) => passkey.createdAt)),
          ),
          Effect.provide(client),
        ),
  });
});

export const layer = Layer.effect(PasskeyRepo, make());
