/** Lambda entrypoint (SQS event source mapping of the webhook queue). Configured from the environment. */
import { type LambdaHandler, SqsEvent } from "@alias/aws";
import { Delivery } from "@alias/webhooks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ServicesConfig } from "./services.ts";

// Build the services, which reads the webhook keys from Parameter Store, during Lambda's init
// phase and keep them for the container's life. A failure here fails the init, so Lambda starts
// a fresh environment instead of keeping one whose first build failed for good (PLAN.md §20.14).
const services = await Effect.runPromise(
  Layer.buildWithScope(Effect.runSync(ServicesConfig), Scope.makeUnsafe()),
);

/**
 * @public Alchemy bundles it as the webhook delivery Lambda. The mapping has
 * `ReportBatchItemFailures` on: records listed in the response are retried after the backoff
 * `Delivery` set, the rest are deleted. An event that doesn't parse fails the batch, so its
 * messages come back and, if they never parse, end in the dead-letter queue.
 */
export default ((event) =>
  Effect.runPromise(
    SqsEvent.decode(event).pipe(Effect.flatMap(Delivery.handle), Effect.provide(services)),
  )) satisfies LambdaHandler<unknown, SqsEvent.BatchResponse>;
