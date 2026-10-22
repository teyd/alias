import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
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
   * When forwarding to the address was paused because it bounces (PLAN.md §20.11, §20.28). The
   * pipeline sends it nothing more; a resent confirmation retries it (pending), and confirming
   * one resumes it (verified).
   */
  readonly bouncedAt: Option.Option<DateTime.Utc>;
  /** Why it was paused. None for pauses recorded before reasons were (§20.28). */
  readonly bounceReason: Option.Option<BounceReason>;
  /** When the owner's mailbox last reported forwarded mail as spam. Recorded, nothing more. */
  readonly complainedAt: Option.Option<DateTime.Utc>;
  /** Forwarded mail is encrypted to this OpenPGP key (PLAN.md §20.21). None: sent as it is. */
  readonly encryption: Option.Option<Encryption>;
}

/**
 * Why forwarding to a recipient is paused (PLAN.md §20.28): the receiving server said the mailbox
 * doesn't exist (`address-unknown`), SES refused to send to it because it is on a suppression
 * list (`suppressed`), or several of our messages bounced for good in a short time
 * (`repeated-bounces`).
 */
export const BounceReason = Schema.Literals(["address-unknown", "suppressed", "repeated-bounces"]);
export type BounceReason = typeof BounceReason.Type;

/** A recipient's OpenPGP public key, as `Pgp.readKey` accepted it, and how to use it. */
export interface Encryption {
  /** Armored. */
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly userIds: ReadonlyArray<string>;
  /** When the key stops encrypting, as of the upload; none if it never expires. */
  readonly expiresAt: Option.Option<DateTime.Utc>;
  /** Encrypt the subject too: `[...]` outside, the real one inside (header protection). */
  readonly isSubjectHidden: boolean;
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
    /**
     * Replaces the confirmation token, invalidating the old one, unless the recipient changed.
     * Only a pending or a paused (bounced) recipient has one; a pending one's bounce is cleared
     * now, a paused verified one stays paused until the new token is confirmed.
     */
    readonly renewConfirmation: (
      recipient: Recipient,
      confirmation: Confirmation,
    ) => Effect.Effect<void, RecipientChanged | DatabaseError>;
    /**
     * Verifies the recipient if `tokenHash` matches a live token, and uses the token up. For a
     * paused verified recipient, this resumes forwarding: the pause and its bounces are cleared.
     */
    readonly confirm: (
      recipient: Recipient,
      tokenHash: string,
      now: DateTime.Utc,
    ) => Effect.Effect<void, ConfirmationMismatch | DatabaseError>;
    /** Makes a verified recipient the user's default. */
    readonly setDefault: (
      recipient: Recipient,
    ) => Effect.Effect<void, RecipientChanged | DatabaseError>;
    /** Sets or replaces the recipient's key, unless the recipient was deleted since the read. */
    readonly setEncryption: (
      recipient: Recipient,
      encryption: Encryption,
    ) => Effect.Effect<void, RecipientChanged | DatabaseError>;
    /** Removes the key, if any: mail to the recipient goes out as it is again. */
    readonly removeEncryption: (
      recipient: Recipient,
    ) => Effect.Effect<void, RecipientChanged | DatabaseError>;
    readonly delete: (
      userId: string,
      recipientId: string,
    ) => Effect.Effect<void, NoSuchRecipient | DatabaseError>;
    /**
     * Pauses forwarding to the recipient with this address. False when the user has no
     * recipient with this address.
     */
    readonly markBounced: (
      userId: string,
      address: string,
      at: DateTime.Utc,
      reason: BounceReason,
    ) => Effect.Effect<boolean, DatabaseError>;
    /**
     * Records that our message `messageId` to the recipient bounced for good at `at`, and returns
     * how many distinct messages to it did so within `window` before `at`, counting none from
     * before its last confirmation mail or confirmation. The same message counts once, however
     * often its bounce is delivered.
     */
    readonly countBounce: (
      recipient: Recipient,
      messageId: string,
      at: DateTime.Utc,
      window: Duration.Duration,
    ) => Effect.Effect<number, DatabaseError>;
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

/** One hard bounce of one message to one recipient, by the recipient's id (a re-added address starts afresh). */
const bouncePrefix = (recipientId: string) => `BOUNCE#${recipientId}#`;
const bounceKey = (userId: string, recipientId: string, messageId: string) => ({
  pk: userPartition(userId),
  sk: { S: `${bouncePrefix(recipientId)}${messageId}` },
});

const BounceItem = Item.codec(Schema.Struct({ at: Attribute.EpochMillis }), "Bounce");

const mailQuotaKey = (userId: string, day: string) => ({
  pk: userPartition(userId),
  sk: { S: `CONFIRMATIONS#${day}` },
});

const EncryptionFields = Schema.Struct({
  publicKey: Attribute.S,
  fingerprint: Attribute.S,
  userIds: Attribute.StringList,
  expiresAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
  isSubjectHidden: Attribute.BOOL,
});

/** One map attribute (`M`), so setting or removing a key is one attribute, never half of one. */
const EncryptionAttribute = Schema.Struct({ M: EncryptionFields }).pipe(
  Schema.decodeTo(
    Schema.toType(EncryptionFields),
    SchemaTransformation.transform({
      decode: (attribute) => attribute.M,
      encode: (encryption) => ({ M: encryption }),
    }),
  ),
);

const encodeEncryption = (encryption: Encryption) =>
  Schema.encodeEffect(EncryptionAttribute)(encryption).pipe(
    Effect.mapError(databaseError("EncodeEncryption")),
  );

const RecipientItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    userId: Attribute.S,
    address: Attribute.S,
    createdAt: Attribute.EpochMillis,
    lastSentAt: Attribute.EpochMillis,
    verifiedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
    bouncedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
    bounceReason: Schema.OptionFromOptionalKey(Attribute.S.pipe(Schema.decodeTo(BounceReason))),
    complainedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
    encryption: Schema.OptionFromOptionalKey(EncryptionAttribute),
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

  /** Updates an existing recipient; false when there is none. */
  const mark = (
    userId: string,
    address: string,
    UpdateExpression: string,
    ExpressionAttributeValues: Readonly<Record<string, DynamoDB.AttributeValue>>,
  ) =>
    DynamoDB.updateItem({
      TableName,
      Key: recipientKey(userId, address.toLowerCase()),
      UpdateExpression,
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ...ExpressionAttributeValues },
    }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => P.isTagged(error, "ConditionalCheckFailedException"),
        () => Effect.succeed(false),
      ),
      Effect.mapError(databaseError("UpdateItem")),
      Effect.provide(client),
    );

  /** Confirms a paused verified recipient: forwarding resumes, the old bounces stop counting. */
  const resume = (recipient: Recipient, tokenHash: string, now: DateTime.Utc) =>
    DynamoDB.updateItem({
      TableName,
      Key: recipientKey(recipient.userId, recipient.address),
      UpdateExpression:
        "SET verifiedAt = :now REMOVE tokenHash, tokenExpiresAt, bouncedAt, bounceReason",
      ConditionExpression:
        "#id = :id AND attribute_exists(verifiedAt) AND tokenHash = :hash AND tokenExpiresAt > :now",
      ExpressionAttributeNames: { "#id": "id" },
      ExpressionAttributeValues: {
        ":id": { S: recipient.id },
        ":hash": { S: tokenHash },
        ":now": millis(now),
      },
    }).pipe(
      Effect.asVoid,
      Effect.mapError((error) =>
        P.isTagged(error, "ConditionalCheckFailedException")
          ? new ConfirmationMismatch({ recipientId: recipient.id })
          : databaseError("UpdateItem")(error),
      ),
      Effect.provide(client),
    );

  return RecipientRepo.of({
    add: Effect.fn("RecipientRepo.add")(function* (recipient, confirmation, maxPending) {
      const attributes = yield* RecipientItem.encode({
        ...recipient,
        lastSentAt: confirmation.sentAt,
        verifiedAt: Option.none(),
        bouncedAt: Option.none(),
        bounceReason: Option.none(),
        complainedAt: Option.none(),
        encryption: Option.none(),
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
        // For a pending recipient a fresh confirmation is a fresh try: an earlier bounce no
        // longer counts. A paused verified one resumes only once the new token is confirmed.
        UpdateExpression: Option.isNone(recipient.verifiedAt)
          ? "SET tokenHash = :hash, tokenExpiresAt = :expiresAt, lastSentAt = :sentAt REMOVE bouncedAt, bounceReason"
          : "SET tokenHash = :hash, tokenExpiresAt = :expiresAt, lastSentAt = :sentAt",
        ConditionExpression: Option.isNone(recipient.verifiedAt)
          ? "#id = :id AND attribute_not_exists(verifiedAt) AND lastSentAt = :previous"
          : "#id = :id AND attribute_exists(verifiedAt) AND attribute_exists(bouncedAt) AND lastSentAt = :previous",
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
      Option.isSome(recipient.verifiedAt)
        ? resume(recipient, tokenHash, now)
        : DynamoDB.transactWriteItems({
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

    setEncryption: Effect.fn("RecipientRepo.setEncryption")(function* (recipient, encryption) {
      const value = yield* encodeEncryption(encryption);
      yield* DynamoDB.updateItem({
        TableName,
        Key: recipientKey(recipient.userId, recipient.address),
        UpdateExpression: "SET encryption = :encryption",
        ConditionExpression: "#id = :id",
        ExpressionAttributeNames: { "#id": "id" },
        ExpressionAttributeValues: { ":id": { S: recipient.id }, ":encryption": value },
      }).pipe(Effect.mapError(changed("UpdateItem", recipient.id)), Effect.provide(client));
    }),

    removeEncryption: (recipient) =>
      DynamoDB.updateItem({
        TableName,
        Key: recipientKey(recipient.userId, recipient.address),
        UpdateExpression: "REMOVE encryption",
        ConditionExpression: "#id = :id",
        ExpressionAttributeNames: { "#id": "id" },
        ExpressionAttributeValues: { ":id": { S: recipient.id } },
      }).pipe(
        Effect.asVoid,
        Effect.mapError(changed("UpdateItem", recipient.id)),
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

    markBounced: (userId, address, at, reason) =>
      mark(userId, address, "SET bouncedAt = :at, bounceReason = :reason", {
        ":at": millis(at),
        ":reason": { S: reason },
      }),
    markComplained: (userId, address, at) =>
      mark(userId, address, "SET complainedAt = :at", { ":at": millis(at) }),

    countBounce: Effect.fn("RecipientRepo.countBounce")(
      function* (recipient, messageId, at, window) {
        const attributes = yield* BounceItem.encode({ at });
        const expires = yield* Schema.encodeEffect(Attribute.EpochSeconds)(
          DateTime.addDuration(at, window),
        ).pipe(Effect.mapError(databaseError("EncodeBounce")));
        yield* DynamoDB.putItem({
          TableName,
          Item: {
            ...bounceKey(recipient.userId, recipient.id, messageId),
            ...attributes,
            expiresAt: expires,
          },
        }).pipe(Effect.mapError(databaseError("PutItem")), Effect.provide(client));
        // A confirmation mail or a confirmation starts the count afresh.
        const since = Arr.reduce(
          [...Option.toArray(recipient.verifiedAt), recipient.lastSentAt],
          DateTime.subtractDuration(at, window),
          DateTime.max,
        );
        const bounces = yield* DynamoDB.query
          .items({
            TableName,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": userPartition(recipient.userId),
              ":prefix": { S: bouncePrefix(recipient.id) },
            },
            ConsistentRead: true,
          })
          .pipe(
            Stream.mapError(databaseError("Query")),
            Stream.mapEffect(BounceItem.decode),
            Stream.runCollect,
            Effect.provide(client),
          );
        return Arr.filter(
          bounces,
          (bounce) =>
            DateTime.isGreaterThanOrEqualTo(bounce.at, since) &&
            DateTime.isLessThanOrEqualTo(bounce.at, at),
        ).length;
      },
    ),

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
