/**
 * Deploys a stage to AWS and Cloudflare: `pnpm infra:deploy [alchemy flags]`, e.g. `--yes` to skip
 * Alchemy's confirmation. Settings come from the environment or `infra/.env` (every one is
 * described in `infra/.env.example`); the one-time account steps are PLAN.md §20.37.
 *
 * Runs under `mise -E deploy`, which adds the AWS CLI (`mise.deploy.toml`) to mise.toml's tools.
 *
 * 1. AWS credentials: unless `AWS_ACCESS_KEY_ID` is set, the session of `pnpm infra:aws sso login`
 *    (the profile in `AWS_PROFILE`) is exported once into the environment, so Alchemy, the bootstrap
 *    and the stack's own reads (the origin secret, ACM) all use the same short-lived keys.
 * 2. The web app's production build (`apps/web/dist`), which the stack uploads.
 * 3. `scripts/bootstrap-stage.ts`: the stage's SSM keyrings, made once and never overwritten.
 * 4. `alchemy deploy --stage <ALIAS_STAGE>` in `infra/`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { worktreeRoot } from "./lib/worktree.ts";

const root = worktreeRoot();
const envFile = join(root, "infra/.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const stage = process.env.ALIAS_STAGE?.trim() ?? "";
const required = [
  "ALIAS_STAGE",
  "ALIAS_SHARED_DOMAINS",
  // The `local` stage has no Cloudflare (`isOnCloudflare` in infra/alchemy.run.ts).
  ...(stage === "local" ? [] : ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]),
];
const missing = required.filter((name) => (process.env[name]?.trim() ?? "") === "");
if (missing.length > 0) {
  console.error(`Missing ${missing.join(", ")}: see infra/.env.example.`);
  process.exit(1);
}
if ((process.env.ALIAS_ALERT_EMAIL?.trim() ?? "") === "") {
  console.warn("ALIAS_ALERT_EMAIL is unset: alarms and the budget will mail nobody.");
}

// The service runs in eu-west-1 only; ACM and Budgets name their own regions.
process.env.AWS_REGION = "eu-west-1";
if ((process.env.AWS_ACCESS_KEY_ID ?? "") === "") {
  const exported = JSON.parse(
    execFileSync("aws", ["configure", "export-credentials", "--format", "process"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  ) as { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string };
  process.env.AWS_ACCESS_KEY_ID = exported.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = exported.SecretAccessKey;
  if (exported.SessionToken !== undefined) process.env.AWS_SESSION_TOKEN = exported.SessionToken;
}

const run = (command: string, args: Array<string>, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: "inherit", env: process.env });

run("pnpm", ["--filter", "@alias/web", "build"]);
run("node", [join(root, "scripts/bootstrap-stage.ts")]);
run(
  "pnpm",
  ["exec", "alchemy", "deploy", "--stage", stage, ...process.argv.slice(2)],
  join(root, "infra"),
);
