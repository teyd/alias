import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import batchResponse from "../fixtures/sqs-batch-response.json" with { type: "json" };
import event from "../fixtures/sqs-lambda-event.json" with { type: "json" };
import { SqsEvent } from "../src/index.ts";

describe("SqsEvent (contract: AWS documentation payloads)", () => {
  it.effect("decodes the documented SQS event for Lambda", () =>
    Effect.gen(function* () {
      const decoded = yield* SqsEvent.decode(event);
      expect(decoded.Records).toHaveLength(2);
      expect(decoded.Records[0]).toMatchObject({
        messageId: "059f36b4-87a3-44ab-83d2-661975830a7d",
        body: "Test message.",
        attributes: { ApproximateReceiveCount: 1 },
        eventSourceARN: "arn:aws:sqs:us-east-2:123456789012:my-queue",
      });
    }),
  );

  it("has the documented partial batch response shape", () => {
    const response: SqsEvent.BatchResponse = batchResponse;
    expect(response.batchItemFailures.map((failure) => failure.itemIdentifier)).toEqual([
      "id2",
      "id4",
    ]);
  });

  it.effect("fails typed on anything else", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(SqsEvent.decode({ Records: [{ eventSource: "aws:sns" }] }));
      expect(error._tag).toBe("InvalidSqsEvent");
    }),
  );
});
