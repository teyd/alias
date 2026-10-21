import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

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

/** Builds the web `Request` the function URL received. Cookies arrive split out, as AWS sends them. */
export const toRequest = Effect.fn("FunctionUrl.toRequest")(function* (event: FunctionUrlEvent) {
  const query = Str.isEmpty(event.rawQueryString) ? "" : `?${event.rawQueryString}`;
  const headers = new Headers(event.headers);
  Option.map(Option.fromUndefinedOr(event.cookies), (cookies) =>
    headers.set("cookie", cookies.join("; ")),
  );
  const method = event.requestContext.http.method;
  const body = method === "GET" || method === "HEAD" ? {} : yield* requestBody(event);
  const url = `https://${event.requestContext.domainName}${event.rawPath}${query}`;
  return yield* Effect.try({
    try: () => new Request(url, { method, headers, ...body }),
    catch: (cause) =>
      new InvalidFunctionUrlEvent({ reason: `cannot build a request: ${String(cause)}` }),
  });
});

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

/** Serves a function URL event with any web-standard handler (e.g. `HttpRouter.toWebHandler`). */
export const handle = (webHandler: (request: Request) => Promise<Response>) =>
  Effect.fn("FunctionUrl.handle")(function* (event: FunctionUrlEvent) {
    const request = yield* toRequest(event);
    const response = yield* Effect.tryPromise({
      try: () => webHandler(request),
      catch: (cause) => new WebHandlerFailure({ reason: String(cause) }),
    });
    return yield* fromResponse(response);
  });
