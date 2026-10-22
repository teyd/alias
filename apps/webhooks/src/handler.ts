/** Lambda entrypoint (SQS event source mapping of the webhook queue). Configured from the environment. */
import { type LambdaHandler, SqsEvent } from "@alias/aws";
import { Delivery } from "@alias/webhooks";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { ServicesConfig } from "./services.ts";

const runtime = ManagedRuntime.make(Effect.runSync(ServicesConfig));

/**
 * @public Alchemy bundles it as the webhook delivery Lambda. The mapping has
 * `ReportBatchItemFailures` on: records listed in the response are retried after the backoff
 * `Delivery` set, the rest are deleted. An event that doesn't parse fails the batch, so its
 * messages come back and, if they never parse, end in the dead-letter queue.
 */
export default ((event) =>
  runtime.runPromise(
    SqsEvent.decode(event).pipe(Effect.flatMap(Delivery.handle)),
  )) satisfies LambdaHandler<unknown, SqsEvent.BatchResponse>;
