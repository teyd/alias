import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
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
import { type NewToken, tokenPut } from "./TokenRepo.ts";
import { conditionFailedAt } from "./Transaction.ts";

/** What the signed-in user said about a device login. */
const Decision = Schema.TaggedUnion({
  Pending: {},
  Approved: { userId: Schema.String, username: Schema.String },
  Denied: {},
});
export type Decision = typeof Decision.Type;
export const Pending = () => Decision.cases.Pending.make({});
export const Approved = (user: { readonly userId: string; readonly username: string }) =>
  Decision.cases.Approved.make(user);
export const Denied = () => Decision.cases.Denied.make({});
export const matchDecision = Decision.match;

/**
 * A device login in progress (OAuth 2.0 device authorization grant, RFC 8628; PLAN.md §20.23).
 * The device holds the device code, the person the user code; only the device code's hash is
 * stored.
 */
export interface DeviceGrant {
  /** SHA-256 of the device code, the key the device polls with. */
  readonly deviceHash: string;
  /** Normalized (`BCDFGHJK`), see `UserCode` in `@alias/core`. */
  readonly userCode: string;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
  /** The polling interval the device must keep, in seconds; `slow_down` adds 5. */
  readonly pollSeconds: number;
  /** The earliest the next poll may come without a `slow_down`. */
  readonly nextPollAt: DateTime.Utc;
  readonly decision: Decision;
}

/** A poll's view of its grant, after recording the poll. */
export interface Polled {
  readonly grant: DeviceGrant;
  /** The device polled before `nextPollAt` (or raced another poll): answer `slow_down`. */
  readonly isTooSoon: boolean;
}

/** Another live grant has this user code; draw another. */
export class UserCodeTaken extends Schema.TaggedError<UserCodeTaken>()("UserCodeTaken", {}) {}

/** No pending, unexpired grant has this user code. */
export class NoSuchDeviceGrant extends Schema.TaggedError<NoSuchDeviceGrant>()(
  "NoSuchDeviceGrant",
  {},
) {}

/** The grant is gone or no longer approved: another poll redeemed it first. */
export class GrantRedeemed extends Schema.TaggedError<GrantRedeemed>()("GrantRedeemed", {}) {}

export class DeviceRepo extends Context.Service<
  DeviceRepo,
  {
    /** Stores a new grant and claims its user code, both or neither. */
    readonly create: (grant: DeviceGrant) => Effect.Effect<void, UserCodeTaken | DatabaseError>;
    /** The unexpired grant with this user code, whatever its decision. */
    readonly findByUserCode: (
      userCode: string,
    ) => Effect.Effect<Option.Option<DeviceGrant>, DatabaseError>;
    /** Approves or denies a pending, unexpired grant, once. */
    readonly decide: (
      userCode: string,
      decision: Decision,
    ) => Effect.Effect<void, NoSuchDeviceGrant | DatabaseError>;
    /**
     * Records a poll by the device. None for an unknown device code. Polling before `nextPollAt`
     * adds 5 seconds to the interval, as RFC 8628 §3.5 asks of the device.
     */
    readonly poll: (deviceHash: string) => Effect.Effect<Option.Option<Polled>, DatabaseError>;
    /**
     * Ends an approved grant by creating its token, in one transaction, so two polls never get
     * two tokens.
     */
    readonly redeem: (
      grant: DeviceGrant,
      token: NewToken,
    ) => Effect.Effect<void, GrantRedeemed | DatabaseError>;
    /** Deletes a grant and its user code (a denied one, once the device heard about it). */
    readonly remove: (grant: DeviceGrant) => Effect.Effect<void, DatabaseError>;
    /** Counts one device authorization request from `source` (a hashed address); false over `max`. */
    readonly reserveRequest: (
      source: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<boolean, DatabaseError>;
    /** Unknown user codes the user tried in the current hour. */
    readonly misses: (userId: string, now: DateTime.Utc) => Effect.Effect<number, DatabaseError>;
    /** Counts one unknown user code tried by the user, up to `max` an hour. */
    readonly recordMiss: (
      userId: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<void, DatabaseError>;
  }
>()("@alias/db/DeviceRepo") {}

const grantKey = (deviceHash: string) => ({
  pk: { S: `DEVICE#${deviceHash}` },
  sk: { S: "DEVICE" },
});
const userCodeKey = (userCode: string) => ({
  pk: { S: `USERCODE#${userCode}` },
  sk: { S: "USERCODE" },
});
const requestsKey = (source: string, hour: string) => ({
  pk: { S: `DEVICEAUTH#${source}` },
  sk: { S: `REQUESTS#${hour}` },
});
const missesKey = (userId: string, hour: string) => ({
  pk: { S: `USER#${userId}` },
  sk: { S: `DEVICE-MISSES#${hour}` },
});

const DecisionJson = Schema.fromJsonString(Decision);
const encodeDecision = (decision: Decision) =>
  Schema.encodeEffect(DecisionJson)(decision).pipe(
    Effect.mapError(databaseError("EncodeDecision")),
  );

const GrantItem = Item.codec(
  Schema.Struct({
    deviceHash: Attribute.S,
    userCode: Attribute.S,
    clientId: Attribute.S,
    scopes: Attribute.StringList,
    createdAt: Attribute.EpochMillis,
    expiresAt: Attribute.EpochSeconds,
    pollSeconds: Attribute.N,
    nextPollAt: Attribute.EpochMillis,
    decision: Attribute.S.pipe(Schema.decodeTo(DecisionJson)),
  }),
  "DeviceGrant",
);

const UserCodeItem = Item.codec(
  Schema.Struct({ deviceHash: Attribute.S, expiresAt: Attribute.EpochSeconds }),
  "UserCode",
);

const CountItem = Item.codec(Schema.Struct({ count: Attribute.N }), "DeviceMisses");

const millis = (at: DateTime.Utc) => ({ N: String(DateTime.toEpochMillis(at)) });

const isConditionFailure = <E>(error: E) => P.isTagged(error, "ConditionalCheckFailedException");

/** RFC 8628 §3.5: each `slow_down` adds 5 seconds to the interval. */
const SLOW_DOWN = 5;

const make = Effect.fn("DeviceRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const getGrant = (deviceHash: string) =>
    DynamoDB.getItem({ TableName, Key: grantKey(deviceHash), ConsistentRead: true }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.flatMap((result) => GrantItem.decodeOption(Option.fromUndefinedOr(result.Item))),
      Effect.provide(client),
    );

  const findByUserCode = Effect.fn("DeviceRepo.findByUserCode")(function* (userCode: string) {
    const result = yield* DynamoDB.getItem({
      TableName,
      Key: userCodeKey(userCode),
      ConsistentRead: true,
    }).pipe(Effect.mapError(databaseError("GetItem")), Effect.provide(client));
    const claim = yield* UserCodeItem.decodeOption(Option.fromUndefinedOr(result.Item));
    if (Option.isNone(claim)) return Option.none<DeviceGrant>();
    const now = yield* DateTime.now;
    const grant = yield* getGrant(claim.value.deviceHash);
    return Option.filter(grant, (found) => DateTime.isGreaterThan(found.expiresAt, now));
  });

  /** Moves `nextPollAt` (and the interval) on, if the item still says what `grant` says. */
  const recordPoll = (grant: DeviceGrant, pollSeconds: number, now: DateTime.Utc) => {
    const nextPollAt = DateTime.addDuration(now, Duration.seconds(pollSeconds));
    return DynamoDB.updateItem({
      TableName,
      Key: grantKey(grant.deviceHash),
      UpdateExpression: "SET pollSeconds = :seconds, nextPollAt = :next",
      ConditionExpression: "nextPollAt = :seen",
      ExpressionAttributeValues: {
        ":seconds": { N: String(pollSeconds) },
        ":next": millis(nextPollAt),
        ":seen": millis(grant.nextPollAt),
      },
    }).pipe(
      Effect.as(Option.some({ ...grant, pollSeconds, nextPollAt })),
      Effect.catchIf(isConditionFailure, () => Effect.succeedNone),
      Effect.mapError(databaseError("UpdateItem")),
      Effect.provide(client),
    );
  };

  return DeviceRepo.of({
    create: Effect.fn("DeviceRepo.create")(function* (grant) {
      const attributes = yield* GrantItem.encode(grant);
      const claim = yield* UserCodeItem.encode({
        deviceHash: grant.deviceHash,
        expiresAt: grant.expiresAt,
      });
      yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: { ...grantKey(grant.deviceHash), ...attributes },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName,
              Item: { ...userCodeKey(grant.userCode), ...claim },
              // A claim TTL hasn't deleted yet is free once expired.
              ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
              ExpressionAttributeValues: {
                ":now": { N: String(Math.floor(DateTime.toEpochMillis(grant.createdAt) / 1000)) },
              },
            },
          },
        ],
      }).pipe(
        Effect.mapError((error) =>
          conditionFailedAt(error, 1)
            ? new UserCodeTaken()
            : databaseError("TransactWriteItems")(error),
        ),
        Effect.provide(client),
      );
    }),

    findByUserCode,

    decide: Effect.fn("DeviceRepo.decide")(function* (userCode, decision) {
      const grant = yield* findByUserCode(userCode);
      if (Option.isNone(grant)) return yield* new NoSuchDeviceGrant();
      const now = yield* DateTime.now;
      yield* DynamoDB.updateItem({
        TableName,
        Key: grantKey(grant.value.deviceHash),
        UpdateExpression: "SET decision = :decision",
        ConditionExpression: "decision = :pending AND expiresAt > :now",
        ExpressionAttributeValues: {
          ":decision": { S: yield* encodeDecision(decision) },
          ":pending": { S: yield* encodeDecision(Pending()) },
          ":now": { N: String(Math.floor(DateTime.toEpochMillis(now) / 1000)) },
        },
      }).pipe(
        Effect.asVoid,
        Effect.catchIf(isConditionFailure, () => Effect.fail(new NoSuchDeviceGrant())),
        Effect.mapError((error) =>
          P.isTagged(error, "NoSuchDeviceGrant") ? error : databaseError("UpdateItem")(error),
        ),
        Effect.provide(client),
      );
    }),

    poll: Effect.fn("DeviceRepo.poll")(function* (deviceHash) {
      const found = yield* getGrant(deviceHash);
      if (Option.isNone(found)) return Option.none<Polled>();
      const grant = found.value;
      const now = yield* DateTime.now;
      if (!DateTime.isGreaterThan(grant.expiresAt, now)) {
        return Option.some({ grant, isTooSoon: false });
      }
      const isTooSoon = DateTime.isLessThan(now, grant.nextPollAt);
      const pollSeconds = isTooSoon ? grant.pollSeconds + SLOW_DOWN : grant.pollSeconds;
      const recorded = yield* recordPoll(grant, pollSeconds, now);
      // Another poll got in between: this one came too soon after it.
      return Option.some(
        Option.match(recorded, {
          onNone: () => ({ grant, isTooSoon: true }),
          onSome: (updated) => ({ grant: updated, isTooSoon }),
        }),
      );
    }),

    redeem: Effect.fn("DeviceRepo.redeem")(function* (grant, token) {
      yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Delete: {
              TableName,
              Key: grantKey(grant.deviceHash),
              ConditionExpression: "decision = :approved",
              ExpressionAttributeValues: {
                ":approved": { S: yield* encodeDecision(grant.decision) },
              },
            },
          },
          { Delete: { TableName, Key: userCodeKey(grant.userCode) } },
          { Put: yield* tokenPut(TableName, token) },
        ],
      }).pipe(
        Effect.mapError((error) =>
          conditionFailedAt(error, 0)
            ? new GrantRedeemed()
            : databaseError("TransactWriteItems")(error),
        ),
        Effect.provide(client),
      );
    }),

    remove: (grant) =>
      DynamoDB.transactWriteItems({
        TransactItems: [
          { Delete: { TableName, Key: grantKey(grant.deviceHash) } },
          { Delete: { TableName, Key: userCodeKey(grant.userCode) } },
        ],
      }).pipe(
        Effect.asVoid,
        Effect.mapError(databaseError("TransactWriteItems")),
        Effect.provide(client),
      ),

    reserveRequest: (source, now, max) => {
      const hour = Quota.window(now, "hour");
      return Quota.reserve(table, requestsKey(source, hour.label), hour, max).pipe(
        Effect.provide(client),
      );
    },

    misses: Effect.fn("DeviceRepo.misses")(function* (userId, now) {
      const result = yield* DynamoDB.getItem({
        TableName,
        Key: missesKey(userId, Quota.window(now, "hour").label),
      }).pipe(Effect.mapError(databaseError("GetItem")), Effect.provide(client));
      const counter = yield* CountItem.decodeOption(Option.fromUndefinedOr(result.Item));
      return Option.match(counter, { onNone: () => 0, onSome: ({ count }) => count });
    }),

    recordMiss: (userId, now, max) => {
      const hour = Quota.window(now, "hour");
      return Quota.reserve(table, missesKey(userId, hour.label), hour, max).pipe(
        Effect.asVoid,
        Effect.provide(client),
      );
    },
  });
});

export const layer = Layer.effect(DeviceRepo, make());
