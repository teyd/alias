import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { FunctionUrl, type LambdaContext, type LambdaHandler } from "@alias/aws";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Serves a Lambda function URL handler over plain HTTP, building the payload-2.0 events and
 * reading the results the way the real service does:
 * https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
 *
 * It shares no conversion code with the production adapter (`@alias/aws` FunctionUrl), so the
 * two check each other. Contract tests pin both to the documented payloads.
 */
export interface FunctionUrlServerConfig {
  readonly handler: LambdaHandler<FunctionUrl.FunctionUrlEvent, Schema.Json>;
  /** `0` (the default) picks a free port; tests always use it. */
  readonly port?: number;
  readonly host?: string;
  readonly functionName?: string;
}

export class FunctionUrlServer extends Context.Service<
  FunctionUrlServer,
  { readonly url: string; readonly port: number }
>()("@alias/lambda-emulator/FunctionUrlServer") {}

export class ServerFailure extends Schema.TaggedError<ServerFailure>()("ServerFailure", {
  reason: Schema.String,
}) {}

class FunctionFailed extends Schema.TaggedError<FunctionFailed>()("FunctionFailed", {
  reason: Schema.String,
}) {}

/** Function URLs cap request and response payloads at 6 MB. */
const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;

const TEXT_CONTENT =
  /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded))/i;

export interface IncomingHttp {
  readonly method: string;
  /** Path plus query, as received. */
  readonly target: string;
  /** Header lines in arrival order, as Node's `rawHeaders` gives them. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
  readonly sourceIp: string;
}

/** Lambda lowercases header names and joins repeated headers with commas. */
const joinHeaders = (
  lines: ReadonlyArray<readonly [string, string]>,
): Readonly<Record<string, string>> =>
  R.map(
    Arr.groupBy(lines, ([name]) => name.toLowerCase()),
    (group) => Arr.map(group, ([, value]) => value).join(","),
  );

/** Builds the event exactly as documented: lowercase headers, cookies split out, base64 for binary. */
export const toEvent = (
  incoming: IncomingHttp,
  meta: { readonly requestId: string; readonly now: DateTime.Utc },
): FunctionUrl.FunctionUrlEvent => {
  const queryAt = incoming.target.indexOf("?");
  const rawPath = queryAt === -1 ? incoming.target : incoming.target.slice(0, queryAt);
  const rawQueryString = queryAt === -1 ? "" : incoming.target.slice(queryAt + 1);
  const { cookie, ...headers } = joinHeaders(incoming.headers);
  const host = Option.getOrElse(Option.fromUndefinedOr(headers["host"]), () => "localhost");
  const cookies = Option.match(Option.fromUndefinedOr(cookie), {
    onNone: () => ({}),
    onSome: (value) => ({ cookies: value.split(/;\s*/) }),
  });
  const hasBody = incoming.body.byteLength > 0;
  const isBase64Encoded = hasBody && !TEXT_CONTENT.test(headers["content-type"] ?? "");
  const body = hasBody
    ? {
        body: isBase64Encoded
          ? Base64.encode(incoming.body)
          : new TextDecoder().decode(incoming.body),
      }
    : {};
  return {
    version: "2.0",
    rawPath,
    rawQueryString,
    ...cookies,
    headers,
    requestContext: {
      domainName: host,
      requestId: meta.requestId,
      timeEpoch: DateTime.toEpochMillis(meta.now),
      http: { method: incoming.method, path: rawPath, sourceIp: incoming.sourceIp },
    },
    ...body,
    isBase64Encoded,
  };
};

export interface OutgoingHttp {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
}

const jsonBody = (status: number, json: string): OutgoingHttp => ({
  status,
  headers: [["content-type", "application/json"]],
  body: new TextEncoder().encode(json),
});

const ErrorBody = Schema.Struct({ Message: Schema.String });
const encodeError = Schema.encodeSync(Schema.fromJsonString(ErrorBody));
const errorResponse = (status: number, message: string) =>
  jsonBody(status, encodeError({ Message: message }));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeResult = Schema.decodeUnknownOption(FunctionUrl.FunctionUrlResult);

/**
 * Interprets whatever the handler returned. Like Lambda, it sends a value without the result
 * fields as a JSON body with status 200.
 */
const fromResult = (returned: FunctionUrlReturn): OutgoingHttp =>
  Option.match(decodeResult(returned.value), {
    onNone: () => jsonBody(200, encodeJson(returned.value)),
    onSome: (result) => {
      const text = result.body ?? "";
      const body = result.isBase64Encoded
        ? Result.getOrElse(Base64.decode(text), () => new Uint8Array())
        : new TextEncoder().encode(text);
      const cookies = Arr.map(result.cookies ?? [], (cookie) => ["set-cookie", cookie] as const);
      return {
        status: result.statusCode,
        headers: [...R.toEntries(result.headers ?? {}), ...cookies],
        body,
      };
    },
  });

/** What a function URL handler resolved with; Lambda accepts any JSON-serializable value. */
interface FunctionUrlReturn {
  readonly value: Schema.Json;
}

const readBody = (request: IncomingMessage) =>
  Effect.callback<Uint8Array, ServerFailure>((resume) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resume(Effect.succeed(new Uint8Array(Buffer.concat(chunks)))));
    request.on("error", (error) =>
      resume(Effect.fail(new ServerFailure({ reason: error.message }))),
    );
  });

const write = (response: ServerResponse, outgoing: OutgoingHttp) =>
  Effect.sync(() => {
    Arr.map(outgoing.headers, ([name, value]) => response.appendHeader(name, value));
    response.statusCode = outgoing.status;
    response.end(outgoing.body);
  });

const decodeAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }));

export const make = Effect.fn("FunctionUrlServer.make")(function* (
  config: FunctionUrlServerConfig,
) {
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<never>();
  const host = config.host ?? "127.0.0.1";
  const functionName = config.functionName ?? "function";

  const invoke = Effect.fn("FunctionUrlServer.invoke")(function* (incoming: IncomingHttp) {
    if (incoming.body.byteLength > MAX_PAYLOAD_BYTES) {
      return errorResponse(413, `Request must be smaller than ${MAX_PAYLOAD_BYTES} bytes`);
    }
    const requestId = yield* crypto.randomUUIDv4();
    const event = toEvent(incoming, { requestId, now: yield* DateTime.now });
    const lambdaContext: LambdaContext = {
      awsRequestId: requestId,
      functionName,
      getRemainingTimeInMillis: () => 30_000,
    };
    return yield* Effect.tryPromise({
      try: () => config.handler(event, lambdaContext),
      catch: (cause) => new FunctionFailed({ reason: String(cause) }),
    }).pipe(
      Effect.map((value) => fromResult({ value })),
      Effect.map((outgoing) =>
        outgoing.body.byteLength > MAX_PAYLOAD_BYTES
          ? errorResponse(502, "Response too large")
          : outgoing,
      ),
      Effect.catchTag("FunctionFailed", (error) =>
        Effect.logError(`function failed: ${error.reason}`).pipe(
          Effect.as(errorResponse(502, "Internal Server Error")),
        ),
      ),
    );
  });

  const run = Effect.runPromiseWith(context);
  const server = createServer((request, response) => {
    void run(
      readBody(request).pipe(
        Effect.flatMap((body) =>
          invoke({
            method: request.method ?? "GET",
            target: request.url ?? "/",
            headers: Arr.map(
              Arr.chunksOf(request.rawHeaders, 2),
              ([name, value = ""]) => [name, value] as const,
            ),
            body,
            sourceIp: request.socket.remoteAddress ?? "127.0.0.1",
          }),
        ),
        Effect.catchTag("ServerFailure", (error) =>
          Effect.succeed(errorResponse(500, `Emulator error: ${error.reason}`)),
        ),
        Effect.flatMap((outgoing) => write(response, outgoing)),
      ),
    );
  });

  const port = yield* Effect.acquireRelease(
    Effect.callback<number, ServerFailure>((resume) => {
      server.once("error", (error) =>
        resume(Effect.fail(new ServerFailure({ reason: error.message }))),
      );
      server.listen(config.port ?? 0, host, () => {
        resume(
          decodeAddress(server.address()).pipe(
            Effect.map((address) => address.port),
            Effect.mapError(() => new ServerFailure({ reason: "server has no TCP address" })),
          ),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

  return FunctionUrlServer.of({ url: `http://${host}:${port}`, port });
});

export const layer = (config: FunctionUrlServerConfig) =>
  Layer.effect(FunctionUrlServer, make(config));
