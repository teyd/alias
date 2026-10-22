/**
 * Webhook delivery for `pnpm dev`: the real delivery handler behind the emulated SQS event source
 * mapping (`SqsEventSource` from `@alias/lambda-emulator`), polling the dev webhook queue on the
 * fakecloud that `scripts/dev.ts` starts. The API, the inbound pipeline and the feedback handler
 * publish to the same queue.
 *
 * Dev receivers may listen on `http://localhost` (`ALIAS_WEBHOOK_ALLOW_LOOPBACK`), which
 * production never allows. Endpoint secrets open with the dev webhook keys the API seals them
 * with, from the same fakecloud's SSM.
 */
import { AwsClient, MessageQueue, SqsEvent } from "@alias/aws";
import { Dynamo } from "@alias/db";
import { SqsEventSource } from "@alias/lambda-emulator";
import { Delivery, Egress, Secrets, UrlPolicy, WebhookQueue } from "@alias/webhooks";
import { NodeCrypto, NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

const fakecloudUrl = `http://127.0.0.1:${process.env.ALIAS_FAKECLOUD_PORT ?? 4566}`;
const awsClient = AwsClient.emulator(fakecloudUrl);

const serve = Effect.fn("webhooks.dev")(function* () {
  const { queueUrl } = yield* MessageQueue.ensure(WebhookQueue.devName, WebhookQueue.settings).pipe(
    Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
  );
  const services = Delivery.layer(
    Layer.mergeAll(
      Dynamo.emulator(fakecloudUrl, "alias"),
      MessageQueue.layer(queueUrl).pipe(Layer.provide(awsClient)),
      Delivery.production,
      NodeCrypto.layer,
      Egress.layer,
      Secrets.dev(fakecloudUrl),
    ).pipe(Layer.provideMerge(UrlPolicy.layer({ isLoopbackAllowed: true }))),
  );
  const context = yield* Layer.build(services);
  yield* SqsEventSource.run({
    queueUrl,
    waitSeconds: 1,
    handler: (event) =>
      SqsEvent.decode(event).pipe(Effect.flatMap(Delivery.handle), Effect.provide(context)),
  });
  yield* Effect.logInfo(`webhook delivery polling ${queueUrl}`);
  return yield* Effect.never;
});

NodeRuntime.runMain(serve().pipe(Effect.scoped, Effect.provide(awsClient)));
