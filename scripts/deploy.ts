/**
 * Deploys a stage to AWS and Cloudflare: `pnpm infra:deploy [alchemy flags]`, e.g. `--yes` to skip
 * Alchemy's confirmation. Settings come from the environment or `infra/.env` (every one is
 * described in `infra/.env.example`); the one-time account steps are PLAN.md §20.37.
 *
 * Builds the web app (`apps/web/dist`, which the stack uploads), then runs `alchemy deploy --stage
 * <ALIAS_STAGE>` in `infra/`. Everything else, the keyrings included, is the stack's. AWS
 * credentials are Alchemy's own (its profile, `pnpm infra:alchemy profile edit`); it runs under
 * `mise -E deploy`, so the `aws sso login` Alchemy starts for an SSO profile finds the AWS CLI
 * from `mise.deploy.toml`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { worktreeRoot } from "./lib/worktree.ts";

const root = worktreeRoot();
const envFile = join(root, "infra/.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const stage = process.env.ALIAS_STAGE?.trim() ?? "";
// Cloudflare's credentials may come from the environment or from Alchemy's profile, which only
// Alchemy can tell; it stops with its own message when neither has them.
const required = ["ALIAS_STAGE", "ALIAS_SHARED_DOMAINS"];
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
// Alchemy refuses its prompts when it sees a coding agent's variables (`AI_AGENT`, `CLAUDECODE`,
// …), which terminals opened from such tools inherit; this keeps the prompts for a person at a
// terminal. Without a TTY (CI, an agent's pipe) Alchemy still runs non-interactively.
process.env.ALCHEMY_TUI = "1";

const run = (command: string, args: Array<string>, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: "inherit", env: process.env });

run("pnpm", ["--filter", "@alias/web", "build"]);
run(
  join(root, "infra/node_modules/.bin/alchemy"),
  ["deploy", "--stage", stage, ...process.argv.slice(2)],
  join(root, "infra"),
);
