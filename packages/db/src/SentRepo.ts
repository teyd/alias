import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";

/**
 * One message we sent through SES, so a bounce can be traced to it (PLAN.md §20.28): the
 * feedback Lambda acts on a bounce only when it is about a message of ours, to the recipient
 * we sent it to. Holds no content and no address, only who sent it and to which of their
 * recipients, and expires after {@link LIFETIME}.
 */
export interface Sent {
  /** The ID SES returned for the send (`mail.messageId` in its events). */
  readonly messageId: string;
  readonly userId: string;
  readonly kind: "forward" | "reply" | "confirmation";
  /** The user's recipient it went to (forwards, confirmations); none for mail to a contact. */
  readonly recipientId: Option.Option<string>;
  readonly sentAt: DateTime.Utc;
}

/**
 * How long a bounce can still be traced to its message. SES publishes a bounce once it stops
 * retrying, and a downstream MTA may report one days after it accepted the message (RFC 5321
 * §4.5.4.1 suggests giving up after 4–5 days); a week covers both.
 */
export const LIFETIME = Duration.weeks(1);

export class SentRepo extends Context.Service<
  SentRepo,
  {
    /** Records a send. Writing the same message again overwrites it with the same values. */
    readonly record: (sent: Sent) => Effect.Effect<void, DatabaseError>;
    /**
     * The user's send with this SES message ID, unless it is unknown or expired (TTL deletes
     * late). Events name the user in their `alias-user` tag.
     */
    readonly find: (
      userId: string,
      messageId: string,
    ) => Effect.Effect<Option.Option<Sent>, DatabaseError>;
  }
>()("@alias/db/SentRepo") {}

/** In the sender's partition, so erasing the account removes it with everything else. */
const sentKey = (userId: string, messageId: string) => ({
  pk: { S: `USER#${userId}` },
  sk: { S: `SENT#${messageId}` },
});

const SentItem = Item.codec(
  Schema.Struct({
    messageId: Attribute.S,
    userId: Attribute.S,
    kind: Attribute.S.pipe(Schema.decodeTo(Schema.Literals(["forward", "reply", "confirmation"]))),
    recipientId: Schema.OptionFromOptionalKey(Attribute.S),
    sentAt: Attribute.EpochMillis,
    expiresAt: Attribute.EpochSeconds,
  }),
  "Sent",
);

const make = Effect.fn("SentRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();

  return SentRepo.of({
    record: Effect.fn("SentRepo.record")(function* (sent) {
      const attributes = yield* SentItem.encode({
        ...sent,
        expiresAt: DateTime.addDuration(sent.sentAt, LIFETIME),
      });
      yield* DynamoDB.putItem({
        TableName: table.name,
        Item: { ...sentKey(sent.userId, sent.messageId), ...attributes },
      }).pipe(Effect.mapError(databaseError("PutItem")), Effect.provide(client));
    }),

    find: Effect.fn("SentRepo.find")(function* (userId, messageId) {
      const result = yield* DynamoDB.getItem({
        TableName: table.name,
        Key: sentKey(userId, messageId),
        ConsistentRead: true,
      }).pipe(Effect.mapError(databaseError("GetItem")), Effect.provide(client));
      const found = yield* SentItem.decodeOption(Option.fromUndefinedOr(result.Item));
      const now = yield* DateTime.now;
      return Option.map(
        Option.filter(found, (item) => DateTime.isGreaterThan(item.expiresAt, now)),
        (item): Sent => ({
          messageId: item.messageId,
          userId: item.userId,
          kind: item.kind,
          recipientId: item.recipientId,
          sentAt: item.sentAt,
        }),
      );
    }),
  });
});

export const layer = Layer.effect(SentRepo, make());

/**
 * Records a send that just went out, now. A failure is logged, not raised: the mail is already
 * out, and failing would make the caller send it again; without the record, its bounces are
 * ignored (PLAN.md §20.28).
 */
export const remember = Effect.fn("SentRepo.remember")(function* (sent: Omit<Sent, "sentAt">) {
  const repo = yield* SentRepo;
  yield* repo
    .record({ ...sent, sentAt: yield* DateTime.now })
    .pipe(
      Effect.catchTag("DatabaseError", (error) =>
        Effect.logWarning("sent mail not recorded", error.operation),
      ),
    );
});
