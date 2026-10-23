import { createServer, request as httpRequest } from "node:http";
import * as Arr from "effect/Array";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

/**
 * A CloudFront cache behavior in front of one function URL origin, the way the API's `/v1/*`,
 * `/mcp` and `/.well-known/*` behaviors are configured (PLAN.md §20.26): managed `CachingDisabled`
 * and `AllViewerExceptHostHeader` policies, and origin custom headers. What it does to a request
 * follows the CloudFront developer guide:
 *
 * - `Host` becomes the origin's ("AllViewerExceptHostHeader": function URLs expect their own).
 * - `CloudFront-Viewer-Address` is the viewer's IP and source port, `198.51.100.10:46532`, IPv6
 *   without brackets ("Add CloudFront request headers"). A viewer-sent copy is replaced: the docs
 *   don't say, so this is the assumption a deploy must confirm (§20.26).
 * - Origin custom headers overwrite viewer headers of the same name ("Add custom headers to
 *   origin requests").
 * - The viewer's address is appended to `X-Forwarded-For`; `X-Amz-Cf-Id` is added; `X-Real-IP`,
 *   `X-Forwarded-Proto`, `X-HTTP-Method-Override` and `X-Edge-*` are removed, as are hop-by-hop
 *   headers ("Request and response behavior for custom origins").
 *
 * Nothing is cached, as with `CachingDisabled`. It speaks plain HTTP on both sides; TLS, the WAF
 * and the other behaviors aren't emulated.
 */
export interface CloudFrontServerConfig {
  /** The function URL origin, e.g. `FunctionUrlServer`'s `url`. */
  readonly origin: string;
  /** The origin custom headers, e.g. `x-alias-origin-secret`. */
  readonly customHeaders?: Readonly<Record<string, string>>;
  /** `127.0.0.1` by default; `::1` for an IPv6 viewer. Port 0 always. */
  readonly host?: string;
}

class ServerFailure extends Schema.TaggedError<ServerFailure>()("CloudFrontServerFailure", {
  reason: Schema.String,
}) {}

/** Removed before forwarding: hop-by-hop headers, and those the custom-origin docs list. */
const DROPPED: ReadonlyArray<string> = [
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "transfer-encoding",
  "x-real-ip",
  "x-forwarded-proto",
  "x-http-method-override",
  "cloudfront-viewer-address",
];

const isDropped = (name: string) => Arr.contains(DROPPED, name) || Str.startsWith("x-edge-")(name);

/** The socket's address as CloudFront writes it: IPv4 for mapped addresses, IPv6 bare. */
const viewerIp = (address: string) =>
  Str.startsWith("::ffff:")(address) && Str.includes(".")(address) ? address.slice(7) : address;

/** Header lines in arrival order, names lowercased, from Node's `rawHeaders`. */
const lines = (raw: ReadonlyArray<string>): ReadonlyArray<readonly [string, string]> =>
  Arr.map(Arr.chunksOf(raw, 2), ([name, value = ""]) => [name.toLowerCase(), value] as const);

/** The origin request's headers, from the viewer's lines; repeated ones are joined. */
const originHeaders = (
  viewer: ReadonlyArray<readonly [string, string]>,
  meta: {
    readonly viewerAddress: string;
    readonly viewerPort: number;
    readonly originHost: string;
    readonly requestId: string;
    readonly customHeaders: Readonly<Record<string, string>>;
  },
) => {
  const kept = Arr.filter(viewer, ([name]) => !isDropped(name));
  const joined = R.map(
    Arr.groupBy(kept, ([name]) => name),
    (group, header) => Arr.map(group, ([, value]) => value).join(header === "cookie" ? "; " : ","),
  );
  const forwardedFor = Option.match(Option.fromUndefinedOr(joined["x-forwarded-for"]), {
    onNone: () => meta.viewerAddress,
    onSome: (earlier) => `${earlier},${meta.viewerAddress}`,
  });
  const custom = R.fromEntries(
    Arr.map(R.toEntries(meta.customHeaders), ([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    ...joined,
    host: meta.originHost,
    "x-forwarded-for": forwardedFor,
    "x-amz-cf-id": meta.requestId,
    "cloudfront-viewer-address": `${meta.viewerAddress}:${meta.viewerPort}`,
    ...custom,
  };
};

const decodeAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }));

export const make = Effect.fn("CloudFrontServer.make")(function* (config: CloudFrontServerConfig) {
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<never>();
  const run = Effect.runPromiseWith(context);
  const origin = new URL(config.origin);
  const host = config.host ?? "127.0.0.1";

  const server = createServer((viewer, response) => {
    void run(
      Effect.gen(function* () {
        const requestId = Base64Url.encode(yield* crypto.randomBytes(42));
        const headers = originHeaders(lines(viewer.rawHeaders), {
          viewerAddress: viewerIp(viewer.socket.remoteAddress ?? "127.0.0.1"),
          viewerPort: viewer.socket.remotePort ?? 0,
          originHost: origin.host,
          requestId,
          customHeaders: config.customHeaders ?? {},
        });
        yield* Effect.callback<void>((resume) => {
          const forwarded = httpRequest(
            {
              hostname: origin.hostname,
              port: origin.port,
              method: viewer.method,
              path: viewer.url,
              headers,
            },
            (answer) => {
              const kept = Arr.filter(lines(answer.rawHeaders), ([header]) => !isDropped(header));
              Arr.map(kept, ([header, value]) => response.appendHeader(header, value));
              response.setHeader("via", "1.1 emulated.cloudfront.net (CloudFront)");
              response.setHeader("x-amz-cf-id", requestId);
              response.statusCode = answer.statusCode ?? 502;
              answer.pipe(response);
              answer.on("end", () => resume(Effect.void));
            },
          );
          forwarded.on("error", () => {
            // CloudFront answers 502 when it can't reach the origin.
            response.statusCode = 502;
            response.end();
            resume(Effect.void);
          });
          viewer.pipe(forwarded);
        });
      }),
    );
  });

  const port = yield* Effect.acquireRelease(
    Effect.callback<number, ServerFailure>((resume) => {
      server.once("error", (error) =>
        resume(Effect.fail(new ServerFailure({ reason: error.message }))),
      );
      server.listen(0, host, () => {
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

  const authority = Str.includes(":")(host) ? `[${host}]` : host;
  return { url: `http://${authority}:${port}`, port };
});
