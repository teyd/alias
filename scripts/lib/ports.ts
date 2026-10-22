import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { gitCommonDir } from "./worktree.ts";

/**
 * Every worktree gets a block of consecutive ports so parallel agents can run the
 * interactive stack side by side. This module records blocks in the git common dir, which
 * all worktrees of the repo share, so two worktrees never get the same block.
 */
const PORTS = {
  web: 0,
  api: 1,
  smtp: 2,
  sesApi: 3,
  mailpitUi: 4,
  mailpitSmtp: 5,
  inspector: 6,
  fakecloud: 7,
  imageProxy: 8,
} as const;

type PortName = keyof typeof PORTS;
export type PortBlock = Record<PortName, number> & { readonly base: number };

const FIRST_BASE = 41_000;
const BLOCK_SIZE = 20;
const MAX_BLOCKS = 200;

interface Registry {
  readonly blocks: Record<string, number>;
}

const registryPath = (): string => join(gitCommonDir(), "alias-dev-ports.json");

const readRegistry = (): Registry => {
  const path = registryPath();
  if (!existsSync(path)) return { blocks: {} };
  return JSON.parse(readFileSync(path, "utf8")) as Registry;
};

const writeRegistry = (registry: Registry): void => {
  const path = registryPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(tmp, path);
};

const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

const blockIsFree = async (base: number): Promise<boolean> => {
  for (const offset of Object.values(PORTS)) {
    if (!(await isFree(base + offset))) return false;
  }
  return true;
};

const toBlock = (base: number): PortBlock => ({
  base,
  ...(Object.fromEntries(
    Object.entries(PORTS).map(([name, offset]) => [name, base + offset]),
  ) as Record<PortName, number>),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Serializes registry updates across concurrently starting worktrees (mkdir is atomic). */
const withLock = async <A>(run: () => Promise<A>): Promise<A> => {
  const lock = `${registryPath()}.lock`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (attempt > 100) throw new Error(`Port registry is locked: ${lock}`);
      await sleep(50);
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

/** Returns this worktree's block, allocating (and recording) one if needed. */
export const allocatePorts = (worktree: string): Promise<PortBlock> =>
  withLock(() => allocate(worktree));

const allocate = async (worktree: string): Promise<PortBlock> => {
  const registry = readRegistry();
  const live = Object.fromEntries(
    Object.entries(registry.blocks).filter(([path]) => existsSync(path)),
  );

  const existing = live[worktree];
  if (existing !== undefined) {
    writeRegistry({ blocks: live });
    return toBlock(existing);
  }

  const taken = new Set(Object.values(live));
  for (let index = 0; index < MAX_BLOCKS; index += 1) {
    const base = FIRST_BASE + index * BLOCK_SIZE;
    if (taken.has(base) || !(await blockIsFree(base))) continue;
    writeRegistry({ blocks: { ...live, [worktree]: base } });
    return toBlock(base);
  }
  throw new Error(
    `No free port block between ${FIRST_BASE} and ${FIRST_BASE + MAX_BLOCKS * BLOCK_SIZE}`,
  );
};

export const toEnv = (block: PortBlock): Record<string, string> => ({
  ALIAS_PORT_BASE: String(block.base),
  ALIAS_WEB_PORT: String(block.web),
  ALIAS_API_PORT: String(block.api),
  ALIAS_SMTP_PORT: String(block.smtp),
  ALIAS_SES_API_PORT: String(block.sesApi),
  ALIAS_MAILPIT_UI_PORT: String(block.mailpitUi),
  ALIAS_MAILPIT_SMTP_PORT: String(block.mailpitSmtp),
  ALIAS_INSPECTOR_PORT: String(block.inspector),
  ALIAS_FAKECLOUD_PORT: String(block.fakecloud),
  ALIAS_IMAGE_PROXY_PORT: String(block.imageProxy),
});
