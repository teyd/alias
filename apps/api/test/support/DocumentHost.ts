import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }));

/**
 * A host on 127.0.0.1, port 0, serving one JSON document at `/client.json`, as an OAuth client
 * publishes its Client ID Metadata Document. `document` gets the document's own URL, so it can
 * name itself (or, to test refusals, something else). Counts the fetches. `isEndless` streams a
 * document that never ends instead, chunked.
 */
export const make = (document: (url: string) => unknown, options: { isEndless?: boolean } = {}) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly fetches: () => number;
      readonly close: () => void;
    }>((resume) => {
      let fetches = 0;
      let url = "";
      const server = createServer((request, response) => {
        fetches += 1;
        if (request.url !== "/client.json") {
          response.statusCode = 404;
          return response.end();
        }
        response.setHeader("content-type", "application/json");
        if (options.isEndless !== true) return response.end(JSON.stringify(document(url)));
        // Chunked, with no length, and never ending: only a reader that counts stops it.
        response.write(`{"client_id":${JSON.stringify(url)},"client_name":"`);
        const flood = setInterval(() => response.write("x".repeat(64 * 1024)), 1);
        return response.on("close", () => clearInterval(flood));
      });
      server.listen(0, "127.0.0.1", () => {
        const port = Option.getOrElse(
          Option.map(decodeAddress(server.address()), (address) => address.port),
          () => 0,
        );
        url = `http://127.0.0.1:${port}/client.json`;
        resume(
          Effect.succeed({
            url,
            fetches: () => fetches,
            close: () => {
              server.closeAllConnections();
              server.close();
            },
          }),
        );
      });
    }),
    (host) => Effect.sync(host.close),
  );
