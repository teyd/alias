import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import * as Purge from "./Purge.ts";
import * as Quota from "./Quota.ts";
import * as Transaction from "./Transaction.ts";

/**
 * The OAuth 2.1 authorization server's state (PLAN.md §20.24): clients registered dynamically
 * (RFC 7591), authorization codes, and grants with their access and refresh tokens. Codes and
 * tokens are stored only as the SHA-256 of their secret, like personal API tokens.
 */

/**
 * A client registered through RFC 7591. Clients known by a metadata document aren't stored.
 * Registration needs no account, so a client expires unless it is used: TTL removes it at
 * `expiresAt`, and its first grant clears `expiresAt` for good (PLAN.md §20.30).
 */
export interface Client {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: ReadonlyArray<string>;
  readonly uri: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: Option.Option<DateTime.Utc>;
}

/** What a signed-in user approved, waiting for its client to redeem it once. */
export interface Code {
  /** SHA-256 of the code. */
  readonly hash: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  /** The PKCE `S256` challenge. */
  readonly codeChallenge: string;
  readonly scopes: ReadonlyArray<string>;
  readonly resource: string;
  readonly userId: string;
  readonly username: string;
  readonly expiresAt: DateTime.Utc;
  /** Set when redeemed: a second redemption revokes this grant (OAuth 2.1 §4.1.3). */
  readonly grantId: Option.Option<string>;
}

export type NewCode = Omit<Code, "grantId">;

/** One client's access to one user's account: what the user sees under "Connected apps". */
export interface Grant {
  readonly id: string;
  readonly userId: string;
  readonly username: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: ReadonlyArray<string>;
  readonly resource: string;
  readonly createdAt: DateTime.Utc;
  /** When the newest refresh token expires; TTL removes a grant nobody refreshes. */
  readonly expiresAt: DateTime.Utc;
}

/** An access token, as a request authenticates with it. */
export interface Access {
  readonly hash: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly username: string;
  readonly scopes: ReadonlyArray<string>;
  readonly resource: string;
  readonly expiresAt: DateTime.Utc;
}

export interface Refresh {
  readonly hash: string;
  readonly grantId: string;
  readonly clientId: string;
  readonly userId: string;
  readonly expiresAt: DateTime.Utc;
  /** Set when exchanged. Presenting it again is a reuse, which revokes the grant. */
  readonly usedAt: Option.Option<DateTime.Utc>;
}

type NewRefresh = Omit<Refresh, "usedAt">;

/** The tokens one token request issues. */
export interface Issued {
  readonly access: Access;
  readonly refresh: NewRefresh;
}

/** The code is unknown, expired, or was redeemed before (that grant is now revoked). */
export class CodeUnusable extends Schema.TaggedError<CodeUnusable>()("CodeUnusable", {}) {}

/** The refresh token is unknown, expired, reused (its grant is now revoked) or revoked. */
export class RefreshUnusable extends Schema.TaggedError<RefreshUnusable>()("RefreshUnusable", {}) {}

export class NoSuchGrant extends Schema.TaggedError<NoSuchGrant>()("NoSuchGrant", {
  grantId: Schema.String,
}) {}

export class OAuthRepo extends Context.Service<
  OAuthRepo,
  {
    readonly registerClient: (client: Client) => Effect.Effect<void, DatabaseError>;
    readonly findClient: (id: string) => Effect.Effect<Option.Option<Client>, DatabaseError>;
    /**
     * Counts one client registration from `source` (a hashed client address) in the current
     * hour, up to `max`. False when the hour's quota is used up.
     */
    readonly reserveRegistration: (
      source: string,
      now: DateTime.Utc,
      max: number,
    ) => Effect.Effect<boolean, DatabaseError>;
    readonly createCode: (code: NewCode) => Effect.Effect<void, DatabaseError>;
    /** The code with this hash, redeemed or not; None for unknown and expired ones. */
    readonly findCode: (hash: string) => Effect.Effect<Option.Option<Code>, DatabaseError>;
    /**
     * Redeems `code` for a new grant and its first tokens, all or nothing. A code redeemed before
     * fails with `CodeUnusable` and revokes the grant it issued. For a registered client, the
     * same transaction keeps the client for good; one that expired meanwhile fails it, also
     * with `CodeUnusable`.
     */
    readonly redeemCode: (
      code: Code,
      grant: Grant,
      issued: Issued,
      client: { readonly isRegistered: boolean },
    ) => Effect.Effect<void, CodeUnusable | DatabaseError>;
    /** The refresh token with this hash, used or not; None for unknown and expired ones. */
    readonly findRefresh: (hash: string) => Effect.Effect<Option.Option<Refresh>, DatabaseError>;
    /**
     * Exchanges `refresh` for new tokens of the same grant (rotation, OAuth 2.1 §4.3.1). A token
     * exchanged before is a reuse: it fails with `RefreshUnusable` and revokes the grant, so a
     * stolen refresh token and its legitimate copy can't both go on.
     */
    readonly rotate: (
      refresh: Refresh,
      issued: Issued,
      grantExpiresAt: DateTime.Utc,
    ) => Effect.Effect<void, RefreshUnusable | DatabaseError>;
    /** The live access token with this hash, while its grant exists. */
    readonly findAccess: (hash: string) => Effect.Effect<Option.Option<Access>, DatabaseError>;
    readonly findGrant: (id: string) => Effect.Effect<Option.Option<Grant>, DatabaseError>;
    /** The user's grants, oldest first, from the eventually consistent index. */
    readonly listGrants: (userId: string) => Effect.Effect<ReadonlyArray<Grant>, DatabaseError>;
    /** Revokes the grant and with it every token it issued. Idempotent. */
    readonly revokeGrant: (grantId: string) => Effect.Effect<void, DatabaseError>;
    /** Revokes the user's grant, failing for someone else's or a missing one. */
    readonly revokeUserGrant: (
      userId: string,
      grantId: string,
    ) => Effect.Effect<void, NoSuchGrant | DatabaseError>;
    /** Deletes one access token (RFC 7009). Idempotent. */
    readonly revokeAccess: (hash: string) => Effect.Effect<void, DatabaseError>;
  }
>()("@alias/db/OAuthRepo") {}

const clientKey = (id: string) => ({ pk: { S: `OAUTH-CLIENT#${id}` }, sk: { S: "CLIENT" } });
const codeKey = (hash: string) => ({ pk: { S: `OAUTH-CODE#${hash}` }, sk: { S: "CODE" } });
const grantKey = (id: string) => ({ pk: { S: `OAUTH-GRANT#${id}` }, sk: { S: "GRANT" } });
const accessKey = (hash: string) => ({ pk: { S: `OAUTH-ACCESS#${hash}` }, sk: { S: "ACCESS" } });
const refreshKey = (hash: string) => ({
  pk: { S: `OAUTH-REFRESH#${hash}` },
  sk: { S: "REFRESH" },
});
const registrationKey = (source: string, hour: string) => ({
  pk: { S: `OAUTHREG#${source}` },
  sk: { S: `REGISTRATIONS#${hour}` },
});

/** The gsi1 partition holding a user's grants and tokens, so erasing the account finds them. */
export const userOAuthKey = (userId: string) => `OAUTH#${userId}`;
const userOAuth = (userId: string) => ({ S: userOAuthKey(userId) });

const ClientItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    name: Attribute.S,
    redirectUris: Attribute.StringList,
    uri: Schema.OptionFromOptionalKey(Attribute.S),
    createdAt: Attribute.EpochMillis,
    expiresAt: Schema.OptionFromOptionalKey(Attribute.EpochSeconds),
  }),
  "OAuthClient",
);

const CodeItem = Item.codec(
  Schema.Struct({
    hash: Attribute.S,
    clientId: Attribute.S,
    clientName: Attribute.S,
    redirectUri: Attribute.S,
    codeChallenge: Attribute.S,
    scopes: Attribute.StringList,
    resource: Attribute.S,
    userId: Attribute.S,
    username: Attribute.S,
    expiresAt: Attribute.EpochSeconds,
    grantId: Schema.OptionFromOptionalKey(Attribute.S),
  }),
  "OAuthCode",
);

const GrantItem = Item.codec(
  Schema.Struct({
    id: Attribute.S,
    userId: Attribute.S,
    username: Attribute.S,
    clientId: Attribute.S,
    clientName: Attribute.S,
    scopes: Attribute.StringList,
    resource: Attribute.S,
    createdAt: Attribute.EpochMillis,
    expiresAt: Attribute.EpochSeconds,
  }),
  "OAuthGrant",
);

const AccessItem = Item.codec(
  Schema.Struct({
    hash: Attribute.S,
    grantId: Attribute.S,
    clientId: Attribute.S,
    userId: Attribute.S,
    username: Attribute.S,
    scopes: Attribute.StringList,
    resource: Attribute.S,
    expiresAt: Attribute.EpochSeconds,
  }),
  "OAuthAccess",
);

const RefreshItem = Item.codec(
  Schema.Struct({
    hash: Attribute.S,
    grantId: Attribute.S,
    clientId: Attribute.S,
    userId: Attribute.S,
    expiresAt: Attribute.EpochSeconds,
    usedAt: Schema.OptionFromOptionalKey(Attribute.EpochMillis),
  }),
  "OAuthRefresh",
);

const isLive =
  (now: DateTime.Utc) =>
  <A extends { readonly expiresAt: DateTime.Utc }>(item: A) =>
    DateTime.isGreaterThan(item.expiresAt, now);

const make = Effect.fn("OAuthRepo.make")(function* () {
  const table = yield* DynamoTable;
  const client = yield* Effect.context<Database>();
  const TableName = table.name;

  const get = (key: DynamoDB.AttributeMap) =>
    DynamoDB.getItem({ TableName, Key: key, ConsistentRead: true }).pipe(
      Effect.map((result) => Option.fromUndefinedOr(result.Item)),
      Effect.mapError(databaseError("GetItem")),
    );

  const tokenItems = Effect.fn("OAuthRepo.tokenItems")(function* (issued: Issued) {
    const access = yield* AccessItem.encode(issued.access);
    const refresh = yield* RefreshItem.encode({ ...issued.refresh, usedAt: Option.none() });
    return [
      {
        Put: {
          TableName,
          Item: {
            ...accessKey(issued.access.hash),
            gsi1pk: userOAuth(issued.access.userId),
            gsi1sk: { S: `ACCESS#${issued.access.hash}` },
            ...access,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName,
          Item: {
            ...refreshKey(issued.refresh.hash),
            gsi1pk: userOAuth(issued.refresh.userId),
            gsi1sk: { S: `REFRESH#${issued.refresh.hash}` },
            ...refresh,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ];
  });

  const findGrant = Effect.fn("OAuthRepo.findGrant")(function* (id: string) {
    const grant = yield* GrantItem.decodeOption(yield* get(grantKey(id)));
    return Option.filter(grant, isLive(yield* DateTime.now));
  });

  /** Every item of the grant in the user's gsi1 partition: tokens, used refresh tokens. */
  const grantTokens = Effect.fn("OAuthRepo.grantTokens")(function* (userId: string, id: string) {
    const items = yield* DynamoDB.query
      .items({
        TableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :user",
        FilterExpression: "grantId = :grant",
        ExpressionAttributeValues: { ":user": userOAuth(userId), ":grant": { S: id } },
        ProjectionExpression: "pk, sk",
      })
      .pipe(Stream.mapError(databaseError("Query")), Stream.runCollect);
    return yield* Effect.forEach(items, Purge.keyOf, { concurrency: "unbounded" });
  });

  const revokeGrant = Effect.fn("OAuthRepo.revokeGrant")(function* (id: string) {
    const stored = yield* GrantItem.decodeOption(yield* get(grantKey(id)));
    // Deleting the grant first is what revokes: an access token authenticates only while its
    // grant exists, and a refresh token can't rotate without it.
    yield* DynamoDB.deleteItem({ TableName, Key: grantKey(id) }).pipe(
      Effect.mapError(databaseError("DeleteItem")),
    );
    if (Option.isNone(stored)) return;
    const tokens = yield* grantTokens(stored.value.userId, id);
    yield* Purge.deleteAll(table, tokens);
  });

  /** A refresh token presented a second time: the grant goes, with every token it issued. */
  const reused = (grantId: string) =>
    revokeGrant(grantId).pipe(Effect.andThen(Effect.fail(new RefreshUnusable())));

  const listGrants = (userId: string) =>
    DynamoDB.query
      .items({
        TableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :user AND begins_with(gsi1sk, :grant)",
        ExpressionAttributeValues: { ":user": userOAuth(userId), ":grant": { S: "GRANT#" } },
      })
      .pipe(
        Stream.mapError(databaseError("Query")),
        Stream.mapEffect(GrantItem.decode),
        Stream.runCollect,
      );

  return OAuthRepo.of({
    registerClient: Effect.fn("OAuthRepo.registerClient")(function* (registered) {
      const attributes = yield* ClientItem.encode(registered);
      yield* DynamoDB.putItem({
        TableName,
        Item: { ...clientKey(registered.id), ...attributes },
        ConditionExpression: "attribute_not_exists(pk)",
      }).pipe(Effect.mapError(databaseError("PutItem")));
    }, Effect.provide(client)),

    // TTL deletes late, so an expired client is gone already for readers.
    findClient: Effect.fn("OAuthRepo.findClient")(function* (id) {
      const found = yield* ClientItem.decodeOption(yield* get(clientKey(id)));
      const now = yield* DateTime.now;
      return Option.filter(found, (registered) =>
        Option.match(registered.expiresAt, {
          onNone: () => true,
          onSome: (expiresAt) => DateTime.isGreaterThan(expiresAt, now),
        }),
      );
    }, Effect.provide(client)),

    reserveRegistration: (source, now, max) => {
      const hour = Quota.window(now, "hour");
      return Quota.reserve(table, registrationKey(source, hour.label), hour, max).pipe(
        Effect.provide(client),
      );
    },

    createCode: Effect.fn("OAuthRepo.createCode")(function* (code) {
      const attributes = yield* CodeItem.encode({ ...code, grantId: Option.none() });
      yield* DynamoDB.putItem({
        TableName,
        Item: {
          ...codeKey(code.hash),
          gsi1pk: userOAuth(code.userId),
          gsi1sk: { S: `CODE#${code.hash}` },
          ...attributes,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }).pipe(Effect.mapError(databaseError("PutItem")));
    }, Effect.provide(client)),

    findCode: Effect.fn("OAuthRepo.findCode")(function* (hash) {
      const code = yield* CodeItem.decodeOption(yield* get(codeKey(hash)));
      return Option.filter(code, isLive(yield* DateTime.now));
    }, Effect.provide(client)),

    redeemCode: Effect.fn("OAuthRepo.redeemCode")(function* (code, grant, issued, redeemer) {
      const grantAttributes = yield* GrantItem.encode(grant);
      const tokens = yield* tokenItems(issued);
      const now = yield* Schema.encodeEffect(Attribute.EpochSeconds)(yield* DateTime.now).pipe(
        Effect.mapError(databaseError("EncodeOAuthClient")),
      );
      // A used client stays: its TTL goes. One that expired (TTL may not have deleted it yet)
      // fails the condition, like a code redeemed before.
      const keepClient = redeemer.isRegistered
        ? [
            {
              Update: {
                TableName,
                Key: clientKey(code.clientId),
                UpdateExpression: "REMOVE expiresAt",
                ConditionExpression:
                  "attribute_exists(pk) AND (attribute_not_exists(expiresAt) OR expiresAt > :now)",
                ExpressionAttributeValues: { ":now": now },
              },
            },
          ]
        : [];
      const isRedeemed = yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Update: {
              TableName,
              Key: codeKey(code.hash),
              UpdateExpression: "SET grantId = :grant",
              ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(grantId)",
              ExpressionAttributeValues: { ":grant": { S: grant.id } },
            },
          },
          {
            Put: {
              TableName,
              Item: {
                ...grantKey(grant.id),
                gsi1pk: userOAuth(grant.userId),
                gsi1sk: { S: `GRANT#${grant.id}` },
                ...grantAttributes,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          ...tokens,
          ...keepClient,
        ],
      }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) =>
            Transaction.conditionFailedAt(error, 0) ||
            (redeemer.isRegistered && Transaction.conditionFailedAt(error, 2 + tokens.length)),
          () => Effect.succeed(false),
        ),
        Effect.mapError(databaseError("TransactWriteItems")),
      );
      if (isRedeemed) return;
      // Redeemed before (or gone): whatever that redemption issued is revoked too.
      const stored = yield* CodeItem.decodeOption(yield* get(codeKey(code.hash)));
      const earlier = Option.flatMap(stored, (found) => found.grantId);
      if (Option.isSome(earlier)) yield* revokeGrant(earlier.value);
      return yield* new CodeUnusable();
    }, Effect.provide(client)),

    findRefresh: Effect.fn("OAuthRepo.findRefresh")(function* (hash) {
      const refresh = yield* RefreshItem.decodeOption(yield* get(refreshKey(hash)));
      return Option.filter(refresh, isLive(yield* DateTime.now));
    }, Effect.provide(client)),

    rotate: Effect.fn("OAuthRepo.rotate")(function* (refresh, issued, grantExpiresAt) {
      const now = yield* DateTime.now;
      const usedAt = yield* Schema.encodeEffect(Attribute.EpochMillis)(now).pipe(
        Effect.mapError(databaseError("EncodeOAuthRefresh")),
      );
      const expiresAt = yield* Schema.encodeEffect(Attribute.EpochSeconds)(grantExpiresAt).pipe(
        Effect.mapError(databaseError("EncodeOAuthGrant")),
      );
      if (Option.isSome(refresh.usedAt)) return yield* reused(refresh.grantId);
      const tokens = yield* tokenItems(issued);
      const outcome = yield* DynamoDB.transactWriteItems({
        TransactItems: [
          {
            Update: {
              TableName,
              Key: refreshKey(refresh.hash),
              UpdateExpression: "SET usedAt = :usedAt",
              ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt)",
              ExpressionAttributeValues: { ":usedAt": usedAt },
            },
          },
          {
            Update: {
              TableName,
              Key: grantKey(refresh.grantId),
              UpdateExpression: "SET expiresAt = :expiresAt",
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeValues: { ":expiresAt": expiresAt },
            },
          },
          ...tokens,
        ],
      }).pipe(
        Effect.as("rotated" as const),
        // Exchanged concurrently: one of the two holders is not the client.
        Effect.catchIf(
          (error) => Transaction.conditionFailedAt(error, 0),
          () => Effect.succeed("reused" as const),
        ),
        Effect.catchIf(
          (error) => Transaction.conditionFailedAt(error, 1),
          () => Effect.succeed("revoked" as const),
        ),
        Effect.mapError(databaseError("TransactWriteItems")),
      );
      if (outcome === "reused") return yield* reused(refresh.grantId);
      if (outcome === "revoked") return yield* new RefreshUnusable();
    }, Effect.provide(client)),

    findAccess: Effect.fn("OAuthRepo.findAccess")(function* (hash) {
      const now = yield* DateTime.now;
      const access = Option.filter(
        yield* AccessItem.decodeOption(yield* get(accessKey(hash))),
        isLive(now),
      );
      if (Option.isNone(access)) return access;
      // A revoked grant takes its access tokens with it at once.
      const grant = yield* findGrant(access.value.grantId);
      return Option.isSome(grant) ? access : Option.none();
    }, Effect.provide(client)),

    findGrant: (id) => Effect.provide(findGrant(id), client),

    listGrants: (userId) => Effect.provide(listGrants(userId), client),

    revokeGrant: (id) => Effect.provide(revokeGrant(id), client),

    revokeUserGrant: Effect.fn("OAuthRepo.revokeUserGrant")(function* (userId, grantId) {
      const grant = yield* findGrant(grantId);
      if (Option.isNone(grant) || grant.value.userId !== userId) {
        return yield* new NoSuchGrant({ grantId });
      }
      yield* revokeGrant(grantId);
    }, Effect.provide(client)),

    revokeAccess: (hash) =>
      DynamoDB.deleteItem({ TableName, Key: accessKey(hash) }).pipe(
        Effect.asVoid,
        Effect.mapError(databaseError("DeleteItem")),
        Effect.provide(client),
      ),
  });
});

export const layer = Layer.effect(OAuthRepo, make());
