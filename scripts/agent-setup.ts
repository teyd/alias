/**
 * Prepares a worktree for an agent (or a human). It installs dependencies and DynamoDB Local,
 * claims a port block, and writes `.dev/env`. Safe to re-run; T3 Code runs it when it creates a
 * worktree.
 * `pnpm agent:setup` runs it under `mise exec`, so Node, pnpm and Java come from mise.toml.
 */
import { execFileSync } from "node:child_process";
import { allocatePorts, toEnv } from "./lib/ports.ts";
import { writeDevEnv } from "./lib/devEnv.ts";
import { worktreeRoot, worktreeSlug } from "./lib/worktree.ts";

const root = worktreeRoot();

if (!process.argv.includes("--skip-install")) {
  execFileSync("pnpm", ["install"], { cwd: root, stdio: "inherit" });
}

// Amazon DynamoDB Local, the reference DynamoDB emulator (runs on mise's Java 17).
execFileSync("node", ["tools/aws-emulators/bin/install-dynamodb-local.ts"], {
  cwd: root,
  stdio: "inherit",
});

const block = await allocatePorts(root);
const slug = worktreeSlug(root);
writeDevEnv(root, {
  ALIAS_WORKTREE: slug,
  ALIAS_STAGE: "local",
  ALIAS_SHARED_DOMAINS: "alias.test",
  ...toEnv(block),
});

console.log(`\nworktree  ${slug}`);
console.log(`ports     ${block.base}-${block.base + 19}`);
console.log(`  web     http://localhost:${block.web}`);
console.log(`  api     http://localhost:${block.api}`);
console.log(`  smtp    localhost:${block.smtp}  (ses-emulator inbound)`);
console.log(
  `  aws     http://localhost:${block.fakecloud}  (fakecloud: S3 + DynamoDB, data in .dev/fakecloud)`,
);
console.log(`\nnext: pnpm dev   |   pnpm test   |   pnpm test:affected`);
