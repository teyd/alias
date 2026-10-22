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
import * as Stream from "effect/Stream";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";

/** A user's webhook endpoint (PLAN.md §20.20). */
export interface Webhook {
  /** `wh_<ulid>`, so the list sorts by creation. */
  readonly id: string;
  readonly userId: string;
  readonly url: string;
  readonly eventTypes: ReadonlyArray<string>;
  /** The `whsec_` signing secret. Stored as is: signing needs it. */
  readonly secret: string;
  /** The secret before the last rotation, which still signs until `previousSecretUntil`. */
  readonly previousSecret: Option.Option<string>;
  readonly previousSecretUntil: Option.Option<DateTime.Utc>;
  readonly isEnabled: boolean;
  readonly createdAt: DateTime.Utc;
}

export type NewWebhook = Omit<Webhook, "previousSecret" | "previousSecretUntil" | "isEnabled">;

export interface WebhookChanges {
  readonly eventTypes?: ReadonlyArray<string>;
  readonly isEnabled?: boolean;
}

export class NoSuchWebhook extends Schema.TaggedError<NoSuchWebhook>()("NoSuchWebhook", {
  webhookId: Schema.String,
}) {}

export class WebhookRepo extends Context.Service<
  WebhookRepo,
  {
    readonly create: (webhook: NewWebhook) => Effect.Effect<void, DatabaseError>;
    /** Oldest first. One strongly consistent Query, also what every published event costs. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<Webhook>, DatabaseError>;
    readonly find: (
      userId: string,
      webhookId: string,
    ) => Effect.Effect<Option.Option<Webhook>, DatabaseError>;
    /** Applies the given changes and returns the webhook as stored afterwards. */
    readonly update: (
      userId: string,
      webhookId: string,
      changes: WebhookChanges,
    ) => Effect.Effect<Webhook, NoSuchWebhook | DatabaseError>;
    /** Makes `secret` the signing secret; the old one keeps signing until `previousUntil`. */
    readonly rotateSecret: (
      userId: string,
      webhookId: string,
      secret: string,
      previousUntil: DateTime.Utc,
    ) => Effect.Effect<Webhook, NoSuchWebhook | DatabaseError>;
    readonly delete: (
      userId: string,
      webhookId: string,
    ) => Effect.Effect<void, NoSuchWebhook | DatabaseError>;
  }
>()("@alias/db/WebhookRepo") {}

const partition = (userId: string) => ({ S: `USER#${userId}` });
const webhookKey = (userId: string, webhookId: string) => ({
  pk: partition(userId),
  sk: { S: `WEBHOOK#${webhookId}` },
});

const WebhookItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    userId: Attribute.S,
    url: Attribute.S,
    eventTypes: Attribute.StringList,
    secret: Attribute.S,
    previousSecret: Schema.OptionFromOptionalKey(Attribute.S),
    previousSecretUntil: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
    isEnabled: Attribute.BOOL,
    createdAt: Attribute.EpochMillis,
  }),
  "Webhook",
);

const make = Effect.fn("WebhookRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const missing =
    (operation: string, webhookId: string) =>
    <E>(error: E) =>
      P.isTagged(error, "ConditionalCheckFailedException")
        ? new NoSuchWebhook({ webhookId })
        : databaseError(operation)(error);

  /** One conditional UpdateItem on an existing webhook; returns it as stored afterwards. */
  const updateItem = (
    userId: string,
    webhookId: string,
    update: string,
    values: Readonly<Record<string, DynamoDB.AttributeValue>>,
  ) =>
    DynamoDB.updateItem({
      TableName,
      Key: webhookKey(userId, webhookId),
      UpdateExpression: update,
      ConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": { S: userId }, ...values },
      ReturnValues: "ALL_NEW",
    }).pipe(
      Effect.mapError(missing("UpdateItem", webhookId)),
      Effect.flatMap((result) => WebhookItem.decode({ ...result.Attributes })),
      Effect.provide(client),
    );

  return WebhookRepo.of({
    create: Effect.fn("WebhookRepo.create")(function* (webhook) {
      const attributes = yield* WebhookItem.encode({
        ...webhook,
        previousSecret: Option.none(),
        previousSecretUntil: Option.none(),
        isEnabled: true,
      });
      yield* DynamoDB.putItem({
        TableName,
        Item: { ...webhookKey(webhook.userId, webhook.id), ...attributes },
        ConditionExpression: "attribute_not_exists(pk)",
      }).pipe(Effect.mapError(databaseError("PutItem")), Effect.provide(client));
    }),

    list: (userId) =>
      DynamoDB.query
        .items({
          TableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": partition(userId), ":prefix": { S: "WEBHOOK#" } },
          ConsistentRead: true,
        })
        .pipe(
          Stream.mapError(databaseError("Query")),
          Stream.mapEffect(WebhookItem.decode),
          Stream.runCollect,
          Effect.provide(client),
        ),

    find: (userId, webhookId) =>
      DynamoDB.getItem({
        TableName,
        Key: webhookKey(userId, webhookId),
        ConsistentRead: true,
      }).pipe(
        Effect.mapError(databaseError("GetItem")),
        Effect.flatMap((result) => WebhookItem.decodeOption(Option.fromUndefinedOr(result.Item))),
        Effect.provide(client),
      ),

    update: (userId, webhookId, changes) => {
      const values = R.getSomes<string, DynamoDB.AttributeValue>({
        eventTypes: Option.map(Option.fromUndefinedOr(changes.eventTypes), (types) => ({
          L: Arr.map(types, (type) => ({ S: type })),
        })),
        isEnabled: Option.map(Option.fromUndefinedOr(changes.isEnabled), (isEnabled) => ({
          BOOL: isEnabled,
        })),
      });
      // With nothing to change, a no-op SET still checks the webhook exists and returns it.
      const update = Arr.match(R.keys(values), {
        onEmpty: () => "SET userId = userId",
        onNonEmpty: (names) =>
          `SET ${Arr.join(
            Arr.map(names, (name) => `${name} = :${name}`),
            ", ",
          )}`,
      });
      return updateItem(
        userId,
        webhookId,
        update,
        R.mapKeys(values, (name) => `:${name}`),
      );
    },

    // Right-hand operands read the item as it was, so the old secret moves over atomically.
    rotateSecret: (userId, webhookId, secret, previousUntil) =>
      Effect.flatMap(
        Schema.encodeEffect(Attribute.EpochMillis)(previousUntil).pipe(
          Effect.mapError(databaseError("EncodeWebhook")),
        ),
        (until) =>
          updateItem(
            userId,
            webhookId,
            "SET previousSecret = secret, secret = :secret, previousSecretUntil = :until",
            { ":secret": { S: secret }, ":until": until },
          ),
      ),

    delete: (userId, webhookId) =>
      DynamoDB.deleteItem({
        TableName,
        Key: webhookKey(userId, webhookId),
        ConditionExpression: "attribute_exists(pk)",
      }).pipe(
        Effect.asVoid,
        Effect.mapError(missing("DeleteItem", webhookId)),
        Effect.provide(client),
      ),
  });
});

export const layer = Layer.effect(WebhookRepo, make());
