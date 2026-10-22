import { FunctionUrl } from "@alias/aws";
import type * as Layer from "effect/Layer";
import { type Services, webHandler } from "./http.ts";

/**
 * The API as a function URL handler. It takes an event and returns a result, both as Effects,
 * so tests and emulators can drive it. `handler.ts` is the thin Lambda entrypoint around it.
 */
export const makeFunctionUrlHandler = <E>(services: Layer.Layer<Services, E>) => {
  const web = webHandler(services);
  return { handle: FunctionUrl.handle(web.handler), dispose: web.dispose };
};
