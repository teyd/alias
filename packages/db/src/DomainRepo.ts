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
import { conditionFailedAt } from "./Transaction.ts";

/**
 * - `pending`: claimed, its records not (all) seen yet. Nothing is received or sent on it.
 * - `verified`: the owner's records and SES's DKIM verification are in place; aliases work.
 * - `failed`: was verified, but a required record went missing; aliases stop until it's back.
 */
export const DomainStatus = Schema.Literals(["pending", "verified", "failed"]);
export type DomainStatus = typeof DomainStatus.Type;

/** What the last DNS check saw for one record. */
export const RecordState = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  state: Schema.Literals(["ok", "missing", "wrong", "unknown"]),
});
export type RecordState = typeof RecordState.Type;

/** A custom domain (PLAN.md §20.18). One user per domain, across the service. */
export interface Domain {
  /** Lowercased. */
  readonly domain: string;
  readonly userId: string;
  readonly status: DomainStatus;
  /** Random, per claim: the owner publishes `alias-verification=<token>` to prove control. */
  readonly verificationToken: string;
  /** Easy DKIM tokens of the SES identity; empty until SES created it. */
  readonly dkimTokens: ReadonlyArray<string>;
  /** Where the DKIM CNAMEs point. */
  readonly dkimZone: string;
  /** Mail to an unknown address on the domain creates the alias. Off until the owner opts in. */
  readonly isCatchAllEnabled: boolean;
  readonly createdAt: DateTime.Utc;
  readonly verifiedAt: Option.Option<DateTime.Utc>;
  readonly checkedAt: Option.Option<DateTime.Utc>;
  /** The last check's findings, record by record. */
  readonly checks: ReadonlyArray<RecordState>;
  /** When the verification cron looks at it next. */
  readonly nextCheckAt: DateTime.Utc;
}

export interface NewDomain {
  readonly domain: string;
  readonly userId: string;
  readonly verificationToken: string;
  readonly createdAt: DateTime.Utc;
}

/** What a check changes. */
export interface CheckResult {
  readonly status: DomainStatus;
  readonly checks: ReadonlyArray<RecordState>;
  readonly checkedAt: DateTime.Utc;
  readonly verifiedAt: Option.Option<DateTime.Utc>;
  readonly nextCheckAt: DateTime.Utc;
}

/** Someone (maybe the caller) already claimed the domain. */
export class DomainTaken extends Schema.TaggedError<DomainTaken>()("DomainTaken", {
  domain: Schema.String,
}) {}

export class TooManyDomains extends Schema.TaggedError<TooManyDomains>()("TooManyDomains", {
  limit: Schema.Number,
}) {}

/** No such domain, or it belongs to someone else. */
export class NoSuchDomain extends Schema.TaggedError<NoSuchDomain>()("NoSuchDomain", {
  domain: Schema.String,
}) {}

export class DomainRepo extends Context.Service<
  DomainRepo,
  {
    /**
     * Claims a domain for the user as `pending`. Fails when anyone has it already, or the user
     * has `maxPerUser` domains. Both checks are atomic.
     */
    readonly claim: (
      domain: NewDomain,
      maxPerUser: number,
    ) => Effect.Effect<Domain, DomainTaken | TooManyDomains | DatabaseError>;
    /** Strongly consistent; the inbound Lambda resolves custom-domain mail through it. */
    readonly find: (domain: string) => Effect.Effect<Option.Option<Domain>, DatabaseError>;
    /** Oldest first. */
    readonly listByUser: (userId: string) => Effect.Effect<ReadonlyArray<Domain>, DatabaseError>;
    /** Stores the SES identity's DKIM setup. */
    readonly setIdentity: (
      userId: string,
      domain: string,
      identity: { readonly dkimTokens: ReadonlyArray<string>; readonly dkimZone: string },
    ) => Effect.Effect<Domain, NoSuchDomain | DatabaseError>;
    readonly recordCheck: (
      userId: string,
      domain: string,
      result: CheckResult,
    ) => Effect.Effect<Domain, NoSuchDomain | DatabaseError>;
    readonly setCatchAll: (
      userId: string,
      domain: string,
      isEnabled: boolean,
    ) => Effect.Effect<Domain, NoSuchDomain | DatabaseError>;
    /** Releases the claim. */
    readonly remove: (
      userId: string,
      domain: string,
    ) => Effect.Effect<void, NoSuchDomain | DatabaseError>;
    /**
     * Domains whose next check is due at `now`, soonest first, at most `limit`. Read from an
     * index, so a just-written check may still show as due.
     */
    readonly due: (
      now: DateTime.Utc,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Domain>, DatabaseError>;
  }
>()("@alias/db/DomainRepo") {}

const domainKey = (domain: string) => ({ pk: { S: `DOMAIN#${domain}` }, sk: { S: "DOMAIN" } });

/** The user's pointer to a domain they claimed, so listing them is one Query. */
const pointerKey = (userId: string, domain: string) => ({
  pk: { S: `USER#${userId}` },
  sk: { S: `DOMAIN#${domain}` },
});

/** How many domains the user has, kept in the same transactions as the claims. */
const countKey = (userId: string) => ({ pk: { S: `USER#${userId}` }, sk: { S: "DOMAINS" } });

/** Every domain sits in one index partition, ordered by when it's due. */
const CHECKS_PARTITION = "DOMAIN-CHECKS";
const dueKey = (at: DateTime.Utc, domain: string) =>
  `${String(DateTime.toEpochMillis(at)).padStart(15, "0")}#${domain}`;

const Checks = Attribute.S.pipe(Schema.decodeTo(Schema.fromJsonString(Schema.Array(RecordState))));

const DomainItem = Item.codec(
  Schema.Struct({
    domain: Attribute.S,
    userId: Attribute.S,
    status: Attribute.S.pipe(Schema.decodeTo(DomainStatus)),
    verificationToken: Attribute.S,
    dkimTokens: Attribute.StringList,
    dkimZone: Attribute.S,
    isCatchAllEnabled: Attribute.BOOL,
    createdAt: Attribute.EpochMillis,
    verifiedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
    checkedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
    checks: Checks,
    nextCheckAt: Attribute.EpochMillis,
  }),
  "Domain",
);

const PointerItem = Item.codec(Schema.Struct({ domain: Attribute.S }), "DomainPointer");

/** Until SES returns its zone, the one Easy DKIM CNAMEs have always pointed to. */
const DEFAULT_DKIM_ZONE = "dkim.amazonses.com";

const millis = (at: DateTime.Utc) => ({ N: String(DateTime.toEpochMillis(at)) });

const oldestFirst = Order.mapInput(DateTime.Order, (domain: Domain) => domain.createdAt);

const make = Effect.fn("DomainRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const find = (domain: string) =>
    DynamoDB.getItem({ TableName, Key: domainKey(domain), ConsistentRead: true }).pipe(
      Effect.mapError(databaseError("GetItem")),
      Effect.flatMap((result) => DomainItem.decodeOption(Option.fromUndefinedOr(result.Item))),
      Effect.provide(client),
    );

  const missing =
    (operation: string, domain: string) =>
    <E>(error: E) =>
      P.isTagged(error, "ConditionalCheckFailedException")
        ? new NoSuchDomain({ domain })
        : databaseError(operation)(error);

  /** `SET` on the user's own domain; returns it as stored afterwards. */
  const update = (
    userId: string,
    domain: string,
    assignments: ReadonlyArray<string>,
    values: Readonly<Record<string, DynamoDB.AttributeValue>>,
    removals: ReadonlyArray<string> = [],
  ) =>
    DynamoDB.updateItem({
      TableName,
      Key: domainKey(domain),
      UpdateExpression: [
        `SET ${Arr.join(assignments, ", ")}`,
        ...(Arr.isReadonlyArrayNonEmpty(removals) ? [`REMOVE ${Arr.join(removals, ", ")}`] : []),
      ].join(" "),
      // `status` is a reserved word, and DynamoDB refuses names no expression uses.
      ConditionExpression: "userId = :userId AND attribute_exists(#status)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":userId": { S: userId }, ...values },
      ReturnValues: "ALL_NEW",
    }).pipe(
      Effect.mapError(missing("UpdateItem", domain)),
      Effect.flatMap((result) => DomainItem.decode({ ...result.Attributes })),
      Effect.provide(client),
    );

  return DomainRepo.of({
    claim: Effect.fn("DomainRepo.claim")(function* (claimed, maxPerUser) {
      const stored: Domain = {
        ...claimed,
        status: "pending",
        dkimTokens: [],
        dkimZone: DEFAULT_DKIM_ZONE,
        isCatchAllEnabled: false,
        verifiedAt: Option.none(),
        checkedAt: Option.none(),
        checks: [],
        nextCheckAt: claimed.createdAt,
      };
      const attributes = yield* DomainItem.encode(stored);
      const pointer = yield* PointerItem.encode({ domain: claimed.domain });
      yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Update: {
              TableName,
              Key: countKey(claimed.userId),
              UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one",
              ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
              ExpressionAttributeNames: { "#count": "count" },
              ExpressionAttributeValues: {
                ":zero": { N: "0" },
                ":one": { N: "1" },
                ":max": { N: String(maxPerUser) },
              },
            },
          },
          {
            Put: {
              TableName,
              Item: {
                ...domainKey(claimed.domain),
                gsi1pk: { S: CHECKS_PARTITION },
                gsi1sk: { S: dueKey(stored.nextCheckAt, claimed.domain) },
                ...attributes,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName,
              Item: { ...pointerKey(claimed.userId, claimed.domain), ...pointer },
            },
          },
        ],
      }).pipe(
        Effect.mapError((error) => {
          if (conditionFailedAt(error, 1)) return new DomainTaken({ domain: claimed.domain });
          if (conditionFailedAt(error, 0)) return new TooManyDomains({ limit: maxPerUser });
          return databaseError("TransactWriteItems")(error);
        }),
        Effect.provide(client),
      );
      return stored;
    }),

    find,

    listByUser: Effect.fn("DomainRepo.listByUser")(function* (userId) {
      const pointers = yield* DynamoDB.query
        .items({
          TableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": { S: `USER#${userId}` },
            ":prefix": { S: "DOMAIN#" },
          },
          ConsistentRead: true,
        })
        .pipe(
          Stream.mapError(databaseError("Query")),
          Stream.mapEffect(PointerItem.decode),
          Stream.runCollect,
          Effect.provide(client),
        );
      const domains = yield* Effect.forEach(pointers, (pointer) => find(pointer.domain), {
        concurrency: 4,
      });
      // A pointer whose domain is gone or someone else's (a removal half seen) shows nothing.
      return Arr.sort(
        Arr.filter(Arr.getSomes(domains), (domain) => domain.userId === userId),
        oldestFirst,
      );
    }),

    setIdentity: (userId, domain, identity) =>
      Effect.flatMap(
        Attribute.StringList.pipe(Schema.encodeEffect)(identity.dkimTokens).pipe(
          Effect.mapError(databaseError("EncodeDomain")),
        ),
        (tokens) =>
          update(userId, domain, ["dkimTokens = :tokens", "dkimZone = :zone"], {
            ":tokens": tokens,
            ":zone": { S: identity.dkimZone },
          }),
      ),

    recordCheck: Effect.fn("DomainRepo.recordCheck")(function* (userId, domain, result) {
      const checks = yield* Schema.encodeEffect(Checks)(result.checks).pipe(
        Effect.mapError(databaseError("EncodeDomain")),
      );
      return yield* update(
        userId,
        domain,
        [
          "#status = :status",
          "checks = :checks",
          "checkedAt = :checkedAt",
          "nextCheckAt = :next",
          "gsi1sk = :due",
          ...(Option.isSome(result.verifiedAt) ? ["verifiedAt = :verifiedAt"] : []),
        ],
        {
          ":status": { S: result.status },
          ":checks": checks,
          ":checkedAt": millis(result.checkedAt),
          ":next": millis(result.nextCheckAt),
          ":due": { S: dueKey(result.nextCheckAt, domain) },
          ...Option.match(result.verifiedAt, {
            onNone: () => ({}),
            onSome: (at) => ({ ":verifiedAt": millis(at) }),
          }),
        },
        Option.isSome(result.verifiedAt) ? [] : ["verifiedAt"],
      );
    }),

    setCatchAll: (userId, domain, isEnabled) =>
      update(userId, domain, ["isCatchAllEnabled = :isEnabled"], {
        ":isEnabled": { BOOL: isEnabled },
      }),

    remove: (userId, domain) =>
      DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Delete: {
              TableName,
              Key: domainKey(domain),
              ConditionExpression: "userId = :userId",
              ExpressionAttributeValues: { ":userId": { S: userId } },
            },
          },
          { Delete: { TableName, Key: pointerKey(userId, domain) } },
          {
            Update: {
              TableName,
              Key: countKey(userId),
              UpdateExpression: "ADD #count :minusOne",
              ExpressionAttributeNames: { "#count": "count" },
              ExpressionAttributeValues: { ":minusOne": { N: "-1" } },
            },
          },
        ],
      }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          conditionFailedAt(error, 0)
            ? new NoSuchDomain({ domain })
            : databaseError("TransactWriteItems")(error),
        ),
        Effect.provide(client),
      ),

    due: (now, limit) =>
      DynamoDB.query({
        TableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :partition AND gsi1sk <= :now",
        ExpressionAttributeValues: {
          ":partition": { S: CHECKS_PARTITION },
          // `~` sorts after every domain character, so everything due at `now` is included.
          ":now": { S: `${dueKey(now, "")}~` },
        },
        Limit: limit,
      }).pipe(
        Effect.mapError(databaseError("Query")),
        Effect.flatMap((result) =>
          Effect.forEach(result.Items ?? [], DomainItem.decode, { concurrency: 1 }),
        ),
        Effect.provide(client),
      ),
  });
});

export const layer = Layer.effect(DomainRepo, make());
