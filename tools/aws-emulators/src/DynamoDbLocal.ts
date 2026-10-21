import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { DynamoDbEndpoint, EmulatorFailure, inRealTime, resolveTool } from "./Emulator.ts";

/**
 * Amazon DynamoDB Local is AWS's own emulator (Java 17+) and the reference we check fakecloud's
 * DynamoDB against. `pnpm agent:setup` installs it once per machine and verifies its SHA-256
 * (see `bin/install-dynamodb-local.ts`). Java comes from `mise.toml`.
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html
 */
export const RELEASE = {
  version: "3.3.2",
  url: "https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz",
  sha256: "7a94eb65f81aee270738751a4e5e3e6a7ad02a5d25194f55b83e08ec2ba6342b",
} as const;

export interface Installation {
  readonly dir: string;
  readonly jar: string;
  readonly libDir: string;
}

const failure = (reason: string) => new EmulatorFailure({ engine: "dynamodb-local", reason });

const dir = join(homedir(), ".cache", "alias", `dynamodb-local-${RELEASE.version}`);

/** Every worktree and clone on the machine shares this directory. */
export const installation: Installation = {
  dir,
  jar: join(dir, "DynamoDBLocal.jar"),
  libDir: join(dir, "DynamoDBLocal_lib"),
};

const decodeAddress = Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Number }));

/** DynamoDB Local rejects port 0, so ask the OS for a free port first. */
const freePort = Effect.callback<number, EmulatorFailure>((resume) => {
  const probe = createServer();
  probe.once("error", (error) => resume(Effect.fail(failure(error.message))));
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() =>
      resume(
        decodeAddress(address).pipe(
          Effect.map((decoded) => decoded.port),
          Effect.mapError(() => failure("probe socket has no TCP address")),
        ),
      ),
    );
  });
});

const make = Effect.fn("DynamoDbLocal.make")(function* () {
  if (!existsSync(installation.jar)) {
    return yield* failure("not installed; run `pnpm agent:setup`");
  }
  const found = installation;
  const java = yield* resolveTool("java");
  const port = yield* freePort;
  // DynamoDB Local writes a metadata file into its working directory; keep it out of the repo.
  const workDir = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "alias-dynamodb-local-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  const url = `http://127.0.0.1:${port}`;

  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      spawn(
        java,
        [
          `-Djava.library.path=${found.libDir}`,
          "-jar",
          found.jar,
          "-inMemory",
          "-port",
          String(port),
        ],
        { cwd: workDir, stdio: "ignore" },
      ),
    ),
    (process) =>
      Effect.callback<void>((resume) => {
        if (process.exitCode !== null) return resume(Effect.void);
        process.once("exit", () => resume(Effect.void));
        process.kill("SIGKILL");
      }),
  );

  const exited = Effect.callback<never, EmulatorFailure>((resume) => {
    child.once("error", (error) =>
      resume(Effect.fail(failure(`cannot start java: ${error.message}`))),
    );
    child.once("exit", (code) => resume(Effect.fail(failure(`exited early with code ${code}`))));
  });

  const ready = Effect.tryPromise({
    try: () => fetch(url, { method: "POST" }),
    catch: () => failure("not ready"),
  }).pipe(
    Effect.retry(Schedule.spaced(Duration.millis(50))),
    Effect.timeoutOrElse({
      duration: Duration.seconds(30),
      orElse: () => Effect.fail(failure("did not start within 30 s")),
    }),
  );

  yield* Effect.raceFirst(ready, exited).pipe(inRealTime);
  return DynamoDbEndpoint.of({ url, engine: "dynamodb-local" });
});

export const layer = () => Layer.effect(DynamoDbEndpoint, make());
