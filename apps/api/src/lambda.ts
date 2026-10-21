import type { Dynamo } from "@alias/db";
import { FunctionUrl } from "@alias/aws";
import type * as Layer from "effect/Layer";
import { webHandler } from "./http.ts";
import type { RelyingParty } from "./RelyingParty.ts";

/**
 * The API as a function URL handler. It takes an event and returns a result, both as Effects,
 * so tests and emulators can drive it. `handler.ts` is the thin Lambda entrypoint around it.
 */
export const makeFunctionUrlHandler = (services: Layer.Layer<Dynamo.Database | RelyingParty>) => {
  const web = webHandler(services);
  return { handle: FunctionUrl.handle(web.handler), dispose: web.dispose };
};
