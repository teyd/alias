import { AwsClient, MessageQueue } from "@alias/aws";
import { FakeCloud } from "@alias/aws-emulators";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The queue a test publishes to, and its dead-letter queue. */
export class TestQueue extends Context.Service<
  TestQueue,
  { readonly queueUrl: string; readonly dlqUrl: string }
>()("@alias/webhooks/testing/TestQueue") {}

let queues = 0;

/**
 * A fresh webhook queue on the test's fakecloud, shaped like production's: a dead-letter queue
 * after `maxReceiveCount` receives. Provides `MessageQueue` on it.
 */
export const freshQueue = (maxReceiveCount = 8) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { url } = yield* FakeCloud.FakeCloud;
      const client = AwsClient.emulator(url);
      queues += 1;
      const urls = yield* MessageQueue.ensure(`webhooks-${queues}`, {
        maxReceiveCount,
        visibilityTimeoutSeconds: 180,
      }).pipe(Effect.provide(client), Effect.orDie);
      return Layer.merge(
        Layer.succeed(TestQueue, urls),
        MessageQueue.layer(urls.queueUrl).pipe(Layer.provide(client)),
      );
    }),
  );
