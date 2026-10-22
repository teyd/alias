import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import * as Quota from "./Quota.ts";

/**
 * Mail an MCP client drafted for its user (PLAN.md §20.24), waiting for the user to send or
 * discard it in the web app. Each draft goes out at most once: leaving `pending` is one
 * conditional update.
 */

type DraftStatus = "pending" | "sent" | "discarded";

export interface Draft {
  readonly id: string;
  readonly userId: string;
  readonly aliasId: string;
  readonly aliasDomain: string;
  readonly aliasLocal: string;
  readonly contactId: string;
  /** The contact's address when the draft was made; the send goes to the contact's current one. */
  readonly to: string;
  readonly contactName: Option.Option<string>;
  readonly subject: string;
  readonly text: string;
  /** The connected app that drafted it, as the user approved it. */
  readonly clientName: string;
  readonly status: DraftStatus;
  readonly createdAt: DateTime.Utc;
  /** A pending draft can't be sent after this. */
  readonly pendingUntil: DateTime.Utc;
  /** TTL: the draft, whatever its status, is deleted after this. */
  readonly expiresAt: DateTime.Utc;
}

export type NewDraft = Omit<Draft, "status">;

/** The draft isn't pending any more (sent, discarded or lapsed), or isn't there. */
export class DraftNotPending extends Schema.TaggedError<DraftNotPending>()("DraftNotPending", {
  draftId: Schema.String,
}) {}

export class OutboxRepo extends Context.Service<
  OutboxRepo,
  {
    readonly create: (draft: NewDraft) => Effect.Effect<void, DatabaseError>;
    /** The user's draft; None for someone else's, an unknown one and one past its TTL. */
    readonly find: (
      userId: string,
      draftId: string,
    ) => Effect.Effect<Option.Option<Draft>, DatabaseError>;
    /**
     * Moves a pending draft, still within `pendingUntil`, to `status`, and returns it. Fails for
     * any other, so of two concurrent sends only one goes on.
     */
    readonly close: (
      userId: string,
      draftId: string,
      status: "sent" | "discarded",
      now: DateTime.Utc,
    ) => Effect.Effect<Draft, DraftNotPending | DatabaseError>;
    /** Back to `pending` after a send that SES didn't take, so the user can try again. */
    readonly reopen: (userId: string, draftId: string) => Effect.Effect<void, DatabaseError>;
    /** Counts one send by `userId` in the UTC day of `now`, up to `max`. False when used up. */
    readonly reserveSend: (
      userId: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("@alias/db/OutboxRepo") {}

const draftKey = (userId: string, draftId: string) => ({
  pk: { S: `USER#${userId}` },
  sk: { S: `DRAFT#${draftId}` },
});
const sendsKey = (userId: string, date: string) => ({
  pk: { S: `USER#${userId}` },
  sk: { S: `SENDS#${date}` },
});

const DraftItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    userId: Attribute.S,
    aliasId: Attribute.S,
    aliasDomain: Attribute.S,
    aliasLocal: Attribute.S,
    contactId: Attribute.S,
    to: Attribute.S,
    contactName: Schema.OptionFromOptionalKey(Attribute.S),
    subject: Attribute.S,
    text: Attribute.S,
    clientName: Attribute.S,
    status: Attribute.S.pipe(Schema.decodeTo(Schema.Literals(["pending", "sent", "discarded"]))),
    createdAt: Attribute.EpochMillis,
    pendingUntil: Attribute.EpochMillis,
    expiresAt: Attribute.EpochSeconds,
  }),
  "Draft",
);

const make = Effect.fn("OutboxRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const find = Effect.fn("OutboxRepo.find")(function* (userId: string, draftId: string) {
    const result = yield* DynamoDB.getItem({
      TableName,
      Key: draftKey(userId, draftId),
      ConsistentRead: true,
    }).pipe(Effect.mapError(databaseError("GetItem")));
    const draft = yield* DraftItem.decodeOption(Option.fromUndefinedOr(result.Item));
    const now = yield* DateTime.now;
    return Option.filter(draft, (found) => DateTime.isGreaterThan(found.expiresAt, now));
  });

  const setStatus = (
    userId: string,
    draftId: string,
    status: DraftStatus,
    condition: string,
    values: Readonly<Record<string, DynamoDB.AttributeValue>>,
  ) =>
    DynamoDB.updateItem({
      TableName,
      Key: draftKey(userId, draftId),
      UpdateExpression: "SET #status = :status",
      ConditionExpression: condition,
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": { S: status }, ...values },
      ReturnValues: "ALL_NEW",
    });

  return OutboxRepo.of({
    create: Effect.fn("OutboxRepo.create")(function* (draft) {
      const attributes = yield* DraftItem.encode({ ...draft, status: "pending" });
      yield* DynamoDB.putItem({
        TableName,
        Item: { ...draftKey(draft.userId, draft.id), ...attributes },
        ConditionExpression: "attribute_not_exists(pk)",
      }).pipe(Effect.mapError(databaseError("PutItem")));
    }, Effect.provide(client)),

    find: (userId, draftId) => Effect.provide(find(userId, draftId), client),

    close: Effect.fn("OutboxRepo.close")(function* (userId, draftId, status, now) {
      const updated = yield* setStatus(
        userId,
        draftId,
        status,
        "#status = :pending AND pendingUntil > :now",
        {
          ":pending": { S: "pending" },
          ":now": { N: String(DateTime.toEpochMillis(now)) },
        },
      ).pipe(
        Effect.map((result) => Option.fromUndefinedOr(result.Attributes)),
        Effect.catchIf(
          (error) => P.isTagged(error, "ConditionalCheckFailedException"),
          () => Effect.succeedNone,
        ),
        Effect.mapError(databaseError("UpdateItem")),
      );
      if (Option.isNone(updated)) return yield* new DraftNotPending({ draftId });
      return yield* DraftItem.decode(updated.value);
    }, Effect.provide(client)),

    reopen: (userId, draftId) =>
      setStatus(userId, draftId, "pending", "#status = :sent", { ":sent": { S: "sent" } }).pipe(
        Effect.asVoid,
        Effect.catchIf(
          (error) => P.isTagged(error, "ConditionalCheckFailedException"),
          () => Effect.void,
        ),
        Effect.mapError(databaseError("UpdateItem")),
        Effect.provide(client),
      ),

    reserveSend: (userId, now, max) => {
      const day = Quota.window(now, "day");
      return Quota.reserve(table, sendsKey(userId, day.label), day, max).pipe(
        Effect.provide(client),
      );
    },
  });
});

export const layer = Layer.effect(OutboxRepo, make());
