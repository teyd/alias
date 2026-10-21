import { spawn } from "node:child_process";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { DynamoDbEndpoint, EmulatorFailure, inRealTime, resolveTool } from "./Emulator.ts";

/**
 * fakecloud (https://github.com/faiscadev/fakecloud) is one binary that speaks the AWS wire
 * protocols, pinned in `mise.toml`. We use it for S3 and DynamoDB. Its SES receiving is too
 * shallow for us (no subdomain rules, verdicts or raw MIME), so `tools/ses-emulator` covers that.
 */
export class FakeCloud extends Context.Service<FakeCloud, { readonly url: string }>()(
  "@alias/aws-emulators/FakeCloud",
) {}

export interface FakeCloudOptions {
  /** `0` (the default) picks a free port; tests always use it. */
  readonly port?: number;
  /** Directory for persistent state (dev). Omit for in-memory. */
  readonly dataPath?: string;
}

const failure = (reason: string) => new EmulatorFailure({ engine: "fakecloud", reason });

/** fakecloud prints `FAKECLOUD_PORT=<port>` once it is listening. */
const PORT_LINE = /FAKECLOUD_PORT=(\d+)/;

const make = Effect.fn("FakeCloud.make")(function* (options: FakeCloudOptions = {}) {
  const storage = Option.match(Option.fromUndefinedOr(options.dataPath), {
    onNone: () => [],
    onSome: (path) => ["--storage-mode", "persistent", "--data-path", path],
  });
  const binary = yield* resolveTool("fakecloud");
  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(
        binary,
        [
          "--addr",
          `127.0.0.1:${options.port ?? 0}`,
          "--region",
          "eu-west-1",
          "--log-level",
          "error",
          ...storage,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      ),
    ),
    (process) =>
      Effect.callback<void>((resume) => {
        if (process.exitCode !== null) return resume(Effect.void);
        process.once("exit", () => resume(Effect.void));
        process.kill("SIGTERM");
      }),
  );

  const port = yield* Effect.callback<number, EmulatorFailure>((resume) => {
    child.stdout.on("data", (chunk: Buffer) => {
      Option.map(Option.fromNullOr(PORT_LINE.exec(chunk.toString())), (match) =>
        resume(Effect.succeed(Number(match[1]))),
      );
    });
    child.once("error", (error) =>
      resume(
        Effect.fail(failure(`cannot start fakecloud (run \`mise install\`): ${error.message}`)),
      ),
    );
    child.once("exit", (code) => resume(Effect.fail(failure(`exited early with code ${code}`))));
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(30),
      orElse: () => Effect.fail(failure("did not start within 30 s")),
    }),
    inRealTime,
  );

  return { url: `http://127.0.0.1:${port}` };
});

/** One process serving both: `FakeCloud` for S3 and other services, `DynamoDbEndpoint` for repositories. */
export const layer = (options?: FakeCloudOptions) =>
  Layer.effectContext(
    Effect.map(make(options), ({ url }) =>
      Context.make(FakeCloud, FakeCloud.of({ url })).pipe(
        Context.add(DynamoDbEndpoint, DynamoDbEndpoint.of({ url, engine: "fakecloud" })),
      ),
    ),
  );
