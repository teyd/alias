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
 * | Item              | pk                           | sk                     | gsi1pk                     | gsi1sk                    | TTL         |
 * | ----------------- | ---------------------------- | ---------------------- | -------------------------- | ------------------------- | ----------- |
 * | Alias             | `ALIAS#<domain>#<localPart>` | `ALIAS`                | `USER#<userId>`            | `ALIAS#<createdAt>#<id>`  |             |
 * | AliasTombstone    | `ALIAS#<domain>#<localPart>` | `ALIAS`                | `DELETED-ALIASES#<userId>` | the item's pk             |             |
 * | ForwardQuota      | `ALIAS#<domain>#<localPart>` | `FORWARDS#<hour>`      |                            |                           | `expiresAt` |
 * | Contact           | `CONTACTS#<aliasId>`         | `CONTACT#<address>`    |                            |                           |             |
 * | Message           | `INBOX#<aliasId>`            | `MESSAGE#<messageId>`  |                            |                           | `expiresAt` |
 * | ContactId         | `CONTACTS#<aliasId>`         | `CONTACT-ID#<id>`      |                            |                           |             |
 * | User              | `USER#<userId>`              | `USER`                 |                            |                           |             |
 * | UserSettings      | `USER#<userId>`              | `SETTINGS`             |                            |                           |             |
 * | AliasQuota        | `USER#<userId>`              | `ALIASES#<date>`       |                            |                           | `expiresAt` |
 * | TemporaryQuota    | `USER#<userId>`              | `TEMP-INBOXES#<date>`  |                            |                           | `expiresAt` |
 * | StorageQuota      | `USER#<userId>`              | `STORED#<date>`        |                            |                           | `expiresAt` |
 * | Recipient         | `USER#<userId>`              | `RECIPIENT#<address>`  |                            |                           |             |
 * | RecipientSettings | `USER#<userId>`              | `RECIPIENTS`           |                            |                           |             |
 * | MailQuota         | `USER#<userId>`              | `CONFIRMATIONS#<date>` |                            |                           | `expiresAt` |
 * | HardBounce        | `USER#<userId>`              | `BOUNCE#<recipientId>#<sesMessageId>` |             |                           | `expiresAt` |
 * | Sent              | `USER#<userId>`              | `SENT#<sesMessageId>`  |                            |                           | `expiresAt` |
 * | Webhook           | `USER#<userId>`              | `WEBHOOK#<id>`         |                            |                           |             |
 * | LabelColor        | `USER#<userId>`              | `LABEL#<label>`        |                            |                           |             |

 * | UsernameEntry     | `USER#<userId>`              | `USERNAME#<username>`  |                            |                           |             |
 * | UsernameCount     | `USER#<userId>`              | `USERNAMES`            |                            |                           |             |
 * | DomainPointer     | `USER#<userId>`              | `DOMAIN#<domain>`      |                            |                           |             |
 * | DomainCount       | `USER#<userId>`              | `DOMAINS`              |                            |                           |             |
 * | Domain            | `DOMAIN#<domain>`            | `DOMAIN`               | `DOMAIN-CHECKS`            | `<nextCheckAt>#<domain>`  |             |
 * | Username          | `USERNAME#<skeleton>`        | `USERNAME`             |                            |                           |             |
 * | Passkey           | `PASSKEY#<credentialId>`     | `PASSKEY`              | `PASSKEYS#<userId>`        | `PASSKEY#<credentialId>`  |             |
 * | Session           | `SESSION#<sha256(token)>`    | `SESSION`              | `SESSIONS#<userId>`        | `SESSION#<sha256(token)>` | `expiresAt` |
 * | Challenge         | `CHALLENGE#<id>`             | `CHALLENGE`            |                            |                           | `expiresAt` |
 * | Delivery          | `DELIVERY#<sesMessageId>`    | `RECIPIENT#<address>`  |                            |                           | `expiresAt` |
 * | TargetDelivery    | `DELIVERY#<sesMessageId>`    | `RECIPIENT#<address>#TO#<recipientId>` |            |                           | `expiresAt` |
 * | Token             | `TOKEN#<sha256(secret)>`     | `TOKEN`                | `TOKENS#<userId>`          | `TOKEN#<id>`              | `expiresAt` |
 * | AuthFailures      | `AUTHFAIL#<sha256(ip)>`      | `FAILURES#<hour>`      |                            |                           | `expiresAt` |
 * | DeviceGrant       | `DEVICE#<sha256(deviceCode)>` | `DEVICE`              |                            |                           | `expiresAt` |
 * | UserCode          | `USERCODE#<userCode>`        | `USERCODE`             |                            |                           | `expiresAt` |
 * | DeviceRequests    | `DEVICEAUTH#<sha256(ip)>`    | `REQUESTS#<hour>`      |                            |                           | `expiresAt` |
 * | DeviceMisses      | `USER#<userId>`              | `DEVICE-MISSES#<hour>` |                            |                           | `expiresAt` |
 * | Challenges        | `AUTHLIMIT#<sha256(ip)>`     | `CHALLENGES#<hour>`    |                            |                           | `expiresAt` |
 * | Signups           | `AUTHLIMIT#<sha256(ip)>`     | `SIGNUPS#<date>`       |                            |                           | `expiresAt` |
 * | AllSignups        | `SIGNUPS`                    | `HOUR#<hour>`          |                            |                           | `expiresAt` |
 * | LoginFailures     | `USER#<userId>`              | `LOGIN-FAILURES#<hour>` |                           |                           | `expiresAt` |
 * | Erasure           | `ERASURE#<sha256(userId)>`   | `ERASURE`              |                            |                           | `expiresAt` |
 * | Draft             | `USER#<userId>`              | `DRAFT#<id>`           |                            |                           | `expiresAt` |
 * | SendQuota         | `USER#<userId>`              | `SENDS#<date>`         |                            |                           | `expiresAt` |
 * | OAuthClient       | `OAUTH-CLIENT#<clientId>`    | `CLIENT`               |                            |                           | `expiresAt` |
 * | Registrations     | `OAUTHREG#<sha256(ip)>`      | `REGISTRATIONS#<hour>` |                            |                           | `expiresAt` |
 * | OAuthCode         | `OAUTH-CODE#<sha256(code)>`  | `CODE`                 | `OAUTH#<userId>`           | `CODE#<sha256(code)>`     | `expiresAt` |
 * | OAuthGrant        | `OAUTH-GRANT#<grantId>`      | `GRANT`                | `OAUTH#<userId>`           | `GRANT#<grantId>`         | `expiresAt` |
 * | OAuthAccess       | `OAUTH-ACCESS#<sha256>`      | `ACCESS`               | `OAUTH#<userId>`           | `ACCESS#<sha256>`         | `expiresAt` |
 * | OAuthRefresh      | `OAUTH-REFRESH#<sha256>`     | `REFRESH`              | `OAUTH#<userId>`           | `REFRESH#<sha256>`        | `expiresAt` |
 * | ProxyOwnerQuota   | `PROXY#USER#<userId>`        | `FETCHES#<minute>`     |                            |                           | `expiresAt` |
 * | ProxyHostQuota    | `PROXY#HOST#<host>`          | `FETCHES#<minute>`     |                            |                           | `expiresAt` |
 * | ProxyHostDown     | `PROXY#HOST#<host>`          | `DOWN`                 |                            |                           | `expiresAt` |
 *
 * Access patterns: look up an alias by address (GetItem, strongly consistent) and list a user's
 * aliases (gsi1 Query on the whole `USER#<userId>` partition, so nothing else may use that gsi1pk).
 * A username is unique by its confusable skeleton (`Username.skeleton` in `@alias/core`): the
 * Username item is the claim, written in the same transaction as the User and their first Passkey.
 * Logins look a passkey up by credential ID and a session by the hash of its cookie token;
 * Settings lists a user's passkeys and sessions on their gsi1 partitions.
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
 * A HardBounce is one of our messages to a recipient that bounced for good without saying the
 * mailbox is gone (PLAN.md §20.28), keyed by the recipient's id (a re-added address starts
 * afresh) and the SES message id (a redelivered bounce counts once). The feedback Lambda writes
 * one, then counts the recipient's recent ones with one Query on `begins_with(sk,
 * "BOUNCE#<recipientId>#")`; they expire after the counting window.
 *
 * A ForwardQuota counts the mail the inbound Lambda forwarded for an alias in one UTC hour
 * (`2026-10-22T09`), next to the alias in its partition; the hourly cap is one conditional
 * UpdateItem on it. It outlives its hour by an hour and is never read after. MailQuota and
 * AliasQuota (aliases created on the fly per user and UTC day) work the same way (`Quota.ts`).
 *
 * The image proxy (PLAN.md §20.29) counts its origin fetches per alias owner and per origin host
 * in one UTC minute (`2026-10-22T09:41`) the same way, and a ProxyHostDown item (`until`, epoch
 * millis) keeps it from asking a host that just timed out or refused to connect. All three live
 * under `PROXY#` partition keys, the only ones the proxy's role may touch.
 *
 * Deleting an alias (PLAN.md §20.15) replaces its item with an AliasTombstone holding only
 * `deletedAt` and the deleting user's `userId`, listed on gsi1 under `DELETED-ALIASES#<userId>`,
 * and purges its contacts and ForwardQuotas. The tombstone keeps the alias's `id` only until that
 * purge is done, so a retry finds what is left. A tombstone keeps the address from anyone but its
 * user, and makes mail to it look like mail to an unknown address. Erasing an account deletes
 * everything of the user's except tombstones: shared-domain AliasTombstones lose `userId` and
 * their index keys, subdomain ones go entirely, and the Username item becomes a tombstone too
 * (`deletedAt`, no owner), so nobody registers the username or its lookalikes again. gsi1 lists a
 * user's passkeys and sessions for that sweep (`AccountRepo.erase`). Its last transaction writes
 * an Erasure journal item, only a hash of the random user ID, expiring a day after the 7-day
 * point-in-time recovery window, so erasures can be re-applied after a restore.
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
 * Additional usernames (PLAN.md §20.34) claim their skeleton with a Username item like the
 * sign-up's, marked `isAdditional`, written in one transaction with the user's UsernameEntry
 * (the username's own settings: on the fly, default recipient; listing them is one strongly
 * consistent Query on `begins_with(sk, "USERNAME#")`) and UsernameCount (the per-user cap, atomic).
 * For an additional username, the inbound Lambda's second GetItem reads its UsernameEntry instead
 * of the user's settings. Deleting one turns its Username item into a tombstone first, like
 * erasure does, and removes the entry last, so a deletion that failed halfway is retried from it.
 *
 * A Domain is a custom domain (PLAN.md §20.18), keyed by its lowercased name, so one claim exists
 * per domain across all users and the inbound Lambda resolves it with one GetItem. It is written
 * in one transaction with the owner's DomainPointer (listing a user's domains is one Query plus a
 * GetItem each) and DomainCount (the per-user cap, atomic). Every domain shares the gsi1
 * partition `DOMAIN-CHECKS`, sorted by when the verification cron should look at it next
 * (zero-padded epoch millis), so the cron finds due domains with one Query.
 *
 * A Message is the metadata of mail stored for an inbox alias (PLAN.md §20.22), keyed by the
 * alias's id like contacts: listing an inbox is one Query on `INBOX#<aliasId>`, newest first, and
 * a long poll asks for ids after the last one seen (ids are ULIDs, so they sort by time). The
 * body is encrypted in S3; the item holds its wrapped data key and the encrypted summary, so
 * deleting the item (or purging the partition with the alias) leaves the body unreadable.
 * `expiresAt` is the message's retention; readers ignore it from then on. A temporary inbox is an
 * alias with `inboxExpiresAt`, deliberately not the TTL attribute: the alias item stays after it
 * expires, so the address is never handed out again. TemporaryQuota and StorageQuota count
 * temporary inboxes created and messages stored per user and UTC day.
 *
 * A Delivery is the inbound Lambda's idempotency claim: one conditional PutItem per SES message
 * and recipient, written before any mail is sent. A redelivered event finds it and sends nothing
 * again. It carries no content and expires after a week, well past Lambda's 6-hour retry window.
 * An alias that forwards to several of its owner's recipients (PLAN.md §20.31) also claims each
 * copy as a TargetDelivery before sending it, so a retry after one copy failed for now sends only
 * the copies still missing.
 *
 * An alias item may carry the owner's `description`, `labels` and `recipientIds` (lists, left out
 * when empty). The forward path reads the user's recipients with one Query anyway, so choosing
 * recipients per alias costs no read. A LabelColor is a colour the user gave one of their labels;
 * listing them is one Query on `begins_with(sk, "LABEL#")`, and a label without one has no item.
 *
 * A Sent item traces a bounce to the message it is about (PLAN.md §20.28): one PutItem after
 * each SES send, in the sender's partition under the ID SES returned, naming the kind of mail and
 * the recipient it went to (by id, never the address). The feedback Lambda reads it with one
 * GetItem, keyed by the event's `alias-user` tag and `mail.messageId`. No content; it expires
 * after a week, and erasing the account removes it with the partition.
 *
 * A Token is a personal API token (PLAN.md §20.20), stored under the SHA-256 of its secret, so a
 * bearer request costs one strongly consistent GetItem and a table dump yields no usable token.
 * Listing a user's tokens is a gsi1 Query on `TOKENS#<userId>` (eventually consistent, like the
 * alias list); revoking deletes the item by its key. An expiring token carries `expiresAt`, so TTL
 * removes it later. AuthFailures counts failed token attempts per hashed client address and UTC
 * hour, like the other quota items.
 *
 * The OAuth authorization server (PLAN.md §20.24) keeps a dynamically registered client by its
 * id, and an authorization code, access token and refresh token by the SHA-256 of its secret, so
 * each token request or authenticated MCP call reads them with GetItem. A Grant is one client's
 * access to one user's account; redeeming a code writes the grant and its first tokens in one
 * transaction that also marks the code redeemed, and a refresh writes the next tokens in one that
 * marks the old refresh token used. An access token authenticates only while its grant exists
 * (a second GetItem), so deleting the grant revokes everything it issued at once; the tokens
 * themselves are then deleted through the gsi1 partition `OAUTH#<userId>`, which lists a user's
 * grants (`begins_with(gsi1sk, "GRANT#")`), codes and tokens, and which erasing the account
 * empties.
 * Registrations counts client registrations per hashed client address and UTC hour.
 *
 * A Draft is mail an MCP client drafted, waiting in its user's partition for the user to send or
 * discard it in the web app (one GetItem to show it); leaving `pending` is one conditional
 * UpdateItem, so a draft goes out at most once. SendQuota counts sent drafts per user and UTC day
 * like the other quotas. Erasing the account deletes both with the rest of the partition.
 *
 * A Webhook is one of the user's webhook endpoints, in their partition: every published event
 * lists the user's webhooks with one strongly consistent Query (`begins_with(sk, "WEBHOOK#")`),
 * and a delivery reads its endpoint (URL, secrets) with one GetItem.
 *
 * A DeviceGrant is a device login in progress (OAuth 2.0 device authorization grant, PLAN.md
 * §20.23), stored under the SHA-256 of its device code, so each poll costs one strongly
 * consistent GetItem. The UserCode item points from the code a person types to it; both are
 * written in one transaction (a taken code fails it) and deleted together when the grant is
 * redeemed, in the same transaction that creates the token. DeviceRequests counts device
 * authorization requests per hashed client address and hour; DeviceMisses counts unknown user
 * codes a signed-in user tried, in their partition so erasing the account removes it.
 *
 * Sign-up and login limits (PLAN.md §20.27) are `Quota` counters too: Challenges (WebAuthn
 * challenges per hashed client address and hour), Signups (accounts per address and day),
 * AllSignups (accounts per hour for everyone, the circuit breaker; one hot item, written once per
 * sign-up) and LoginFailures (failed passkey assertions per account and hour, in the user's
 * partition like DeviceMisses).
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
