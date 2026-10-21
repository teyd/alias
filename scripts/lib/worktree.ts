import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

const git = (...args: Array<string>): string =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

/** Absolute path of the current worktree (each agent works in its own). */
export const worktreeRoot = (): string => git("rev-parse", "--show-toplevel");

/** The `.git` directory shared by every worktree of this repository. */
export const gitCommonDir = (): string =>
  resolve(worktreeRoot(), git("rev-parse", "--git-common-dir"));

export const worktreeSlug = (root = worktreeRoot()): string =>
  basename(root)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
