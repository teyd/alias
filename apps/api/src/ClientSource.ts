import { FunctionUrl } from "@alias/aws";
import { ClientAddress } from "@alias/core";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";
import * as Option from "effect/Option";
import { hashToken } from "./Secrets.ts";

/**
 * The calling client, hashed, for rate limits: their counters' keys hold no IP. The address is
 * the one `FunctionUrl.handle` vouches for: the function URL's `sourceIp`, or behind CloudFront
 * `CloudFront-Viewer-Address` once the origin secret proved the request came through it (PLAN.md
 * §20.26); client-sent copies never get here. IPv6 clients count per /64
 * (`ClientAddress.rateLimitKey`).
 */
export const clientSource = Effect.fn("ClientSource.clientSource")(function* () {
  const crypto = yield* Crypto.Crypto;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const address = Option.getOrElse(
    Option.fromUndefinedOr(request.headers[FunctionUrl.SOURCE_IP_HEADER]),
    () => "unknown",
  );
  return yield* Effect.orDie(hashToken(crypto, ClientAddress.rateLimitKey(address)));
});
