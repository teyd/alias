#!/usr/bin/env node
/** The `alias` executable: Node in the workspace, a single Bun-compiled binary for release. */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import packageJson from "../package.json" with { type: "json" };
import { alias } from "../src/Commands.ts";
import * as Credentials from "../src/Credentials.ts";

alias.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(
    Layer.mergeAll(
      Credentials.layer.pipe(Layer.provide(NodeServices.layer)),
      NodeServices.layer,
      FetchHttpClient.layer,
    ),
  ),
  // The CLI prints its own errors (`forUser`); the exit code says it failed.
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
