import { AwsClient } from "@alias/aws";
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
