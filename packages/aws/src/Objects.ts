import * as S3 from "@distilled.cloud/aws/s3";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { region } from "./Client.ts";

/**
 * Whole-object S3 access, as the spool (`Inbound`) and the inbox store use it: put, get, delete
 * and list keys under a prefix. Objects are small enough to hold in memory (mail, at most tens of
 * megabytes).
 */

/** S3 couldn't do it now, or refused. Never carries object content. */
class ObjectError extends Schema.TaggedError<ObjectError>()("ObjectError", {
  key: Schema.String,
  reason: Schema.String,
}) {}

/** No object under this key (`NoSuchKey`). */
export class NoSuchObject extends Schema.TaggedError<NoSuchObject>()("NoSuchObject", {
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

export const get = Effect.fn("Objects.get")(function* (bucket: string, key: string) {
  const fail = (cause: unknown) => new ObjectError({ key, reason: String(cause) });
  const object = yield* S3.getObject({ Bucket: bucket, Key: key }).pipe(
    Effect.mapError((error) =>
      P.isTagged(error, "NoSuchKey") ? new NoSuchObject({ key }) : fail(error),
    ),
  );
  const chunks = yield* Option.match(Option.fromUndefinedOr(object.Body), {
    onNone: () => Effect.succeed<ReadonlyArray<Uint8Array>>([]),
    onSome: (body) => Stream.runCollect(body).pipe(Effect.mapError(fail)),
  });
  return concat(chunks);
});

export const put = Effect.fn("Objects.put")(function* (
  bucket: string,
  key: string,
  body: Uint8Array,
) {
  yield* S3.putObject({ Bucket: bucket, Key: key, Body: body }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new ObjectError({ key, reason: String(cause) })),
  );
});

/** Deleting an object that is already gone succeeds, as S3 `DeleteObject` does. */
export const remove = Effect.fn("Objects.remove")(function* (bucket: string, key: string) {
  yield* S3.deleteObject({ Bucket: bucket, Key: key }).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new ObjectError({ key, reason: String(cause) })),
  );
});

/** Every key under `prefix`, across as many `ListObjectsV2` pages as there are. */
export const keys = Effect.fn("Objects.keys")(function* (bucket: string, prefix: string) {
  return yield* S3.listObjectsV2.pages({ Bucket: bucket, Prefix: prefix }).pipe(
    Stream.flatMap((page) =>
      Stream.fromIterable(
        Arr.getSomes(Arr.map(page.Contents ?? [], (object) => Option.fromUndefinedOr(object.Key))),
      ),
    ),
    Stream.runCollect,
    Effect.mapError((cause) => new ObjectError({ key: prefix, reason: String(cause) })),
  );
});

/** Creates the bucket if it doesn't exist. Emulators and dev only; Alchemy deploys real stages. */
export const ensureBucket = Effect.fn("Objects.ensureBucket")(function* (bucket: string) {
  yield* S3.createBucket({
    Bucket: bucket,
    CreateBucketConfiguration: { LocationConstraint: region },
  }).pipe(
    Effect.asVoid,
    Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
    Effect.mapError((cause) => new ObjectError({ key: bucket, reason: String(cause) })),
  );
});
