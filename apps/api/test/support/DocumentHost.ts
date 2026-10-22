import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }));

/**
 * A host on 127.0.0.1, port 0, serving one JSON document at `/client.json`, as an OAuth client
 * publishes its Client ID Metadata Document. `document` gets the document's own URL, so it can
 * name itself (or, to test refusals, something else). Counts the fetches.
 */
export const make = (document: (url: string) => unknown) =>
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
        return response.end(JSON.stringify(document(url)));
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
