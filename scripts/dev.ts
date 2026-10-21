/** Starts the interactive stack for this worktree on its own port block. */
import { spawn, type ChildProcess } from "node:child_process";
import { readDevEnv } from "./lib/devEnv.ts";
import { worktreeRoot } from "./lib/worktree.ts";

const root = worktreeRoot();
const devEnv = readDevEnv(root);

const env = { ...process.env, ...devEnv, FORCE_COLOR: "1" };

// Everything is emulated: no cloud account, no Docker. fakecloud (from mise.toml; `pnpm dev`
// runs under `mise exec`) is S3 + DynamoDB with state in .dev/fakecloud. The API is the real
// Lambda handler behind the function URL emulator; it seeds a demo alias.
const services: Array<{ name: string; cwd: string; command: string; args: Array<string> }> = [
  {
    name: "fakecloud",
    cwd: root,
    command: "fakecloud",
    args: [
      "--addr",
      `127.0.0.1:${devEnv.ALIAS_FAKECLOUD_PORT}`,
      "--region",
      "eu-west-1",
      "--log-level",
      "error",
      "--storage-mode",
      "persistent",
      "--data-path",
      `${root}/.dev/fakecloud`,
    ],
  },
  { name: "api", cwd: `${root}/apps/api`, command: "node", args: ["bin/dev.ts"] },
  { name: "web", cwd: `${root}/apps/web`, command: "pnpm", args: ["exec", "vp", "dev"] },
  {
    name: "ses",
    cwd: `${root}/tools/ses-emulator`,
    command: "node",
    args: ["bin/serve.ts"],
  },
];

const children: Array<ChildProcess> = [];

const prefix = (name: string, chunk: Buffer) =>
  chunk
    .toString()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `[${name}] ${line}`)
    .join("\n");

for (const service of services) {
  const child = spawn(service.command, service.args, { cwd: service.cwd, env });
  child.stdout?.on("data", (chunk: Buffer) => console.log(prefix(service.name, chunk)));
  child.stderr?.on("data", (chunk: Buffer) => console.error(prefix(service.name, chunk)));
  child.on("exit", (code) => {
    console.log(`[${service.name}] exited with ${code}`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

let stopping = false;
const shutdown = (code: number) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(
  `web http://localhost:${devEnv.ALIAS_WEB_PORT}  api http://localhost:${devEnv.ALIAS_API_PORT}  smtp localhost:${devEnv.ALIAS_SMTP_PORT}  fakecloud http://localhost:${devEnv.ALIAS_FAKECLOUD_PORT}`,
);
