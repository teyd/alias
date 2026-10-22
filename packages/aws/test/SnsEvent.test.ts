import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import event from "../fixtures/sns-lambda-event.json" with { type: "json" };
import { SnsEvent } from "../src/index.ts";

describe("SnsEvent (contract: AWS documentation payload)", () => {
  it.effect("decodes the documented SNS event for Lambda", () =>
    Effect.gen(function* () {
      const decoded = yield* SnsEvent.decode(event);
      const record = decoded.Records[0];
      expect(record?.EventSource).toBe("aws:sns");
      expect(record?.Sns.Message).toBe("Hello from SNS!");
      expect(record?.Sns.TopicArn).toBe("arn:aws:sns:us-east-1:123456789012:sns-lambda");
    }),
  );

  it.effect("fails typed on anything else", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(SnsEvent.decode({ Records: [{ EventSource: "aws:sqs" }] }));
      expect(error._tag).toBe("InvalidSnsEvent");
    }),
  );
});
