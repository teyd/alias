/** Lambda entrypoint (SES receipt-rule action). Configuration comes from the Lambda environment. */
import { type LambdaHandler, SesEvent } from "@alias/aws";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { ServicesConfig } from "./config.ts";
import * as Pipeline from "./Pipeline.ts";

const runtime = ManagedRuntime.make(Pipeline.layer(Effect.runSync(ServicesConfig)));

/**
 * @public Alchemy bundles `main` and points the Lambda handler at the default export.
 *
 * SES invokes it asynchronously. A rejected promise makes Lambda retry the event (twice, by
 * default); the pipeline's claims keep a retry from sending anything twice. An event that doesn't
 * parse is logged and dropped, because retrying can't fix it.
 */
export default ((event) =>
  runtime.runPromise(
    SesEvent.decode(event).pipe(
      Effect.flatMap(Pipeline.handle),
      Effect.asVoid,
      Effect.catchTag("InvalidSesEvent", (error) =>
        Effect.logError("inbound event rejected", error.reason),
      ),
    ),
  )) satisfies LambdaHandler<unknown, void>;
