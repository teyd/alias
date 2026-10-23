/**
 * The Turnstile emulator for `pnpm dev`, on `ALIAS_TURNSTILE_PORT`. The API verifies sign-up
 * tokens against it with the always-passing test secret, and the web app loads its widget script,
 * which hands out the dummy token for the always-passing test site key.
 */
import { NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { TurnstileServer } from "../src/index.ts";

const port = Number(process.env.ALIAS_TURNSTILE_PORT ?? 8054);

const serve = Effect.fn("turnstile.dev")(function* () {
  const server = yield* TurnstileServer.make({ port });
  yield* Effect.logInfo(`Turnstile emulator on ${server.url} (test keys only)`);
  yield* Effect.never;
});

NodeRuntime.runMain(serve().pipe(Effect.scoped));
