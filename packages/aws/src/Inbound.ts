import * as S3 from "@distilled.cloud/aws/s3";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { region } from "./Client.ts";

/**
 * Where SES receiving puts mail. `infra/alchemy.run.ts`, the SES emulator and the inbound Lambda
 * share it so the three can't drift.
 *
 * An S3 receipt action stores the raw message at `objectKeyPrefix + messageId`; the Lambda event
 * carries the message ID but not the body.
 * https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html
 */
export const spoolPrefix = "inbound/";

export const objectKey = (objectKeyPrefix: string, messageId: string): string =>
  `${objectKeyPrefix}${messageId}`;

const spoolObjectKey = (messageId: string): string => objectKey(spoolPrefix, messageId);

export class SpoolError extends Schema.TaggedError<SpoolError>()("SpoolError", {
  key: Schema.String,
  reason: Schema.String,
}) {}

/**
 * The spool holds no message under this ID: an earlier run processed and deleted it, or the
 * 1-day lifecycle rule expired it. Retrying can't bring it back.
 */
export class MessageGone extends Schema.TaggedError<MessageGone>()("MessageGone", {
  key: Schema.String,
}) {}

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = Arr.reduce(chunks, 0, (size, chunk) => size + chunk.byteLength);
  const bytes = new Uint8Array(total);
  Arr.reduce(chunks, 0, (offset, chunk) => {
    bytes.set(chunk, offset);
    return offset + chunk.byteLength;
  });
  return bytes;
};

/** The raw RFC 5322 message SES stored for `messageId`, byte for byte. */
export const readMessage = Effect.fn("Inbound.readMessage")(function* (
  bucket: string,
  messageId: string,
) {
  const key = spoolObjectKey(messageId);
  const fail = (cause: unknown) => new SpoolError({ key, reason: String(cause) });
  const object = yield* S3.getObject({ Bucket: bucket, Key: key }).pipe(
    Effect.mapError((error) =>
      P.isTagged(error, "NoSuchKey") ? new MessageGone({ key }) : fail(error),
    ),
  );
  const chunks = yield* Option.match(Option.fromUndefinedOr(object.Body), {
    onNone: () => Effect.succeed<ReadonlyArray<Uint8Array>>([]),
    onSome: (body) => Stream.runCollect(body).pipe(Effect.mapError(fail)),
  });
  return concat(chunks);
});

/**
 * The stored message's size in bytes, from S3 `HeadObject` (`Content-Length`), without reading
 * it. The SES Lambda event carries no size, so this is how the pipeline refuses oversized mail
 * before it loads the body into memory. A missing object is `MessageGone`: `HeadObject` answers
 * 404 with no body, which the SDK reports as `NotFound` rather than `NoSuchKey`.
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
 */
export const messageSize = Effect.fn("Inbound.messageSize")(function* (
  bucket: string,
  messageId: string,
) {
  const key = spoolObjectKey(messageId);
  const head = yield* S3.headObject({ Bucket: bucket, Key: key }).pipe(
    Effect.mapError((error) =>
      P.isTagged(error, "NotFound")
        ? new MessageGone({ key })
        : new SpoolError({ key, reason: String(error) }),
    ),
  );
  return yield* Option.match(Option.fromUndefinedOr(head.ContentLength), {
    onNone: () => Effect.fail(new SpoolError({ key, reason: "HeadObject returned no size" })),
    onSome: Effect.succeed,
  });
});

/**
 * Removes the stored message once it is processed, so forward-only mail leaves no content behind
 * (PLAN.md §3.4). Deleting a message that is already gone succeeds, as S3 `DeleteObject` does.
 */
export const deleteMessage = Effect.fn("Inbound.deleteMessage")(function* (
  bucket: string,
  messageId: string,
) {
  const key = spoolObjectKey(messageId);
  yield* S3.deleteObject({ Bucket: bucket, Key: key }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new SpoolError({ key, reason: String(cause) })),
  );
});

/** Creates the spool bucket if it doesn't exist. Emulators and dev only; Alchemy deploys real stages. */
export const ensureSpool = Effect.fn("Inbound.ensureSpool")(function* (bucket: string) {
  yield* S3.createBucket({
    Bucket: bucket,
    CreateBucketConfiguration: { LocationConstraint: region },
  }).pipe(
    Effect.asVoid,
    Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
    Effect.mapError((cause) => new SpoolError({ key: bucket, reason: String(cause) })),
  );
});
