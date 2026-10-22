/**
 * The DoH emulator for `pnpm dev`, on `ALIAS_DOH_PORT`. The API's domain checks resolve through
 * it, so publishing a custom domain's records means setting them here:
 *
 *   curl -X PUT http://localhost:$ALIAS_DOH_PORT/_emulator/zones/custom.test \
 *     -d '[{"name":"custom.test","type":"MX","data":"10 inbound-smtp.eu-west-1.amazonaws.com"}]'
 *
 * Zones live in memory; a restart forgets them.
 */
import { NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { DohServer } from "../src/index.ts";

const port = Number(process.env.ALIAS_DOH_PORT ?? 8053);

const serve = Effect.fn("doh.dev")(function* () {
  const server = yield* DohServer.make({ port });
  yield* Effect.logInfo(
    `DoH emulator on ${server.url}; set zones with PUT ${server.url.replace("/dns-query", "/_emulator/zones/<apex>")}`,
  );
  yield* Effect.never;
});

NodeRuntime.runMain(serve().pipe(Effect.scoped));
