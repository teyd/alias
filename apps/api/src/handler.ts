/** Lambda entrypoint (function URL). Configuration comes from the Lambda environment. */
import { FunctionUrl, type LambdaHandler } from "@alias/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ServicesConfig } from "./config.ts";
import { makeFunctionUrlHandler } from "./lambda.ts";

// Build the services, which reads the inbox keys from Parameter Store, during Lambda's init
// phase and keep them for the container's life. A failure here fails the init, so Lambda starts
// a fresh environment instead of keeping one whose first build failed for good.
const services = await Effect.runPromise(
  Layer.buildWithScope(Effect.runSync(ServicesConfig), Scope.makeUnsafe()),
);

const api = makeFunctionUrlHandler(Layer.succeedContext(services));

/** @public Alchemy bundles `main` and points the Lambda handler at the default export. */
export default ((event) =>
  Effect.runPromise(
    FunctionUrl.decode(event).pipe(Effect.flatMap(api.handle)),
  )) satisfies LambdaHandler<unknown, FunctionUrl.FunctionUrlResult>;
