import { AwsClient, Objects, Parameters } from "@alias/aws";
import {
  DEFAULT_RETENTION_DAYS,
  type MessageSummary,
  type MessageView,
  RetentionDays,
} from "@alias/contracts";
import { type Keyring, Message, Seal, Verification } from "@alias/core";
import { type AliasRepo, type Dynamo, MessageRepo } from "@alias/db";
import { NodeCrypto } from "@effect/platform-node";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SSM from "@distilled.cloud/aws/ssm";
import * as Envelope from "./Envelope.ts";
import { sanitize } from "./Sanitize.ts";

/**
 * Stored mail for inbox aliases and temporary inboxes (PLAN.md §20.22.2). The inbound Lambda
 * stores; the API lists, reads and deletes. Bodies are sealed (`Envelope`) in S3 under
 * `inbox/<retention>d/<aliasId>/<messageId>`, so one lifecycle rule per retention class expires
 * them; their wrapped data keys and sealed summaries live in DynamoDB (`MessageRepo`), whose TTL
 * matches. Without the metadata item a body can't be decrypted, so deleting it is deleting the
 * message; the object goes too, right after.
 */

/** The keyring that wraps the messages' data keys. */
export class InboxKeys extends Context.Service<InboxKeys, Keyring.Keyring>()(
  "@alias/inbox/InboxKeys",
) {}

/** S3, DynamoDB or the keys failed now; worth trying again. Never carries content. */
export class InboxUnavailable extends Schema.TaggedError<InboxUnavailable>()("InboxUnavailable", {
  reason: Schema.String,
}) {}

const PREFIX = "inbox/";

/** One prefix per retention class: S3 lifecycle rules match prefixes. */
export const classPrefix = (days: RetentionDays) => `${PREFIX}${days}d/`;

const objectKey = (days: RetentionDays, aliasId: string, messageId: string) =>
  `${classPrefix(days)}${aliasId}/${messageId}`;

/**
 * How long the alias keeps mail: the owner's choice, one day on a temporary inbox, else the
 * default.
 */
export const retentionOf = (alias: AliasRepo.Alias): RetentionDays =>
  Option.getOrElse(
    Option.flatMap(alias.retentionDays, Schema.decodeUnknownOption(RetentionDays)),
    () => (Option.isSome(alias.inboxExpiresAt) ? 1 : DEFAULT_RETENTION_DAYS),
  );

/** The summary, sealed next to the data key so a list needs no S3 read. */
const Summary = Schema.Struct({
  from: Schema.OptionFromOptionalKey(Schema.String),
  subject: Schema.OptionFromOptionalKey(Schema.String),
  preview: Schema.String,
  code: Schema.OptionFromOptionalKey(Schema.String),
  link: Schema.OptionFromOptionalKey(Schema.String),
  attachmentCount: Schema.Number,
});
type Summary = typeof Summary.Type;
const SummaryJson = Schema.fromJsonString(Summary);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Bytes that are no message: dropping them is all one can do. */
export class UnreadableMessage extends Schema.TaggedError<UnreadableMessage>()(
  "UnreadableMessage",
  {},
) {}

/** Any storage, key or crypto failure, named by its tag and reason only. */
const unavailable = (error: { readonly _tag: string }) =>
  new InboxUnavailable({
    reason: `${error._tag}${P.hasProperty(error, "reason") ? `: ${String(error.reason)}` : ""}`,
  });

export interface Stored {
  readonly messageId: string;
  readonly found: Verification.Found;
}

/** A failed delivery's sealed copy, as `FailureRepo` stores it (PLAN.md §20.33). */
export interface KeptBody {
  readonly objectKey: string;
  readonly keyVersion: number;
  readonly wrappedKey: Uint8Array;
}

/** Failed deliveries are kept a week: the 7-day class, whose lifecycle rule removes them. */
const KEPT_DAYS = 7;

export class Inbox extends Context.Service<
  Inbox,
  {
    /**
     * Seals and stores a message for the alias, with what the extractor found. Fails with
     * `NoSuchAlias` when the alias was deleted meanwhile (nothing is left behind), and with
     * `UnreadableMessage` for bytes that are no message.
     */
    readonly store: (
      alias: AliasRepo.Alias,
      raw: Uint8Array,
    ) => Effect.Effect<Stored, AliasRepo.NoSuchAlias | InboxUnavailable | UnreadableMessage>;
    /** Newest first, decrypted summaries only. */
    readonly list: (
      aliasId: string,
      page: MessageRepo.Page,
    ) => Effect.Effect<ReadonlyArray<MessageSummary>, InboxUnavailable>;
    /** The whole message, decrypted, its HTML sanitized. None when missing or expired. */
    readonly read: (
      aliasId: string,
      messageId: string,
    ) => Effect.Effect<Option.Option<MessageView>, InboxUnavailable>;
    /** False when there was no such message. */
    readonly remove: (
      aliasId: string,
      messageId: string,
    ) => Effect.Effect<boolean, InboxUnavailable>;
    /**
     * Deletes every stored body of the alias, in every retention class. For deleted aliases and
     * erased accounts, after their metadata is gone (`AliasRepo.delete` purges it).
     */
    readonly purge: (aliasId: string) => Effect.Effect<void, InboxUnavailable>;
    /**
     * Seals and stores the copy of a message that couldn't be forwarded (PLAN.md §20.33), under
     * the alias's 7-day class, so `purge` takes it with the alias. Its metadata, with the wrapped
     * key, is the caller's to record.
     */
    readonly keep: (
      alias: AliasRepo.Alias,
      failureId: string,
      raw: Uint8Array,
    ) => Effect.Effect<KeptBody, InboxUnavailable>;
    /** The kept copy, opened. */
    readonly retrieve: (
      aliasId: string,
      failureId: string,
      kept: KeptBody,
    ) => Effect.Effect<Uint8Array, InboxUnavailable>;
    /** Deletes a kept copy's object; deleting one that is gone succeeds. */
    readonly discard: (objectKey: string) => Effect.Effect<void, InboxUnavailable>;
  }
>()("@alias/inbox/Inbox") {}

const make = Effect.fn("Inbox.make")(function* (bucket: string) {
  const keys = yield* InboxKeys;
  const repo = yield* MessageRepo.MessageRepo;
  const services = yield* Effect.context<AwsClient.AwsClient | Crypto.Crypto>();

  const toView = (stored: MessageRepo.StoredMessage, summary: Summary): MessageSummary => ({
    id: stored.id,
    receivedAt: stored.receivedAt,
    expiresAt: stored.expiresAt,
    size: stored.size,
    ...summary,
  });

  const openSummary = Effect.fn("Inbox.openSummary")(function* (stored: MessageRepo.StoredMessage) {
    const context = { aliasId: stored.aliasId, messageId: stored.id };
    const dataKey = yield* Envelope.unwrap(keys, context, stored);
    const bytes = yield* Envelope.openPart(dataKey, context, "summary", stored.summary);
    const summary = yield* Schema.decodeUnknownEffect(SummaryJson)(decoder.decode(bytes)).pipe(
      Effect.mapError(() => new Seal.SealError({ reason: "summary does not decode" })),
    );
    return { dataKey, summary };
  });

  const store = Effect.fn("Inbox.store")(function* (alias: AliasRepo.Alias, raw: Uint8Array) {
    const content = yield* Message.read(raw).pipe(Effect.mapError(() => new UnreadableMessage()));
    const found = Verification.extract(content);
    const summary: Summary = {
      from: content.from,
      subject: content.subject,
      preview: Message.preview(content),
      code: found.code,
      link: found.link,
      attachmentCount: content.attachments.length,
    };
    const ulid = yield* (yield* Crypto.Crypto).randomULID.pipe(Effect.mapError(unavailable));
    const messageId = `msg_${ulid.toLowerCase()}`;
    const days = retentionOf(alias);
    const key = objectKey(days, alias.id, messageId);
    const context = { aliasId: alias.id, messageId };
    const sealed = yield* Envelope.sealMessage(keys, context, {
      body: raw,
      summary: encoder.encode(yield* Effect.orDie(Schema.encodeEffect(SummaryJson)(summary))),
    }).pipe(Effect.mapError(unavailable));
    yield* Objects.put(bucket, key, sealed.body).pipe(Effect.mapError(unavailable));
    const receivedAt = yield* DateTime.now;
    yield* repo
      .insert(
        {
          id: messageId,
          aliasId: alias.id,
          userId: alias.userId,
          receivedAt,
          expiresAt: DateTime.add(receivedAt, { days }),
          size: raw.byteLength,
          objectKey: key,
          keyVersion: sealed.keyVersion,
          wrappedKey: sealed.wrappedKey,
          summary: sealed.summary,
        },
        alias,
      )
      .pipe(
        Effect.catchTag("DatabaseError", (error) => Effect.fail(unavailable(error))),
        // The alias is gone: so is the body, best effort (it can't be decrypted anyway).
        Effect.tapError(() => Effect.ignore(Objects.remove(bucket, key))),
      );
    const stored: Stored = { messageId, found };
    return stored;
  });

  const list = Effect.fn("Inbox.list")(function* (aliasId: string, page: MessageRepo.Page) {
    const stored = yield* repo.list(aliasId, page).pipe(Effect.mapError(unavailable));
    return yield* Effect.forEach(
      stored,
      (message) => Effect.map(openSummary(message), ({ summary }) => toView(message, summary)),
      { concurrency: 8 },
    ).pipe(Effect.mapError(unavailable));
  });

  const read = Effect.fn("Inbox.read")(function* (aliasId: string, messageId: string) {
    const found = yield* repo.find(aliasId, messageId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(found)) return Option.none<MessageView>();
    const stored = found.value;
    const { dataKey, summary } = yield* openSummary(stored).pipe(Effect.mapError(unavailable));
    const sealedBody = yield* Objects.get(bucket, stored.objectKey).pipe(
      Effect.mapError(unavailable),
    );
    const body = yield* Envelope.openPart(dataKey, { aliasId, messageId }, "body", sealedBody).pipe(
      Effect.mapError(unavailable),
    );
    const content = yield* Message.read(body).pipe(
      Effect.mapError(() => new InboxUnavailable({ reason: "stored body does not parse" })),
    );
    const html = Option.map(content.html, sanitize);
    const view: MessageView = {
      ...toView(stored, summary),
      to: content.to,
      date: content.date,
      text: content.text,
      html: Option.map(html, (sanitized) => sanitized.html),
      attachments: content.attachments,
      blockedImageCount: Option.match(html, {
        onNone: () => 0,
        onSome: (sanitized) => sanitized.blockedImageCount,
      }),
    };
    return Option.some(view);
  });

  const remove = Effect.fn("Inbox.remove")(function* (aliasId: string, messageId: string) {
    const deleted = yield* repo.delete(aliasId, messageId).pipe(Effect.mapError(unavailable));
    if (Option.isNone(deleted)) return false;
    yield* Objects.remove(bucket, deleted.value.objectKey).pipe(Effect.mapError(unavailable));
    return true;
  });

  const purge = Effect.fn("Inbox.purge")(function* (aliasId: string) {
    const keysToDelete = yield* Effect.forEach(
      RetentionDays.literals,
      (days) => Objects.keys(bucket, `${classPrefix(days)}${aliasId}/`),
      { concurrency: 3 },
    ).pipe(Effect.map(Arr.flatten), Effect.mapError(unavailable));
    yield* Effect.forEach(keysToDelete, (key) => Objects.remove(bucket, key), {
      concurrency: 8,
      discard: true,
    }).pipe(Effect.mapError(unavailable));
  });

  const keep = Effect.fn("Inbox.keep")(function* (
    alias: AliasRepo.Alias,
    failureId: string,
    raw: Uint8Array,
  ) {
    const key = objectKey(KEPT_DAYS, alias.id, failureId);
    const sealed = yield* Envelope.sealBody(
      keys,
      { aliasId: alias.id, messageId: failureId },
      raw,
    ).pipe(Effect.mapError(unavailable));
    yield* Objects.put(bucket, key, sealed.body).pipe(Effect.mapError(unavailable));
    const kept: KeptBody = {
      objectKey: key,
      keyVersion: sealed.keyVersion,
      wrappedKey: sealed.wrappedKey,
    };
    return kept;
  });

  const retrieve = Effect.fn("Inbox.retrieve")(function* (
    aliasId: string,
    failureId: string,
    kept: KeptBody,
  ) {
    const context = { aliasId, messageId: failureId };
    const dataKey = yield* Envelope.unwrap(keys, context, kept).pipe(Effect.mapError(unavailable));
    const sealedBody = yield* Objects.get(bucket, kept.objectKey).pipe(
      Effect.mapError(unavailable),
    );
    return yield* Envelope.openPart(dataKey, context, "body", sealedBody).pipe(
      Effect.mapError(unavailable),
    );
  });

  return Inbox.of({
    keep: (alias, failureId, raw) => Effect.provide(keep(alias, failureId, raw), services),
    retrieve: (aliasId, failureId, kept) =>
      Effect.provide(retrieve(aliasId, failureId, kept), services),
    discard: (key) =>
      Effect.provide(Objects.remove(bucket, key).pipe(Effect.mapError(unavailable)), services),
    store: (alias, raw) => Effect.provide(store(alias, raw), services),
    list: (aliasId, page) => Effect.provide(list(aliasId, page), services),
    read: (aliasId, messageId) => Effect.provide(read(aliasId, messageId), services),
    remove: (aliasId, messageId) => Effect.provide(remove(aliasId, messageId), services),
    purge: (aliasId) => Effect.provide(purge(aliasId), services),
  });
});

/** The store on `bucket`, with the keys, the table and an AWS client from context. */
export const layer = (bucket: string) => Layer.effect(Inbox, make(bucket));

/**
 * `ALIAS_INBOX_BUCKET` and `ALIAS_INBOX_KEYS_PARAMETER` (the SSM `SecureString` holding the inbox
 * keys: `<version>:<base64url secret>` entries, the first one wrapping; `Parameters.keyring`), and
 * `AWS_ENDPOINT_URL_S3` only in emulated runs. Turn it into the store with {@link fromConfig}.
 */
export const config = Config.all({
  bucket: Config.String("ALIAS_INBOX_BUCKET"),
  endpoint: Config.option(Config.String("AWS_ENDPOINT_URL_S3")),
  keys: Parameters.keyringConfig("ALIAS_INBOX_KEYS_PARAMETER"),
});

/** The store from {@link config}, on the given table. Building it reads the keys (cold start). */
export const fromConfig = <E, R>(
  settings: Config.Success<typeof config>,
  database: Layer.Layer<Dynamo.Database, E, R>,
) =>
  layer(settings.bucket).pipe(
    Layer.provide(Layer.effect(InboxKeys, settings.keys)),
    Layer.provide(MessageRepo.layer.pipe(Layer.provide(database))),
    Layer.provide(
      Layer.merge(
        AwsClient.layer({ region: AwsClient.region, endpoint: settings.endpoint }),
        NodeCrypto.layer,
      ),
    ),
  );

const DEV_KEYS = "1:ZGV2LW9ubHktaW5ib3gta2V5LW5vdC1hLXNlY3JldC0xMjM";
const DEV_KEYS_PARAMETER = "/alias/dev/inbox-keys";
const DEV_BUCKET = "alias-inbox";

/**
 * The store for `pnpm dev` on fakecloud at `url`, shared by the API and the inbound Lambda: the
 * bucket `alias-inbox`, and the fixed dev keys put into fakecloud's SSM as `/alias/dev/inbox-keys`
 * unless that parameter exists, then read back the way the Lambdas read theirs. Anyone with this
 * repo knows the dev key: never use it anywhere real.
 */
export const dev = (url: string, database: Layer.Layer<Dynamo.Database>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      yield* SSM.putParameter({
        Name: DEV_KEYS_PARAMETER,
        Type: "SecureString",
        Value: DEV_KEYS,
      }).pipe(Effect.catchTag("ParameterAlreadyExists", () => Effect.void));
      yield* Objects.ensureBucket(DEV_BUCKET);
      return fromConfig(
        {
          bucket: DEV_BUCKET,
          endpoint: Option.some(url),
          keys: Parameters.keyring(DEV_KEYS_PARAMETER).pipe(
            Effect.provide(AwsClient.emulator(url)),
          ),
        },
        database,
      );
    }).pipe(
      // fakecloud starts alongside.
      Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
      Effect.provide(AwsClient.emulator(url)),
    ),
  );
