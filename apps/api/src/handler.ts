/** Lambda entrypoint (function URL). Configuration comes from the Lambda environment. */
import { FunctionUrl, type LambdaHandler } from "@alias/aws";
import * as Effect from "effect/Effect";
import { DatabaseConfig } from "./config.ts";
import { makeFunctionUrlHandler } from "./lambda.ts";

const api = makeFunctionUrlHandler(Effect.runSync(DatabaseConfig));

/** @public Alchemy bundles `main` and points the Lambda handler at the default export. */
export default ((event) =>
  Effect.runPromise(
    FunctionUrl.decode(event).pipe(Effect.flatMap(api.handle)),
  )) satisfies LambdaHandler<unknown, FunctionUrl.FunctionUrlResult>;
