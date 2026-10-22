import { AwsClient, Inbound, Objects } from "@alias/aws";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DynamoDbEndpoint, DynamoDbLocal, FakeCloud } from "../src/index.ts";

const dynamoClient = Layer.unwrap(
  Effect.map(Effect.service(DynamoDbEndpoint), (endpoint) => AwsClient.emulator(endpoint.url)),
);

const dynamoRoundTrip = Effect.fn("dynamoRoundTrip")(function* () {
  yield* DynamoDB.createTable({
    TableName: "probe",
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
  });
  yield* DynamoDB.putItem({ TableName: "probe", Item: { pk: { S: "a" }, n: { N: "1" } } });
  const read = yield* DynamoDB.getItem({ TableName: "probe", Key: { pk: { S: "a" } } });
  return read.Item;
});

describe("fakecloud (separate process, port 0)", () => {
  it.layer(dynamoClient.pipe(Layer.provideMerge(FakeCloud.layer())), { timeout: 30_000 })((it) => {
    it.effect("serves DynamoDB to the distilled client", () =>
      Effect.gen(function* () {
        expect(yield* dynamoRoundTrip()).toEqual({ pk: { S: "a" }, n: { N: "1" } });
        expect((yield* DynamoDbEndpoint).engine).toBe("fakecloud");
      }),
    );

    it.effect("serves S3 to the distilled client", () =>
      Effect.gen(function* () {
        yield* S3.createBucket({
          Bucket: "probe",
          CreateBucketConfiguration: { LocationConstraint: "eu-west-1" },
        });
        yield* S3.putObject({ Bucket: "probe", Key: "a", Body: "hello" });
        const read = yield* S3.getObject({ Bucket: "probe", Key: "a" });
        expect(read.ContentLength).toBe(5);
        yield* S3.deleteObject({ Bucket: "probe", Key: "a" });
        const missing = yield* Effect.flip(S3.getObject({ Bucket: "probe", Key: "a" }));
        expect(missing._tag).toBe("NoSuchKey");
      }),
    );

    // AWS documents HeadObject as answering with the object's Content-Length and no body, and a
    // missing key as a bare 404. The pipeline's size check relies on both.
    it.effect("answers HeadObject with the stored size, for the spool's size check", () =>
      Effect.gen(function* () {
        yield* Inbound.ensureSpool("spool");
        const message = new Uint8Array(70_001).fill(0x61);
        message.set(new TextEncoder().encode("Subject: \u00e9\r\n\r\n"));
        yield* S3.putObject({
          Bucket: "spool",
          Key: Inbound.objectKey(Inbound.spoolPrefix, "m1"),
          Body: message,
        });
        const head = yield* S3.headObject({
          Bucket: "spool",
          Key: Inbound.objectKey(Inbound.spoolPrefix, "m1"),
        });
        expect(head.ContentLength).toBe(70_001);
        expect(yield* Inbound.messageSize("spool", "m1")).toBe(70_001);
        expect((yield* Inbound.readMessage("spool", "m1")).byteLength).toBe(70_001);

        const missing = yield* Effect.flip(S3.headObject({ Bucket: "spool", Key: "inbound/m2" }));
        expect(missing._tag).toBe("NotFound");
        expect(yield* Effect.flip(Inbound.messageSize("spool", "m2"))).toEqual(
          new Inbound.MessageGone({ key: "inbound/m2" }),
        );
      }),
    );

    // The inbox store (PLAN.md §20.22) puts, reads, deletes and lists objects by prefix. AWS
    // documents ListObjectsV2 as returning at most `MaxKeys` keys in UTF-8 binary order with
    // `IsTruncated` and a `NextContinuationToken` for the next page, and only keys that start
    // with `Prefix`.
    it.effect("lists keys by prefix across pages, for the inbox store's purge", () =>
      Effect.gen(function* () {
        yield* Objects.ensureBucket("inbox");
        yield* Objects.ensureBucket("inbox");
        const keys = ["inbox/1d/al_a/m3", "inbox/1d/al_a/m1", "inbox/1d/al_a/m2"];
        yield* Effect.forEach(
          [...keys, "inbox/1d/al_ab/m1", "inbox/7d/al_a/m4"],
          (key) => Objects.put("inbox", key, new TextEncoder().encode(key)),
          { concurrency: 1, discard: true },
        );
        const first = yield* S3.listObjectsV2({
          Bucket: "inbox",
          Prefix: "inbox/1d/al_a/",
          MaxKeys: 2,
        });
        expect(first.IsTruncated).toBe(true);
        expect(first.KeyCount).toBe(2);
        expect(first.Contents?.map((object) => object.Key)).toEqual([
          "inbox/1d/al_a/m1",
          "inbox/1d/al_a/m2",
        ]);
        const second = yield* S3.listObjectsV2({
          Bucket: "inbox",
          Prefix: "inbox/1d/al_a/",
          MaxKeys: 2,
          ContinuationToken: first.NextContinuationToken ?? "",
        });
        expect(second.IsTruncated).toBe(false);
        expect(second.Contents?.map((object) => object.Key)).toEqual(["inbox/1d/al_a/m3"]);

        expect(yield* Objects.keys("inbox", "inbox/1d/al_a/")).toEqual([
          "inbox/1d/al_a/m1",
          "inbox/1d/al_a/m2",
          "inbox/1d/al_a/m3",
        ]);
        expect(new TextDecoder().decode(yield* Objects.get("inbox", "inbox/7d/al_a/m4"))).toBe(
          "inbox/7d/al_a/m4",
        );
        yield* Objects.remove("inbox", "inbox/7d/al_a/m4");
        yield* Objects.remove("inbox", "inbox/7d/al_a/m4");
        expect(yield* Effect.flip(Objects.get("inbox", "inbox/7d/al_a/m4"))).toEqual(
          new Objects.NoSuchObject({ key: "inbox/7d/al_a/m4" }),
        );
        expect(yield* Objects.keys("inbox", "inbox/none/")).toEqual([]);
      }),
    );
  });
});

describe("DynamoDB Local (Java)", () => {
  it.layer(dynamoClient.pipe(Layer.provideMerge(DynamoDbLocal.layer())), { timeout: 30_000 })(
    (it) => {
      it.effect("serves DynamoDB to the distilled client", () =>
        Effect.gen(function* () {
          expect(yield* dynamoRoundTrip()).toEqual({ pk: { S: "a" }, n: { N: "1" } });
          expect((yield* DynamoDbEndpoint).engine).toBe("dynamodb-local");
        }),
      );
    },
  );
});
