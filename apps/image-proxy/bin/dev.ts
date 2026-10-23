/**
 * The image proxy for `pnpm dev` (PLAN.md §20.19): the real handler behind the function URL
 * emulator on `ALIAS_IMAGE_PROXY_PORT`, with production's egress policy, so it fetches real
 * images from the internet and refuses private addresses. Its keys come from fakecloud's SSM
 * parameter `/alias/dev/image-proxy-keys`, which `apps/inbound/bin/dev.ts` puts with a fixed dev
 * key; it waits until that exists. Its fetch budgets live in the dev table on fakecloud, which
 * `apps/inbound/bin/dev.ts` creates.
 */
import { AwsClient, FunctionUrl, Parameters } from "@alias/aws";
import { Dynamo, ProxyRepo } from "@alias/db";
import { FunctionUrlServer } from "@alias/lambda-emulator";
import { NodeCrypto, NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Egress, Proxy } from "../src/index.ts";

const port = Number(process.env.ALIAS_IMAGE_PROXY_PORT ?? 8788);
const fakecloudUrl = `http://127.0.0.1:${process.env.ALIAS_FAKECLOUD_PORT ?? 4566}`;
const keysParameter = "/alias/dev/image-proxy-keys";

const serve = Effect.fn("imageProxy.dev")(function* () {
  const keys = yield* Parameters.keyring(keysParameter).pipe(
    Effect.retry({ times: 100, schedule: Schedule.spaced("200 millis") }),
    Effect.provide(AwsClient.emulator(fakecloudUrl)),
  );
  const services = Layer.mergeAll(
    Layer.succeed(Proxy.ProxyKeys, keys),
    ProxyRepo.layer.pipe(Layer.provide(Dynamo.emulator(fakecloudUrl, "alias"))),
    Proxy.defaultBudgets,
    Egress.publicInternet,
    NodeCrypto.layer,
  );
  const server = yield* FunctionUrlServer.make({
    port,
    handler: (event) =>
      Effect.runPromise(
        FunctionUrl.decode(event).pipe(Effect.flatMap(Proxy.handle), Effect.provide(services)),
      ),
  });
  yield* Effect.logInfo(`image proxy on ${server.url}`);
  return yield* Effect.never;
});

NodeRuntime.runMain(serve().pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)));
