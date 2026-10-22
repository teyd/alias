import { createServer } from "node:http";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";

const decodeAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }));

/** One request a receiver got. */
export interface Received {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * A webhook endpoint on 127.0.0.1, port 0, for tests: records every request and answers with the
 * next status from `statuses` (the last one repeats). A `302` points at `/redirected`.
 */
export const make = (statuses: ReadonlyArray<number> = [200]) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly url: string;
      readonly received: Array<Received>;
      readonly close: () => void;
    }>((resume) => {
      const received: Array<Received> = [];
      const server = createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const headers = R.map(
            R.filter(request.headers, (value) => value !== undefined),
            (value) => String(value),
          );
          received.push({
            path: request.url ?? "",
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
          const status = statuses[Math.min(received.length, statuses.length) - 1] ?? 200;
          if (status === 302) response.setHeader("location", "/redirected");
          response.statusCode = status;
          response.end("ok");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = Option.getOrElse(
          Option.map(decodeAddress(server.address()), (address) => address.port),
          () => 0,
        );
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${port}/hook`,
            received,
            close: () => {
              server.closeAllConnections();
              server.close();
            },
          }),
        );
      });
    }),
    (receiver) => Effect.sync(receiver.close),
  );
