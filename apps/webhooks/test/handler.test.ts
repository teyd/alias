import { AwsClient, MessageQueue, SqsEvent } from "@alias/aws";
import documented from "@alias/aws/fixtures/sqs-lambda-event.json" with { type: "json" };
import { FakeCloud } from "@alias/aws-emulators";
import { Table } from "@alias/db";
import { Delivery, WebhookQueue } from "@alias/webhooks";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServicesConfig } from "../src/services.ts";

/**
 * The delivery Lambda's wiring, configured from the environment the way the Lambda is (here
 * pointed at fakecloud), on the AWS-documented SQS event. Its bodies aren't webhook jobs, so
 * every record is dropped and none is reported for retry.
 */
describe("webhook delivery Lambda (handler on fakecloud)", () => {
  it.layer(FakeCloud.layer(), { timeout: 30_000 })((it) => {
    it.effect("builds from its environment and settles the documented event", () =>
      Effect.gen(function* () {
        const { url } = yield* FakeCloud.FakeCloud;
        const { queueUrl } = yield* MessageQueue.ensure("deliveries", WebhookQueue.settings).pipe(
          Effect.provide(AwsClient.emulator(url)),
        );
        const env = {
          ALIAS_TABLE_NAME: "alias",
          AWS_ENDPOINT_URL_DYNAMODB: url,
          AWS_ENDPOINT_URL_SQS: url,
          ALIAS_WEBHOOK_QUEUE_URL: queueUrl,
        };
        const services = yield* ServicesConfig.parse(ConfigProvider.fromEnv({ env }));
        const context = yield* Layer.build(services);
        yield* Table.ensure().pipe(Effect.provide(context));
        const response = yield* SqsEvent.decode(documented).pipe(
          Effect.flatMap(Delivery.handle),
          Effect.provide(context),
        );
        expect(response).toEqual({ batchItemFailures: [] });
      }),
    );
  });
});
