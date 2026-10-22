/**
 * Compiles the `alias` CLI into single-file executables with Bun (from mise.toml):
 * `apps/cli/dist/alias-<target>`. Usage: `node scripts/compile-cli.ts [target…]`, targets as Bun
 * names them (`darwin-arm64`, `linux-x64`); default: this machine's. A binary built for this
 * machine is run once (`--version`, and `whoami` without a login must fail with its message), so a
 * build that compiles but can't start fails here, not on a user's machine.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeRoot } from "./lib/worktree.ts";

const root = worktreeRoot();
const host = `${process.platform}-${process.arch}`;
const targets = process.argv.length > 2 ? process.argv.slice(2) : [host];
const { version } = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8")) as {
  version: string;
};

for (const target of targets) {
  const outfile = join(root, "apps/cli/dist", `alias-${target}`);
  execFileSync(
    "bun",
    [
      "build",
      "--compile",
      "--minify",
      `--target=bun-${target}`,
      join(root, "apps/cli/bin/alias.ts"),
      "--outfile",
      outfile,
    ],
    { stdio: "inherit" },
  );
  if (target !== host) continue;

  const reported = execFileSync(outfile, ["--version"], { encoding: "utf8" }).trim();
  if (reported !== `alias v${version}`) throw new Error(`${outfile} --version said "${reported}"`);
  const empty = mkdtempSync(join(tmpdir(), "alias-cli-smoke-"));
  const whoami = spawnSync(outfile, ["whoami"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ALIAS_CONFIG_DIR: empty },
  });
  if (whoami.status !== 1 || !`${whoami.stdout}${whoami.stderr}`.includes("Not logged in")) {
    throw new Error(`${outfile} whoami without a login: exit ${whoami.status}\n${whoami.stderr}`);
  }
  console.log(`${outfile}: ${reported}, starts and fails cleanly without a login`);
}
