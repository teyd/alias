import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import * as Quota from "./Quota.ts";
import { conditionFailedAt } from "./Transaction.ts";

/** A real mailbox the user's alias mail is forwarded to (a forwarding address). */
export interface Recipient {
  readonly id: string;
  readonly userId: string;
  /** Lowercased. A user has each address at most once. */
  readonly address: string;
  readonly createdAt: DateTime.Utc;
  /** None until the owner proves they read the mailbox by confirming the mailed token. */
  readonly verifiedAt: Option.Option<DateTime.Utc>;
  /** When the last confirmation mail was sent; resends are rate-limited from here. */
  readonly lastSentAt: DateTime.Utc;
  /**
   * Where forwarded mail goes by default: the recipient the user picked, or else their oldest
   * verified one. Never a pending recipient.
   */
  readonly isDefault: boolean;
  /**
   * When SES last reported a permanent bounce for the address (PLAN.md §20.11). Forwarding to it
   * stops; a resent confirmation clears it.
   */
  readonly bouncedAt: Option.Option<DateTime.Utc>;
  /** When the owner's mailbox last reported forwarded mail as spam. Recorded, nothing more. */
  readonly complainedAt: Option.Option<DateTime.Utc>;
}

export interface NewRecipient {
  readonly id: string;
  readonly userId: string;
  readonly address: string;
  readonly createdAt: DateTime.Utc;
}

/** A mailed confirmation token, as stored: only its hash, never the token itself. */
export interface Confirmation {
  readonly tokenHash: string;
  readonly expiresAt: DateTime.Utc;
  readonly sentAt: DateTime.Utc;
}

export class RecipientExists extends Schema.TaggedError<RecipientExists>()("RecipientExists", {
  address: Schema.String,
}) {}

export class TooManyPendingRecipients extends Schema.TaggedError<TooManyPendingRecipients>()(
  "TooManyPendingRecipients",
  { limit: Schema.Number },
) {}

/** No recipient with this ID belongs to the user. */
export class NoSuchRecipient extends Schema.TaggedError<NoSuchRecipient>()("NoSuchRecipient", {
  recipientId: Schema.String,
}) {}

/** The token is wrong, expired or already used. */
export class ConfirmationMismatch extends Schema.TaggedError<ConfirmationMismatch>()(
  "ConfirmationMismatch",
  { recipientId: Schema.String },
) {}

/** The recipient was confirmed, resent or deleted since the caller read it. */
export class RecipientChanged extends Schema.TaggedError<RecipientChanged>()("RecipientChanged", {
  recipientId: Schema.String,
}) {}

/** The user has sent as many confirmation mails today (UTC) as they may. */
export class MailQuotaExceeded extends Schema.TaggedError<MailQuotaExceeded>()(
  "MailQuotaExceeded",
  { resetsAt: Schema.DateTimeUtc },
) {}

export class RecipientRepo extends Context.Service<
  RecipientRepo,
  {
    /**
     * Stores a pending recipient with its first confirmation. Fails when the user already has the
     * address, or already has `maxPending` unconfirmed recipients. Both checks are atomic.
     */
    readonly add: (
      recipient: NewRecipient,
      confirmation: Confirmation,
      maxPending: number,
    ) => Effect.Effect<void, RecipientExists | TooManyPendingRecipients | DatabaseError>;
    /** Oldest first. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<Recipient>, DatabaseError>;
    readonly find: (
      userId: string,
      recipientId: string,
    ) => Effect.Effect<Option.Option<Recipient>, DatabaseError>;
    /** Replaces the pending token, invalidating the old one, unless the recipient changed. */
    readonly renewConfirmation: (
      recipient: Recipient,
      confirmation: Confirmation,
    ) => Effect.Effect<void, RecipientChanged | DatabaseError>;
    /** Verifies the recipient if `tokenHash` matches a live token, and uses the token up. */
    readonly confirm: (
      recipient: Recipient,
      tokenHash: string,
      now: DateTime.Utc,
    ) => Effect.Effect<void, ConfirmationMismatch | DatabaseError>;
    /** Makes a verified recipient the user's default. */
    readonly setDefault: (
      recipient: Recipient,
    ) => Effect.Effect<void, RecipientChanged | DatabaseError>;
    readonly delete: (
      userId: string,
      recipientId: string,
    ) => Effect.Effect<void, NoSuchRecipient | DatabaseError>;
    /** Records a permanent bounce. False when the user has no recipient with this address. */
    readonly markBounced: (
      userId: string,
      address: string,
      at: DateTime.Utc,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Records a complaint. False when the user has no recipient with this address. */
    readonly markComplained: (
      userId: string,
      address: string,
      at: DateTime.Utc,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Counts one confirmation mail against the user's daily (UTC) allowance of `maxPerDay`. */
    readonly reserveMail: (
      userId: string,
      now: DateTime.Utc,
      maxPerDay: number,
    ) => Effect.Effect<void, MailQuotaExceeded | DatabaseError>;
  }
>()("@alias/db/RecipientRepo") {}

const userPartition = (userId: string) => ({ S: `USER#${userId}` });

const recipientKey = (userId: string, address: string) => ({
  pk: userPartition(userId),
  sk: { S: `RECIPIENT#${address}` },
});

/** Per-user recipient state: how many are pending, and which one is the default. */
const settingsKey = (userId: string) => ({ pk: userPartition(userId), sk: { S: "RECIPIENTS" } });

const mailQuotaKey = (userId: string, day: string) => ({
  pk: userPartition(userId),
  sk: { S: `CONFIRMATIONS#${day}` },
});

const RecipientItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    userId: Attribute.S,
    address: Attribute.S,
    createdAt: Attribute.EpochMillis,
    lastSentAt: Attribute.EpochMillis,
    verifiedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
    bouncedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
    complainedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
  }),
  "Recipient",
);

const SettingsItem = Item.codec(
  Schema.Struct({ defaultRecipientId: Schema.OptionFromOptionalKey(Attribute.S) }),
  "RecipientSettings",
);

const millis = (dateTime: DateTime.Utc) => ({ N: String(DateTime.toEpochMillis(dateTime)) });

const oldestFirst = Order.mapInput(
  DateTime.Order,
  (recipient: Omit<Recipient, "isDefault">) => recipient.createdAt,
);

/** The explicit default if it is still a verified recipient, else the oldest verified one. */
const withDefault = (
  recipients: ReadonlyArray<Omit<Recipient, "isDefault">>,
  explicit: Option.Option<string>,
): ReadonlyArray<Recipient> => {
  const verified = Arr.filter(recipients, (recipient) => Option.isSome(recipient.verifiedAt));
  const chosen = Option.filter(explicit, (id) => Arr.some(verified, (r) => r.id === id)).pipe(
    Option.orElse(() => Option.map(Arr.head(verified), (recipient) => recipient.id)),
  );
  return Arr.map(recipients, (recipient) => ({
    ...recipient,
    isDefault: Option.exists(chosen, (id) => id === recipient.id),
  }));
};

/** Maps a failed condition (single write, or the first item of a transaction). */
const changed =
  (operation: string, recipientId: string) =>
  <E>(error: E) =>
    P.isTagged(error, "ConditionalCheckFailedException") || conditionFailedAt(error, 0)
      ? new RecipientChanged({ recipientId })
      : databaseError(operation)(error);

const make = Effect.fn("RecipientRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const list = Effect.fn("RecipientRepo.list")(function* (userId: string) {
    const [items, settings] = yield* Effect.all(
      [
        DynamoDB.query
          .items({
            TableName,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": userPartition(userId),
              ":prefix": { S: "RECIPIENT#" },
            },
            ConsistentRead: true,
          })
          .pipe(
            Stream.mapError(databaseError("Query")),
            Stream.mapEffect(RecipientItem.decode),
            Stream.runCollect,
          ),
        DynamoDB.getItem({ TableName, Key: settingsKey(userId), ConsistentRead: true }).pipe(
          Effect.mapError(databaseError("GetItem")),
          Effect.flatMap((result) =>
            SettingsItem.decodeOption(Option.fromUndefinedOr(result.Item)),
          ),
        ),
      ],
      { concurrency: 2 },
    ).pipe(Effect.provide(client));
    return withDefault(
      Arr.sort(items, oldestFirst),
      Option.flatMap(settings, (found) => found.defaultRecipientId),
    );
  });

  const find = (userId: string, recipientId: string) =>
    Effect.map(
      list(userId),
      Arr.findFirst((recipient) => recipient.id === recipientId),
    );

  const settingsDecrement = (userId: string): DynamoDB.TransactWriteItem => ({
    Update: {
      TableName,
      Key: settingsKey(userId),
      UpdateExpression: "ADD pendingCount :minusOne",
      ExpressionAttributeValues: { ":minusOne": { N: "-1" } },
    },
  });

  /** One attempt; fails with `RecipientChanged` when the recipient changed after the read. */
  const deleteOnce = Effect.fn("RecipientRepo.deleteOnce")(function* (
    userId: string,
    recipientId: string,
  ) {
    const found = yield* find(userId, recipientId);
    if (Option.isNone(found)) return yield* new NoSuchRecipient({ recipientId });
    const recipient = found.value;
    const isPending = Option.isNone(recipient.verifiedAt);
    const remove: DynamoDB.TransactWriteItem = {
      Delete: {
        TableName,
        Key: recipientKey(userId, recipient.address),
        ConditionExpression: isPending
          ? "#id = :id AND attribute_not_exists(verifiedAt)"
          : "#id = :id AND attribute_exists(verifiedAt)",
        ExpressionAttributeNames: { "#id": "id" },
        ExpressionAttributeValues: { ":id": { S: recipientId } },
      },
    };
    // A dangling default is ignored by readers (see `withDefault`), so it needn't be cleared.
    yield* DynamoDB.transactWriteItems({
      TransactItems: isPending ? [remove, settingsDecrement(userId)] : [remove],
    }).pipe(Effect.mapError(changed("TransactWriteItems", recipientId)), Effect.provide(client));
  });

  /** Sets one timestamp on an existing recipient; false when there is none. */
  const mark = (
    userId: string,
    address: string,
    attribute: "bouncedAt" | "complainedAt",
    at: DateTime.Utc,
  ) =>
    DynamoDB.updateItem({
      TableName,
      Key: recipientKey(userId, address.toLowerCase()),
      UpdateExpression: "SET #at = :at",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#at": attribute },
      ExpressionAttributeValues: { ":at": millis(at) },
    }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => P.isTagged(error, "ConditionalCheckFailedException"),
        () => Effect.succeed(false),
      ),
      Effect.mapError(databaseError("UpdateItem")),
      Effect.provide(client),
    );

  return RecipientRepo.of({
    add: Effect.fn("RecipientRepo.add")(function* (recipient, confirmation, maxPending) {
      const attributes = yield* RecipientItem.encode({
        ...recipient,
        lastSentAt: confirmation.sentAt,
        verifiedAt: Option.none(),
        bouncedAt: Option.none(),
        complainedAt: Option.none(),
      });
      yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Update: {
              TableName,
              Key: settingsKey(recipient.userId),
              UpdateExpression: "SET pendingCount = if_not_exists(pendingCount, :zero) + :one",
              ConditionExpression: "attribute_not_exists(pendingCount) OR pendingCount < :max",
              ExpressionAttributeValues: {
                ":zero": { N: "0" },
                ":one": { N: "1" },
                ":max": { N: String(maxPending) },
              },
            },
          },
          {
            Put: {
              TableName,
              Item: {
                ...recipientKey(recipient.userId, recipient.address),
                ...attributes,
                tokenHash: { S: confirmation.tokenHash },
                tokenExpiresAt: millis(confirmation.expiresAt),
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }).pipe(
        Effect.mapError((error) => {
          if (conditionFailedAt(error, 1))
            return new RecipientExists({ address: recipient.address });
          if (conditionFailedAt(error, 0))
            return new TooManyPendingRecipients({ limit: maxPending });
          return databaseError("TransactWriteItems")(error);
        }),
        Effect.provide(client),
      );
    }),

    list,
    find,

    renewConfirmation: (recipient, confirmation) =>
      DynamoDB.updateItem({
        TableName,
        Key: recipientKey(recipient.userId, recipient.address),
        // A fresh confirmation is a fresh try: an earlier bounce no longer counts.
        UpdateExpression:
          "SET tokenHash = :hash, tokenExpiresAt = :expiresAt, lastSentAt = :sentAt REMOVE bouncedAt",
        ConditionExpression:
          "#id = :id AND attribute_not_exists(verifiedAt) AND lastSentAt = :previous",
        ExpressionAttributeNames: { "#id": "id" },
        ExpressionAttributeValues: {
          ":id": { S: recipient.id },
          ":hash": { S: confirmation.tokenHash },
          ":expiresAt": millis(confirmation.expiresAt),
          ":sentAt": millis(confirmation.sentAt),
          ":previous": millis(recipient.lastSentAt),
        },
      }).pipe(
        Effect.asVoid,
        Effect.mapError(changed("UpdateItem", recipient.id)),
        Effect.provide(client),
      ),

    confirm: (recipient, tokenHash, now) =>
      DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Update: {
              TableName,
              Key: recipientKey(recipient.userId, recipient.address),
              UpdateExpression: "SET verifiedAt = :now REMOVE tokenHash, tokenExpiresAt",
              // Pending, same token, not expired. Removing the token makes it single use.
              ConditionExpression: "#id = :id AND tokenHash = :hash AND tokenExpiresAt > :now",
              ExpressionAttributeNames: { "#id": "id" },
              ExpressionAttributeValues: {
                ":id": { S: recipient.id },
                ":hash": { S: tokenHash },
                ":now": millis(now),
              },
            },
          },
          settingsDecrement(recipient.userId),
        ],
      }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          conditionFailedAt(error, 0)
            ? new ConfirmationMismatch({ recipientId: recipient.id })
            : databaseError("TransactWriteItems")(error),
        ),
        Effect.provide(client),
      ),

    setDefault: (recipient) =>
      DynamoDB.transactWriteItems({
        TransactItems: [
          {
            ConditionCheck: {
              TableName,
              Key: recipientKey(recipient.userId, recipient.address),
              ConditionExpression: "#id = :id AND attribute_exists(verifiedAt)",
              ExpressionAttributeNames: { "#id": "id" },
              ExpressionAttributeValues: { ":id": { S: recipient.id } },
            },
          },
          {
            Update: {
              TableName,
              Key: settingsKey(recipient.userId),
              UpdateExpression: "SET defaultRecipientId = :id",
              ExpressionAttributeValues: { ":id": { S: recipient.id } },
            },
          },
        ],
      }).pipe(
        Effect.asVoid,
        Effect.mapError(changed("TransactWriteItems", recipient.id)),
        Effect.provide(client),
      ),

    // Read, then delete on the condition that nothing changed; a concurrent confirm only means
    // reading again.
    delete: (userId, recipientId) =>
      deleteOnce(userId, recipientId).pipe(
        Effect.retry({ times: 2, while: (error) => P.isTagged(error, "RecipientChanged") }),
        Effect.catchTag("RecipientChanged", (error) =>
          Effect.fail(databaseError("DeleteRecipient")(error)),
        ),
      ),

    markBounced: (userId, address, at) => mark(userId, address, "bouncedAt", at),
    markComplained: (userId, address, at) => mark(userId, address, "complainedAt", at),

    reserveMail: Effect.fn("RecipientRepo.reserveMail")(function* (userId, now, maxPerDay) {
      const day = Quota.window(now, "day");
      const isReserved = yield* Quota.reserve(
        table,
        mailQuotaKey(userId, day.label),
        day,
        maxPerDay,
      ).pipe(Effect.provide(client));
      if (!isReserved) return yield* new MailQuotaExceeded({ resetsAt: day.end });
    }),
  });
});

export const layer = Layer.effect(RecipientRepo, make());
