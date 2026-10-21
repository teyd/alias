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
}

/** The credential is gone, e.g. deleted between the lookup and the update. */
export class PasskeyNotFound extends Schema.TaggedError<PasskeyNotFound>()("PasskeyNotFound", {
  credentialId: Schema.String,
}) {}

export class PasskeyRepo extends Context.Service<
  PasskeyRepo,
  {
    readonly findById: (
      credentialId: string,
    ) => Effect.Effect<Option.Option<Passkey>, DatabaseError>;
    /** Stores the counter the last successful assertion reported. */
    readonly recordUse: (
      credentialId: string,
      counter: number,
    ) => Effect.Effect<void, PasskeyNotFound | DatabaseError>;
  }
>()("@alias/db/PasskeyRepo") {}

const passkeyKey = (credentialId: string) => ({
  pk: { S: `PASSKEY#${credentialId}` },
  sk: { S: "PASSKEY" },
});

const PasskeyItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    userId: Attribute.S,
    publicKey: Attribute.B,
    counter: Attribute.N,
    transports: Attribute.StringList,
    createdAt: Attribute.EpochMillis,
  }),
  "Passkey",
);

/** The full item, keys included. `UserRepo.register` writes it inside its transaction. */
export const passkeyItem = (passkey: Passkey) =>
  Effect.map(PasskeyItem.encode(passkey), (attributes) => ({
    ...passkeyKey(passkey.id),
    ...attributes,
  }));

const make = Effect.fn("PasskeyRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

  return PasskeyRepo.of({
    findById: (credentialId) =>
      DynamoDB.getItem({
        TableName: table.name,
        Key: passkeyKey(credentialId),
        ConsistentRead: true,
      }).pipe(
        Effect.mapError(databaseError("GetItem")),
        Effect.flatMap((result) => PasskeyItem.decodeOption(Option.fromUndefinedOr(result.Item))),
        Effect.provide(client),
      ),

    recordUse: (credentialId, counter) =>
      DynamoDB.updateItem({
        TableName: table.name,
        Key: passkeyKey(credentialId),
        UpdateExpression: "SET #counter = :counter",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#counter": "counter" },
        ExpressionAttributeValues: { ":counter": { N: String(counter) } },
      }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          P.isTagged(error, "ConditionalCheckFailedException")
            ? new PasskeyNotFound({ credentialId })
            : databaseError("UpdateItem")(error),
        ),
        Effect.provide(client),
      ),
  });
});

export const layer = Layer.effect(PasskeyRepo, make());
