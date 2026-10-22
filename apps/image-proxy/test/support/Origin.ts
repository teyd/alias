// A real HTTP origin is the point: the proxy's egress speaks to it over a socket.
// oxlint-disable-next-line effect/avoid-node-imports, effect/use-http-client-service
import { createServer, type ServerResponse } from "node:http";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

/**
 * A sender's image host on 127.0.0.1, port 0: what the proxy fetches in tests. Records the
 * headers of every request it gets, so tests can check nothing of the reader's leaked.
 */

/** The smallest valid PNG: a 1×1 transparent pixel. */
export const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** What the origin serves, by path; anything else is a 404. */
const routes: R.ReadonlyRecord<string, (response: ServerResponse, url: URL) => void> = {
  "/pixel.png": (response) => {
    response.writeHead(200, {
      "content-type": "image/png",
      "set-cookie": "tracking=1; Path=/",
      "x-origin-secret": "internal",
    });
    response.end(PNG);
  },
  "/mislabelled": (response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(PNG);
  },
  "/logo.svg": (response) => {
    response.writeHead(200, { "content-type": "image/svg+xml" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  },
  "/page.html": (response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end("<html><script>alert(1)</script></html>");
  },
  "/huge.png": (response) => {
    response.writeHead(200, { "content-type": "image/png", "content-length": 10_000_000 });
    response.end();
  },
  // Chunked, so no Content-Length warns of the size.
  "/stream.png": (response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.write(PNG);
    response.write(new Uint8Array(64 * 1024));
    response.end(new Uint8Array(64 * 1024));
  },
  // Takes the request and never answers.
  "/silent": () => {},
  // Never finishes.
  "/slow.png": (response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.write(PNG);
  },
  "/redirect": (response, url) => {
    const hops = Number(url.searchParams.get("hops") ?? "0");
    response.writeHead(302, {
      location:
        hops > 1 ? `/redirect?hops=${hops - 1}` : (url.searchParams.get("to") ?? "/pixel.png"),
    });
    response.end();
  },
};

interface Origin {
  readonly url: string;
  readonly requests: ReadonlyArray<{
    readonly path: string;
    readonly headers: R.ReadonlyRecord<string, string>;
  }>;
}

export const origin = Effect.acquireRelease(
  Effect.callback<{ readonly origin: Origin; readonly close: () => void }>((resume) => {
    const requests: Array<{ path: string; headers: R.ReadonlyRecord<string, string> }> = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://origin");
      requests.push({
        path: url.pathname,
        headers: R.fromEntries(
          Arr.map(Arr.chunksOf(request.rawHeaders, 2), ([name, value = ""]) => [
            name.toLowerCase(),
            value,
          ]),
        ),
      });
      const route = R.get(routes, url.pathname);
      return Option.match(route, {
        onSome: (serve) => serve(response, url),
        onNone: () => {
          response.writeHead(404);
          response.end();
        },
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
        server.address(),
      );
      resume(
        Effect.succeed({
          origin: { url: `http://127.0.0.1:${port}`, requests },
          // Ends lingering responses (`/slow.png`) too.
          close: () => {
            server.closeAllConnections();
            server.close();
          },
        }),
      );
    });
  }),
  ({ close }) => Effect.sync(close),
).pipe(Effect.map(({ origin }) => origin));
