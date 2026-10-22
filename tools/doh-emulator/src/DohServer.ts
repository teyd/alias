import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { answer, type JsonAnswer, parseQuery, type ZoneRecord, type Zones } from "./Zone.ts";

/**
 * A DNS over HTTPS resolver for tests and dev: Cloudflare's JSON API
 * (`GET /dns-query?name=…&type=…` with `accept: application/dns-json`) answering from in-memory
 * zones. Tests set zones through {@link DohServer}; dev sets them over HTTP:
 * `PUT /_emulator/zones/<apex>` with a JSON array of records replaces a zone,
 * `DELETE /_emulator/zones/<apex>` removes it and `GET /_emulator/zones` lists them.
 */
export class DohServer extends Context.Service<
  DohServer,
  {
    /** The DoH endpoint, `http://127.0.0.1:<port>/dns-query`. */
    readonly url: string;
    readonly port: number;
    /** Replaces everything in the zone at `apex`. */
    readonly setZone: (apex: string, records: ReadonlyArray<ZoneRecord>) => Effect.Effect<void>;
    readonly removeZone: (apex: string) => Effect.Effect<void>;
  }
>()("@alias/doh-emulator/DohServer") {}

export interface DohServerConfig {
  /** `0` (the default) picks a free port; tests always use it. */
  readonly port?: number;
  readonly host?: string;
  readonly zones?: Zones;
}

class ServerFailure extends Schema.TaggedError<ServerFailure>()("ServerFailure", {
  reason: Schema.String,
}) {}

const ZoneRecords = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.Literals(["A", "AAAA", "CNAME", "MX", "TXT"]),
      data: Schema.String,
      ttl: Schema.optionalKey(Schema.Int),
    }),
  ),
);
const decodeZoneRecords = Schema.decodeUnknownEffect(ZoneRecords);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }));

interface Reply {
  readonly status: number;
  readonly contentType: Option.Option<string>;
  readonly body: string;
}

/** Everything the emulator answers with. */
type Body = JsonAnswer | Zones | { readonly error: string } | Readonly<Record<string, never>>;

const json = (status: number, value: Body): Reply => ({
  status,
  contentType: Option.some("application/dns-json"),
  body: encodeJson(value),
});

const readBody = (request: IncomingMessage) =>
  Effect.callback<string, ServerFailure>((resume) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))));
    request.on("error", (error) =>
      resume(Effect.fail(new ServerFailure({ reason: error.message }))),
    );
  });

const ZONES_PATH = "/_emulator/zones";

export const make = Effect.fn("DohServer.make")(function* (config: DohServerConfig = {}) {
  const zones = yield* Ref.make<Zones>(config.zones ?? {});
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const host = config.host ?? "127.0.0.1";

  const setZone = (apex: string, records: ReadonlyArray<ZoneRecord>) =>
    Ref.update(zones, R.set(Str.toLowerCase(apex), records));
  const removeZone = (apex: string) => Ref.update(zones, R.remove(Str.toLowerCase(apex)));

  const route = Effect.fn("DohServer.route")(function* (request: IncomingMessage) {
    const url = new URL(request.url ?? "/", "http://doh.invalid");
    if (url.pathname === "/dns-query" && request.method === "GET") {
      // Cloudflare answers JSON only to clients that ask for it, and 400 with no body otherwise.
      if (!(request.headers.accept ?? "").includes("application/dns-json")) {
        return { status: 400, contentType: Option.none(), body: "" } satisfies Reply;
      }
      const query = parseQuery(url.searchParams);
      if (Result.isFailure(query)) return json(400, { error: query.failure });
      return json(200, answer(yield* Ref.get(zones), query.success.name, query.success.type));
    }
    if (url.pathname === ZONES_PATH && request.method === "GET") {
      return json(200, yield* Ref.get(zones));
    }
    if (url.pathname.startsWith(`${ZONES_PATH}/`)) {
      const apex = decodeURIComponent(url.pathname.slice(ZONES_PATH.length + 1));
      if (request.method === "DELETE") {
        yield* removeZone(apex);
        return json(200, {});
      }
      if (request.method === "PUT") {
        const records = yield* Effect.option(decodeZoneRecords(yield* readBody(request)));
        if (Option.isNone(records)) return json(400, { error: "expected an array of records" });
        yield* setZone(apex, records.value);
        return json(200, {});
      }
    }
    return json(404, { error: "not found" });
  });

  const respond = (response: ServerResponse, reply: Reply) => {
    Option.map(reply.contentType, (type) => response.setHeader("content-type", type));
    response.statusCode = reply.status;
    response.end(reply.body);
  };

  const server = createServer((request, response) => {
    run(route(request)).then(
      (reply) => respond(response, reply),
      () => respond(response, json(500, { error: "the emulator failed" })),
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
            Effect.mapError(() => new ServerFailure({ reason: "DoH server has no TCP address" })),
          ),
        );
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

  return DohServer.of({ url: `http://${host}:${port}/dns-query`, port, setZone, removeZone });
});

export const layer = (config?: DohServerConfig) => Layer.effect(DohServer, make(config));
