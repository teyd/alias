import { ClientAddress, type Keyring, OriginSecret } from "@alias/core";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as CloudFront from "./CloudFront.ts";

/**
 * Lambda function URL payloads (format 2.0), limited to the fields we read.
 * https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
 */
export const FunctionUrlEvent = Schema.Struct({
  version: Schema.Literal("2.0"),
  rawPath: Schema.String,
  rawQueryString: Schema.String,
  cookies: Schema.optionalKey(Schema.Array(Schema.String)),
  headers: Schema.Record(Schema.String, Schema.String),
  requestContext: Schema.Struct({
    domainName: Schema.String,
    requestId: Schema.String,
    timeEpoch: Schema.Number,
    http: Schema.Struct({
      method: Schema.String,
      path: Schema.String,
      sourceIp: Schema.String,
    }),
  }),
  body: Schema.optionalKey(Schema.String),
  isBase64Encoded: Schema.Boolean,
});
export type FunctionUrlEvent = typeof FunctionUrlEvent.Type;

export const FunctionUrlResult = Schema.Struct({
  statusCode: Schema.Number,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cookies: Schema.optionalKey(Schema.Array(Schema.String)),
  body: Schema.optionalKey(Schema.String),
  isBase64Encoded: Schema.optionalKey(Schema.Boolean),
});
export type FunctionUrlResult = typeof FunctionUrlResult.Type;

class InvalidFunctionUrlEvent extends Schema.TaggedError<InvalidFunctionUrlEvent>()(
  "InvalidFunctionUrlEvent",
  { reason: Schema.String },
) {}

class WebHandlerFailure extends Schema.TaggedError<WebHandlerFailure>()("WebHandlerFailure", {
  reason: Schema.String,
}) {}

/** Parses what the Lambda runtime passed in. Run this first; everything below takes the parsed event. */
export const decode = flow(
  Schema.decodeUnknownEffect(FunctionUrlEvent),
  Effect.mapError((error) => new InvalidFunctionUrlEvent({ reason: error.message })),
);

const TEXT_CONTENT =
  /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded))/i;

/** Lambda returns text bodies as-is and everything else base64-encoded. */
const isTextContent = (headers: Headers): boolean =>
  Option.match(Option.fromNullOr(headers.get("content-type")), {
    onNone: () => true,
    onSome: (contentType) => TEXT_CONTENT.test(contentType),
  });

const requestBody = (event: FunctionUrlEvent) =>
  Option.match(Option.fromUndefinedOr(event.body), {
    onNone: () => Effect.succeed({}),
    onSome: (body) =>
      event.isBase64Encoded
        ? Result.match(Base64.decode(body), {
            onFailure: (error) =>
              Effect.fail(new InvalidFunctionUrlEvent({ reason: `body: ${error.message}` })),
            onSuccess: (bytes) => Effect.succeed({ body: Uint8Array.from(bytes) }),
          })
        : Effect.succeed({ body }),
  });

/**
 * The header the built `Request` carries the caller's address in, since a web `Request` has no
 * field for it: `requestContext.http.sourceIp`, or behind CloudFront the viewer's address (see
 * {@link Front}). Whatever the client sent under this name is replaced, so handlers may trust it.
 */
export const SOURCE_IP_HEADER = "x-alias-source-ip";

/**
 * Who stands in front of the function URL. `Direct`: nobody, the URL is the endpoint (`pnpm dev`,
 * tests, and the image proxy, whose URL takes only CloudFront's signed requests anyway); the
 * caller is `sourceIp`. `CloudFront`: the API behind our distribution (PLAN.md §20.26), whose URL
 * stays public because OAC can't sign POST bodies for browsers. Only a request carrying one of
 * `originSecrets` came through it; that one's caller is `CloudFront-Viewer-Address`, and every
 * other request is refused, so nobody can skip the WAF or name their own address.
 */
export type Front = Data.TaggedEnum<{
  // An empty variant is spelled `{}` in `Data.TaggedEnum`.
  // oxlint-disable-next-line effect/avoid-object-type
  Direct: {};
  CloudFront: { readonly originSecrets: Keyring.Keyring };
}>;
const Front = Data.taggedEnum<Front>();

export const direct: Front = Front.Direct();

export const cloudFront = (originSecrets: Keyring.Keyring): Front =>
  Front.CloudFront({ originSecrets });

/** Why a request was refused before the handler saw it. Says nothing about the secret. */
class NotFromFront extends Schema.TaggedError<NotFromFront>()("NotFromFront", {
  reason: Schema.Literals(["no-origin-proof", "no-viewer-address"]),
}) {}

/** The canonical form of an address, or the text as it came if it isn't one. */
const canonical = (address: string) =>
  Option.match(ClientAddress.parse(address), {
    onNone: () => address,
    onSome: ClientAddress.format,
  });

/** The caller's address, as far as `front` lets us know it. */
const callerOf = (event: FunctionUrlEvent, front: Front): Result.Result<string, NotFromFront> =>
  Front.$match(front, {
    Direct: () => Result.succeed(canonical(event.requestContext.http.sourceIp)),
    CloudFront: ({ originSecrets }) => {
      const presented = Option.fromUndefinedOr(event.headers[CloudFront.ORIGIN_SECRET_HEADER]);
      if (!Option.exists(presented, (value) => OriginSecret.verify(originSecrets, value))) {
        return Result.fail(new NotFromFront({ reason: "no-origin-proof" }));
      }
      return Option.match(
        Option.flatMap(
          Option.fromUndefinedOr(event.headers[CloudFront.VIEWER_ADDRESS_HEADER]),
          CloudFront.viewerAddress,
        ),
        {
          onNone: () => Result.fail(new NotFromFront({ reason: "no-viewer-address" })),
          onSome: (address) => Result.succeed(ClientAddress.format(address)),
        },
      );
    },
  });

/** Headers only the adapter reads; handlers never see them. */
const FRONT_HEADERS = [CloudFront.ORIGIN_SECRET_HEADER, CloudFront.VIEWER_ADDRESS_HEADER];

const buildRequest = Effect.fn("FunctionUrl.buildRequest")(function* (
  event: FunctionUrlEvent,
  caller: string,
) {
  const query = Str.isEmpty(event.rawQueryString) ? "" : `?${event.rawQueryString}`;
  const headers = new Headers(event.headers);
  Option.map(Option.fromUndefinedOr(event.cookies), (cookies) =>
    headers.set("cookie", cookies.join("; ")),
  );
  Arr.map(FRONT_HEADERS, (name) => headers.delete(name));
  headers.set(SOURCE_IP_HEADER, caller);
  const method = event.requestContext.http.method;
  const body = method === "GET" || method === "HEAD" ? {} : yield* requestBody(event);
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  return yield* Effect.try({
    try: () => new Request(url, { method, headers, ...body }),
    catch: (cause) =>
      new InvalidFunctionUrlEvent({ reason: `cannot build a request: ${String(cause)}` }),
  });
});

/**
 * Builds the web `Request` the function URL received, for a {@link direct} caller. Cookies arrive
 * split out, as AWS sends them.
 */
export const toRequest = (event: FunctionUrlEvent) =>
  buildRequest(event, canonical(event.requestContext.http.sourceIp));

/** Turns a web `Response` into the result shape Lambda expects from a function URL handler. */
export const fromResponse = Effect.fn("FunctionUrl.fromResponse")(function* (response: Response) {
  const buffer = yield* Effect.tryPromise({
    try: () => response.arrayBuffer(),
    catch: (cause) =>
      new WebHandlerFailure({ reason: `reading the response body: ${String(cause)}` }),
  });
  const bytes = new Uint8Array(buffer);
  const isText = isTextContent(response.headers);
  const headers = R.fromEntries(
    Arr.filter(Arr.fromIterable(response.headers), ([name]) => name !== "set-cookie"),
  );
  const cookies = response.headers.getSetCookie();
  const result: FunctionUrlResult = {
    statusCode: response.status,
    headers,
    body: isText ? new TextDecoder().decode(bytes) : Base64.encode(bytes),
    isBase64Encoded: !isText,
  };
  return Arr.isArrayNonEmpty(cookies) ? { ...result, cookies } : result;
});

const refused: FunctionUrlResult = {
  statusCode: 403,
  headers: { "content-type": "application/json" },
  body: '{"message":"Forbidden"}',
  isBase64Encoded: false,
};

/**
 * Serves a function URL event with any web-standard handler (e.g. `HttpRouter.toWebHandler`).
 * Behind {@link cloudFront}, a request without the origin proof gets a 403 without reaching it.
 */
export const handle = (
  webHandler: (request: Request) => Promise<Response>,
  front: Front = direct,
) =>
  Effect.fn("FunctionUrl.handle")(function* (event: FunctionUrlEvent) {
    const caller = callerOf(event, front);
    if (Result.isFailure(caller)) {
      // Missing proof is someone calling the URL directly; a proven request without a viewer
      // address means the distribution's origin request policy no longer forwards it.
      yield* caller.failure.reason === "no-viewer-address"
        ? Effect.logError("CloudFront request without CloudFront-Viewer-Address refused")
        : Effect.logDebug("request without origin proof refused");
      return refused;
    }
    const request = yield* buildRequest(event, caller.success);
    const response = yield* Effect.tryPromise({
      try: () => webHandler(request),
      catch: (cause) => new WebHandlerFailure({ reason: String(cause) }),
    });
    return yield* fromResponse(response);
  });
