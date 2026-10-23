import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Siteverify from "./Siteverify.ts";
import * as Widget from "./Widget.ts";

/**
 * Cloudflare Turnstile for tests and dev, on the paths Cloudflare serves it from: the Siteverify
 * API (`POST /turnstile/v0/siteverify`) and the widget script (`GET /turnstile/v0/api.js`), both
 * for the documented test keys only (`TestKeys.ts`).
 */
export class TurnstileServer extends Context.Service<
  TurnstileServer,
  {
    /** The origin to use instead of `https://challenges.cloudflare.com`, `http://127.0.0.1:<port>`. */
    readonly url: string;
    readonly port: number;
  }
>()("@alias/turnstile-emulator/TurnstileServer") {}

export interface TurnstileServerConfig {
  /** `0` (the default) picks a free port; tests always use it. */
  readonly port?: number;
  readonly host?: string;
}

class ServerFailure extends Schema.TaggedError<ServerFailure>()("ServerFailure", {
  reason: Schema.String,
}) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }));

interface Reply {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

const readBody = (request: IncomingMessage) =>
  Effect.callback<string, ServerFailure>((resume) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))));
    request.on("error", (error) =>
      resume(Effect.fail(new ServerFailure({ reason: error.message }))),
    );
  });

const route = Effect.fn("TurnstileServer.route")(function* (request: IncomingMessage) {
  const url = new URL(request.url ?? "/", "http://turnstile.invalid");
  if (url.pathname === "/turnstile/v0/siteverify") {
    const answer = Siteverify.answer({
      method: request.method ?? "GET",
      contentType: request.headers["content-type"] ?? "",
      body: yield* readBody(request),
      now: yield* DateTime.now,
    });
    const reply: Reply = {
      status: answer.status,
      contentType: "application/json",
      body: encodeJson(answer.body),
    };
    return reply;
  }
  if (url.pathname === "/turnstile/v0/api.js" && request.method === "GET") {
    const reply: Reply = { status: 200, contentType: "text/javascript", body: Widget.script };
    return reply;
  }
  const reply: Reply = { status: 404, contentType: "text/plain", body: "not found" };
  return reply;
});

export const make = Effect.fn("TurnstileServer.make")(function* (
  config: TurnstileServerConfig = {},
) {
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const host = config.host ?? "127.0.0.1";

  const respond = (response: ServerResponse, reply: Reply) => {
    response.statusCode = reply.status;
    response.setHeader("content-type", reply.contentType);
    // Cloudflare serves both cross-origin; the widget script loads from the app's pages.
    response.setHeader("access-control-allow-origin", "*");
    response.end(reply.body);
  };

  const server = createServer((request, response) => {
    run(route(request)).then(
      (reply) => respond(response, reply),
      () =>
        respond(response, {
          status: 500,
          contentType: "application/json",
          body: encodeJson({ "error-codes": ["internal-error"], success: false, messages: [] }),
        }),
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
            Effect.mapError(
              () => new ServerFailure({ reason: "Turnstile server has no TCP address" }),
            ),
          ),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

  return TurnstileServer.of({ url: `http://${host}:${port}`, port });
});

export const layer = (config?: TurnstileServerConfig) =>
  Layer.effect(TurnstileServer, make(config));
