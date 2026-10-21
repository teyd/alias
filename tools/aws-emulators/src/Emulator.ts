import { execFileSync } from "node:child_process";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const Engine = Schema.Literals(["fakecloud", "dynamodb-local"]);
export type Engine = typeof Engine.Type;

/** A running DynamoDB-compatible endpoint. Repository suites run against any of them. */
export class DynamoDbEndpoint extends Context.Service<
  DynamoDbEndpoint,
  { readonly url: string; readonly engine: Engine }
>()("@alias/aws-emulators/DynamoDbEndpoint") {}

export class EmulatorFailure extends Schema.TaggedError<EmulatorFailure>()("EmulatorFailure", {
  engine: Engine,
  reason: Schema.String,
}) {}

/**
 * Path of a tool pinned in `mise.toml`. Asks mise when it is installed, so tests work in shells
 * that haven't activated mise; otherwise falls back to looking the name up on `PATH`.
 */
export const resolveTool = (name: string) =>
  Effect.try({
    try: () =>
      execFileSync("mise", ["which", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    catch: () => new ToolNotManaged({ name }),
  }).pipe(Effect.catchTag("ToolNotManaged", () => Effect.succeed(name)));

class ToolNotManaged extends Schema.TaggedError<ToolNotManaged>()("ToolNotManaged", {
  name: Schema.String,
}) {}

/** Real processes start in real time, so ignore any TestClock the caller runs under. */
export const inRealTime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Clock.Clock, Clock.Clock.defaultValue());
