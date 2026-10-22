/**
 * The API for `pnpm dev`. It runs the real Lambda handler behind the function URL emulator, on
 * the persistent fakecloud that `scripts/dev.ts` starts, and seeds one demo alias. Passkeys are
 * bound to `localhost` and the Vite dev server's origin, which proxies `/v1` here.
 */
import { AliasRepo, Dynamo, Table } from "@alias/db";
import { FunctionUrlServer } from "@alias/lambda-emulator";
import { NodeCrypto, NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { makeFunctionUrlHandler, RelyingParty, SharedDomains } from "../src/index.ts";

const port = Number(process.env.ALIAS_API_PORT ?? 8787);
const dynamoUrl = `http://127.0.0.1:${process.env.ALIAS_FAKECLOUD_PORT ?? 4566}`;
const database = Dynamo.emulator(dynamoUrl, "alias");
const relyingParty = RelyingParty.layer({
  id: "localhost",
  origin: `http://localhost:${process.env.ALIAS_WEB_PORT ?? 5173}`,
});
const sharedDomains = SharedDomains.layer(process.env.ALIAS_SHARED_DOMAINS ?? "alias.test");

const seed = Effect.fn("api.dev.seed")(function* () {
  yield* Table.ensure();
  const repo = yield* AliasRepo.make();
  yield* repo
    .insert({
      id: "al_demo",
      userId: "usr_demo",
      domain: "alias.test",
      localPart: "shop",
      mode: "forward",
      createdAt: 0,
    })
    .pipe(Effect.catchTag("AliasTaken", () => Effect.void));
});

const serve = Effect.fn("api.dev")(function* () {
  yield* seed().pipe(
    Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }),
    Effect.provide(database),
  );
  const { handle } = makeFunctionUrlHandler(Layer.mergeAll(database, relyingParty, sharedDomains));
  const server = yield* FunctionUrlServer.make({
    port,
    handler: (event) => Effect.runPromise(handle(event)),
    functionName: "alias-api",
  });
  yield* Effect.logInfo(`api (function URL emulator) on ${server.url}, DynamoDB at ${dynamoUrl}`);
  yield* Effect.never;
});

NodeRuntime.runMain(serve().pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));
