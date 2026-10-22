import { FunctionUrl } from "@alias/aws";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import * as Option from "effect/Option";
import { hashToken } from "./Secrets.ts";

/**
 * The calling client's address, hashed, for rate limits: their counters' keys hold no IP. The
 * address is the function URL's `sourceIp` (`FunctionUrl.toRequest` sets the header and
 * overwrites a client-sent one); behind CloudFront it must come from `CloudFront-Viewer-Address`
 * instead (PLAN.md §20.20).
 */
export const clientSource = Effect.fn("ClientSource.clientSource")(function* () {
  const crypto = yield* Crypto.Crypto;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = Option.getOrElse(
    Option.fromUndefinedOr(request.headers[FunctionUrl.SOURCE_IP_HEADER]),
    () => "unknown",
  );
  return yield* Effect.orDie(hashToken(crypto, address));
});
