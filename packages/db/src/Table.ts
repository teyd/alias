import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Retry from "@distilled.cloud/aws/Retry";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import { databaseError } from "./DatabaseError.ts";
import { DynamoTable } from "./Dynamo.ts";

/**
 * Single-table design. This spec is the one source of truth. `infra/alchemy.run.ts` deploys it and
 * the emulators create it with {@link ensure}, so tests run against the table production gets.
 *
 * | Item              | pk                           | sk                     | gsi1pk          | gsi1sk                   | TTL         |
 * | ----------------- | ---------------------------- | ---------------------- | --------------- | ------------------------ | ----------- |
 * | Alias             | `ALIAS#<domain>#<localPart>` | `ALIAS`                | `USER#<userId>` | `ALIAS#<createdAt>#<id>` |             |
 * | ForwardQuota      | `ALIAS#<domain>#<localPart>` | `FORWARDS#<hour>`      |                 |                          | `expiresAt` |
 * | Contact           | `CONTACTS#<aliasId>`         | `CONTACT#<address>`    |                 |                          |             |
 * | ContactId         | `CONTACTS#<aliasId>`         | `CONTACT-ID#<id>`      |                 |                          |             |
 * | User              | `USER#<userId>`              | `USER`                 |                 |                          |             |
 * | UserSettings      | `USER#<userId>`              | `SETTINGS`             |                 |                          |             |
 * | AliasQuota        | `USER#<userId>`              | `ALIASES#<date>`       |                 |                          | `expiresAt` |
 * | Recipient         | `USER#<userId>`              | `RECIPIENT#<address>`  |                 |                          |             |
 * | RecipientSettings | `USER#<userId>`              | `RECIPIENTS`           |                 |                          |             |
 * | MailQuota         | `USER#<userId>`              | `CONFIRMATIONS#<date>` |                 |                          | `expiresAt` |
 * | Username          | `USERNAME#<skeleton>`        | `USERNAME`             |                 |                          |             |
 * | Passkey           | `PASSKEY#<credentialId>`     | `PASSKEY`              |                 |                          |             |
 * | Session           | `SESSION#<sha256(token)>`    | `SESSION`              |                 |                          | `expiresAt` |
 * | Challenge         | `CHALLENGE#<id>`             | `CHALLENGE`            |                 |                          | `expiresAt` |
 * | Delivery          | `DELIVERY#<sesMessageId>`    | `RECIPIENT#<address>`  |                 |                          | `expiresAt` |
 *
 * Access patterns: look up an alias by address (GetItem, strongly consistent) and list a user's
 * aliases (gsi1 Query on the whole `USER#<userId>` partition, so nothing else may use that gsi1pk).
 * A username is unique by its confusable skeleton (`Username.skeleton` in `@alias/core`): the
 * Username item is the claim, written in the same transaction as the User and their first Passkey.
 * Logins look a passkey up by credential ID and a session by the hash of its cookie token.
 * Challenges are deleted when answered (single use).
 *
 * Recipients (forwarding addresses) live in their user's partition: listing them is one strongly
 * consistent Query on `USER#<userId>` with `begins_with(sk, "RECIPIENT#")`, and the address in the
 * sort key makes each address unique per user. A pending recipient also holds the SHA-256 of its
 * mailed confirmation token and the token's expiry; confirming removes both (single use).
 * RecipientSettings counts pending recipients (changed in the same transaction as the recipient,
 * so the cap is atomic) and names the default recipient. MailQuota counts confirmation mails per
 * user and UTC day.
 *
 * A ForwardQuota counts the mail the inbound Lambda forwarded for an alias in one UTC hour
 * (`2026-10-22T09`), next to the alias in its partition; the hourly cap is one conditional
 * UpdateItem on it. It outlives its hour by an hour and is never read after, so a deleted alias
 * leaves nothing behind for long. MailQuota and AliasQuota (aliases created on the fly per user
 * and UTC day) work the same way (`Quota.ts`).
 *
 * A Contact is someone who wrote to an alias, keyed by the alias's id (not its address, so an
 * alias recreated at the same address starts without contacts) and the sender's lowercased
 * address: each forwarded message finds it with one GetItem, and listing an alias's contacts is
 * one Query with `begins_with(sk, "CONTACT#")`. Reverse-alias tokens carry the contact's random
 * id; the ContactId item points from it to the address, written and deleted in the same
 * transaction as the contact, so a reply costs two GetItems and a deleted contact's id finds
 * nothing.
 *
 * UserSettings holds the user's account choices; a user without one has the defaults. The inbound
 * Lambda finds a subdomain's owner through the Username item (exact username, not just the same
 * skeleton) and reads their settings with a second GetItem.
 *
 * A Delivery is the inbound Lambda's idempotency claim: one conditional PutItem per SES message
 * and recipient, written before any mail is sent. A redelivered event finds it and sends nothing
 * again. It carries no content and expires after a week, well past Lambda's 6-hour retry window.
 *
 * `expiresAt` (epoch seconds) is the TTL attribute. TTL deletion runs late and DynamoDB Local
 * doesn't run it at all, so readers must still ignore expired items.
 */
export const spec = {
  partitionKey: "pk",
  sortKey: "sk",
  attributes: { pk: "S", sk: "S", gsi1pk: "S", gsi1sk: "S" },
  globalSecondaryIndexes: [{ indexName: "gsi1", partitionKey: "gsi1pk", sortKey: "gsi1sk" }],
  timeToLiveAttribute: "expiresAt",
} as const;

const createTableInput = (tableName: string): DynamoDB.CreateTableInput => ({
  TableName: tableName,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: Arr.map(R.toEntries(spec.attributes), ([name, type]) => ({
    AttributeName: name,
    AttributeType: type,
  })),
  KeySchema: [
    { AttributeName: spec.partitionKey, KeyType: "HASH" },
    { AttributeName: spec.sortKey, KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: Arr.map(spec.globalSecondaryIndexes, (index) => ({
    IndexName: index.indexName,
    KeySchema: [
      { AttributeName: index.partitionKey, KeyType: "HASH" },
      { AttributeName: index.sortKey, KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "ALL" },
  })),
});

/** Creates the table if it doesn't exist. Emulators and dev only; Alchemy deploys real stages. */
export const ensure = Effect.fn("Table.ensure")(function* () {
  const table = yield* DynamoTable;
  yield* DynamoDB.createTable(createTableInput(table.name)).pipe(
    // The SDK marks ResourceInUseException retryable (it also means "table is updating"), so
    // without this an existing table makes CreateTable retry instead of failing fast.
    Retry.none,
    Effect.asVoid,
    Effect.catchTag("ResourceInUseException", () => Effect.void),
    Effect.mapError(databaseError("CreateTable")),
  );
});
