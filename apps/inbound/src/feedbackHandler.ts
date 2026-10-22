/** Lambda entrypoint (SNS subscription of the SES event topic). Configuration from the environment. */
import { type LambdaHandler, SnsEvent, Transport } from "@alias/aws";
import { Dynamo } from "@alias/db";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Feedback from "./Feedback.ts";

/** `ALIAS_TABLE_NAME` and the AWS-standard endpoint overrides that only emulated runs set. */
const ServicesConfig = Config.all([Dynamo.config, Transport.config]).pipe(
  Config.map((layers) => Layer.mergeAll(...layers)),
);

const runtime = ManagedRuntime.make(Feedback.layer(Effect.runSync(ServicesConfig)));

/**
 * @public Alchemy bundles it as the feedback Lambda. SNS invokes it asynchronously and retries a
 * rejected promise; an event that doesn't parse is logged and dropped.
 */
export default ((event) =>
  runtime.runPromise(
    SnsEvent.decode(event).pipe(
      Effect.flatMap(Feedback.handle),
      Effect.asVoid,
      Effect.catchTag("InvalidSnsEvent", (error) =>
        Effect.logError("feedback event rejected", error.reason),
      ),
    ),
  )) satisfies LambdaHandler<unknown, void>;
