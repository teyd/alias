/** Lambda entrypoint (function URL behind CloudFront). Configuration comes from the Lambda environment. */
import { FunctionUrl, type LambdaHandler } from "@alias/aws";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { ServicesConfig } from "./config.ts";
import * as Proxy from "./Proxy.ts";

const runtime = ManagedRuntime.make(Effect.runSync(ServicesConfig));

// Read the keys from Parameter Store during Lambda's init phase; a failure fails the init, so
// Lambda starts a fresh container instead of reusing one whose runtime cached the failure.
await runtime.context();

/** @public Alchemy bundles `main` and points the Lambda handler at the default export. */
export default ((event) =>
  runtime.runPromise(
    FunctionUrl.decode(event).pipe(Effect.flatMap(Proxy.handle)),
  )) satisfies LambdaHandler<unknown, FunctionUrl.FunctionUrlResult>;
