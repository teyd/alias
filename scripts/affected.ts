/**
 * Runs a task only in workspace packages changed since the base branch, plus their
 * dependents. Usage: `node scripts/affected.ts test [--base origin/main]`.
 * Root-level config changes run the task everywhere.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { worktreeRoot } from "./lib/worktree.ts";

const root = worktreeRoot();
const [task, ...rest] = process.argv.slice(2);
if (task === undefined) {
  console.error("usage: node scripts/affected.ts <task> [--base <ref>]");
  process.exit(1);
}
const baseFlag = rest.indexOf("--base");
const git = (...args: Array<string>) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const lines = (output: string) => output.split("\n").filter((line) => line.length > 0);

const resolveBase = (): string | undefined => {
  if (baseFlag !== -1) return rest[baseFlag + 1];
  for (const candidate of ["origin/main", "main"]) {
    try {
      return git("merge-base", "HEAD", candidate).trim();
    } catch {
      // try the next candidate
    }
  }
  return undefined;
};

const ROOT_FILES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "vite.config.ts",
  "tsconfig.base.json",
]);

const packages = ["apps", "packages", "tools"]
  .flatMap((group) =>
    existsSync(join(root, group))
      ? readdirSync(join(root, group)).map((name) => join(group, name))
      : [],
  )
  .concat(["infra", "e2e", "browser"])
  .filter((dir) => existsSync(join(root, dir, "package.json")))
  .map((dir) => {
    const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as {
      name: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      dir,
      name: manifest.name,
      hasTask: manifest.scripts?.[task] !== undefined,
      dependsOn: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }),
    };
  });

const hasCommits = (() => {
  try {
    git("rev-parse", "--verify", "HEAD");
    return true;
  } catch {
    return false;
  }
})();

// Without a first commit there is nothing to diff against, so `base` stays undefined and the task
// runs everywhere.
const base = hasCommits ? resolveBase() : undefined;
const changed = new Set<string>(
  hasCommits
    ? [
        ...(base === undefined ? [] : lines(git("diff", "--name-only", `${base}...HEAD`))),
        ...lines(git("diff", "--name-only", "HEAD")),
        ...lines(git("ls-files", "--others", "--exclude-standard")),
      ]
    : [],
);

const runAll = base === undefined || [...changed].some((file) => ROOT_FILES.has(file));
// A changed package without the task (infra) only matters through its dependents; with none,
// `vp run` would fail on a selection that has no such task.
const touched = packages.filter(
  (pkg) =>
    [...changed].some((file) => !relative(pkg.dir, file).startsWith("..")) &&
    (pkg.hasTask || packages.some((other) => other.dependsOn.includes(pkg.name))),
);

// Every package but the root, whose own scripts wrap this one (`vp run -r` would recurse).
const rootName = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string })
  .name;
const args = runAll
  ? ["exec", "vp", "run", "--filter", `!${rootName}`, task]
  : touched.length === 0
    ? undefined
    : ["exec", "vp", "run", ...touched.flatMap((pkg) => ["--filter", `...${pkg.name}`]), task];

if (args === undefined) {
  console.log(`No changed workspace package needs "${task}"; nothing to run.`);
  process.exit(0);
}

console.log(
  runAll
    ? `Running "${task}" everywhere (root config changed or no base branch).`
    : `Running "${task}" for ${touched.map((pkg) => pkg.name).join(", ")} and their dependents.`,
);
execFileSync("pnpm", args, { cwd: root, stdio: "inherit" });
