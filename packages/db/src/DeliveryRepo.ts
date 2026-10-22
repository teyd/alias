import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";

/**
 * One inbound message for one of its recipients: the unit the inbound Lambda acts on at most
 * once. Lambda invokes SES receipt actions at least once, so a redelivered event finds the claim
 * and sends nothing again.
 */
export interface Delivery {
  /** The SES message ID (`mail.messageId`), unique per received message. */
  readonly messageId: string;
  /** The SES recipient, as listed in `receipt.recipients`. */
  readonly recipient: string;
}

export class DeliveryRepo extends Context.Service<
  DeliveryRepo,
  {
    /**
     * Records that this delivery is being handled. False when a live claim already exists, i.e.
     * an earlier or concurrent invocation owns it. Expired claims count as absent (TTL deletes
     * late).
     */
    readonly claim: (
      delivery: Delivery,
      expiresAt: DateTime.Utc,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Gives a claim up, so a retry may handle the delivery again. Idempotent. */
    readonly release: (delivery: Delivery) => Effect.Effect<void, DatabaseError>;
  }
>()("@alias/db/DeliveryRepo") {}

/** Recipients are matched case-insensitively, like alias addresses. */
const deliveryKey = (delivery: Delivery) => ({
  pk: { S: `DELIVERY#${delivery.messageId}` },
  sk: { S: `RECIPIENT#${delivery.recipient.toLowerCase()}` },
});

const encodeSeconds = (dateTime: DateTime.Utc) =>
  Schema.encodeEffect(Attribute.EpochSeconds)(dateTime).pipe(
    Effect.mapError(databaseError("EncodeDelivery")),
  );

const make = Effect.fn("DeliveryRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

  return DeliveryRepo.of({
    claim: Effect.fn("DeliveryRepo.claim")(function* (delivery, expiresAt) {
      const expires = yield* encodeSeconds(expiresAt);
      const now = yield* encodeSeconds(yield* DateTime.now);
      return yield* DynamoDB.putItem({
        TableName: table.name,
        Item: { ...deliveryKey(delivery), expiresAt: expires },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
        ExpressionAttributeValues: { ":now": now },
      }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => P.isTagged(error, "ConditionalCheckFailedException"),
          () => Effect.succeed(false),
        ),
        Effect.mapError(databaseError("PutItem")),
        Effect.provide(client),
      );
    }),

    release: (delivery) =>
      DynamoDB.deleteItem({ TableName: table.name, Key: deliveryKey(delivery) }).pipe(
        Effect.asVoid,
        Effect.mapError(databaseError("DeleteItem")),
        Effect.provide(client),
      ),
  });
});

export const layer = Layer.effect(DeliveryRepo, make());
