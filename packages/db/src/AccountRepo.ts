import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as AliasRepo from "./AliasRepo.ts";
import * as Attribute from "./Attribute.ts";
import { type DatabaseError, databaseError } from "./DatabaseError.ts";
import { type Database, DynamoTable } from "./Dynamo.ts";
import * as Item from "./Item.ts";
import { userPasskeysKey } from "./PasskeyRepo.ts";
import * as Purge from "./Purge.ts";
import { sessionKey, userSessionsKey } from "./SessionRepo.ts";
import { userKey, usernameKey } from "./UserRepo.ts";

/** The account to erase, as the signed-in session names it. */
export interface Account {
  readonly userId: string;
  readonly username: string;
  /**
   * The user's own subdomains (`<username>.<shared domain>`). Their aliases leave no tombstone:
   * the username's tombstone already keeps the whole subdomain from anyone else.
   */
  readonly subdomains: ReadonlyArray<string>;
  /** The session asking for erasure. It goes last, so a failed erasure can be retried from it. */
  readonly sessionId: string;
}

export class AccountRepo extends Context.Service<
  AccountRepo,
  {
    /**
     * Erases everything stored about the account (GDPR Art. 17) except two kinds of tombstone:
     * the username's, and one per alias on a shared domain, each holding only the key and
     * `deletedAt`. A resumable sweep, since a user's items don't fit one transaction (100 items):
     * every step is idempotent, and the user item, passkeys and the asking session go last, in
     * one transaction, so a failure anywhere before leaves the account able to sign in and retry.
     * Expects that the caller already took the user's recipient addresses off SES's suppression
     * list. Running it on an erased account changes nothing.
     */
    readonly erase: (account: Account) => Effect.Effect<void, DatabaseError>;
  }
>()("@alias/db/AccountRepo") {}

const LiveAlias = Item.codec(
  Schema.Struct({ domain: Attribute.S, localPart: Attribute.S }),
  "Alias",
);

const Tombstone = Item.codec(
  Schema.Struct({ pk: Attribute.S, id: Schema.OptionFromOptionalKey(Attribute.S) }),
  "Tombstone",
);

/** `ALIAS#<domain>#<localPart>`: domains never contain `#`, local parts may. */
const domainOf = (pk: string) => pk.slice("ALIAS#".length).split("#", 1)[0] ?? "";

const ignoreConditionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchIf(
      (error) => P.isTagged(error, "ConditionalCheckFailedException"),
      () => Effect.void,
    ),
  );

const make = Effect.fn("AccountRepo.make")(function* () {
  const table = yield* DynamoTable;
  const TableName = table.name;

  /**
   * The last step for a purged tombstone of the account: on a subdomain it goes entirely; on a
   * shared domain it loses its owner and its index entry and keeps only the address and
   * `deletedAt`, so nobody can ever claim the address again.
   */
  const forget = (account: Account, key: Purge.Key) => {
    const isOwnSubdomain = Arr.contains(account.subdomains, domainOf(key.pk.S));
    return ignoreConditionFailure(
      isOwnSubdomain
        ? DynamoDB.deleteItem({
            TableName,
            Key: key,
            ConditionExpression: "attribute_exists(deletedAt) AND userId = :userId",
            ExpressionAttributeValues: { ":userId": { S: account.userId } },
          })
        : DynamoDB.updateItem({
            TableName,
            Key: key,
            UpdateExpression: "REMOVE userId, gsi1pk, gsi1sk",
            ConditionExpression: "attribute_exists(deletedAt) AND userId = :userId",
            ExpressionAttributeValues: { ":userId": { S: account.userId } },
          }),
    ).pipe(Effect.mapError(databaseError("ForgetAlias")));
  };

  /** Deletes every alias of the account and finishes the tombstones of earlier deletions. */
  const sweepAliases = Effect.fn("AccountRepo.sweepAliases")(function* (account: Account) {
    const live = yield* Purge.indexItems(table, AliasRepo.userPartition(account.userId));
    yield* Effect.forEach(
      live,
      Effect.fnUntraced(function* (item) {
        const alias = yield* LiveAlias.decode(item);
        const owned = { userId: account.userId, ...alias };
        // Deleted meanwhile: its tombstone is swept below.
        const aliasId = yield* AliasRepo.retire(table, owned).pipe(
          Effect.map(Option.some),
          Effect.catchTag("NoSuchAlias", () => Effect.succeedNone),
        );
        if (Option.isNone(aliasId)) return;
        const key = yield* Purge.keyOf(item);
        yield* AliasRepo.purge(table, key, aliasId.value);
        yield* forget(account, key);
      }),
      { concurrency: 4, discard: true },
    );
    const retired = yield* Purge.indexItems(table, AliasRepo.deletedKey(account.userId));
    yield* Effect.forEach(
      retired,
      Effect.fnUntraced(function* (item) {
        const tombstone = yield* Tombstone.decode(item);
        const key = yield* Purge.keyOf(item);
        if (Option.isSome(tombstone.id)) yield* AliasRepo.purge(table, key, tombstone.id.value);
        yield* forget(account, key);
      }),
      { concurrency: 4, discard: true },
    );
  });

  const erase = Effect.fn("AccountRepo.erase")(function* (account: Account) {
    const current = sessionKey(account.sessionId);
    // 1. Every other session, so no other device acts on the account while it is erased.
    const sessions = yield* Effect.forEach(
      yield* Purge.indexItems(table, userSessionsKey(account.userId)),
      Purge.keyOf,
      { concurrency: "unbounded" },
    );
    yield* Purge.deleteAll(
      table,
      Arr.filter(sessions, (key) => key.pk.S !== current.pk.S),
    );

    // 2. The username becomes a tombstone: no new aliases on the fly, and nobody gets it again.
    const deletedAt = yield* Schema.encodeEffect(Attribute.EpochMillis)(yield* DateTime.now).pipe(
      Effect.mapError(databaseError("EncodeTombstone")),
    );
    yield* ignoreConditionFailure(
      DynamoDB.updateItem({
        TableName,
        Key: usernameKey(account.username),
        UpdateExpression:
          "SET deletedAt = if_not_exists(deletedAt, :deletedAt) REMOVE #userId, #username",
        // Never someone else's claim (a lookalike sharing the skeleton can't exist, but still).
        ConditionExpression: "attribute_not_exists(#userId) OR #userId = :userId",
        ExpressionAttributeNames: { "#userId": "userId", "#username": "username" },
        ExpressionAttributeValues: { ":userId": { S: account.userId }, ":deletedAt": deletedAt },
      }),
    ).pipe(Effect.mapError(databaseError("UpdateItem")));

    // 3. Aliases, their contacts and counters.
    yield* sweepAliases(account);

    // 4. The rest of the user's partition: recipients, settings, quotas.
    const user = userKey(account.userId);
    const owned = yield* Purge.partitionKeys(table, user.pk.S, Option.none());
    yield* Purge.deleteAll(
      table,
      Arr.filter(owned, (key) => key.sk.S !== user.sk.S),
    );

    // 5. The user, their passkeys and this session, at once. A user has a handful of passkeys,
    //    far below the 100 items a transaction takes.
    const passkeys = yield* Effect.forEach(
      yield* Purge.indexItems(table, userPasskeysKey(account.userId)),
      Purge.keyOf,
      { concurrency: "unbounded" },
    );
    yield* DynamoDB.transactWriteItems({
      TransactItems: Arr.map([user, current, ...passkeys], (key) => ({
        Delete: { TableName, Key: key },
      })),
    }).pipe(Effect.mapError(databaseError("TransactWriteItems")));

    // 6. The alias index is eventually consistent: an alias created on the fly an instant before
    //    step 2 may only show up now.
    yield* sweepAliases(account);
  });

  const client = yield* Effect.context<Database>();
  return AccountRepo.of({ erase: (account) => Effect.provide(erase(account), client) });
});

export const layer = Layer.effect(AccountRepo, make());
