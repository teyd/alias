/**
 * Builds the browser extension for Chromium and Firefox and zips each build, ready to upload to
 * the Chrome Web Store and to addons.mozilla.org (PLAN.md §20.35). Publishing needs the
 * maintainers' store accounts; this only makes the artifacts.
 *
 *   pnpm extension:package                       # apps/extension/dist/alias-<target>-<version>.zip
 *   ALIAS_EXTENSION_SERVER=https://alias.example pnpm extension:package
 *
 * The zips are reproducible: entries sorted, every timestamp 1980-01-01, so the same source gives
 * the same bytes (AMO reviewers rebuild from source and compare).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { buildExtension, version } from "../apps/extension/build.ts";

const root = join(import.meta.dirname, "..", "apps", "extension", "dist");

const files = async (dir: string): Promise<Array<string>> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
};

/** 1980-01-01 00:00 in DOS date and time: the earliest a zip can say. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;

/** A zip (PKWARE APPNOTE 6.3) of every file under `dir`, deflated, names relative to it. */
const zip = async (dir: string): Promise<Buffer> => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;
  for (const path of await files(dir)) {
    const name = Buffer.from(relative(dir, path).split(sep).join("/"));
    const data = await readFile(path);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const server = process.env.ALIAS_EXTENSION_SERVER;
for (const target of ["chromium", "firefox"] as const) {
  const outDir = join(root, target);
  await buildExtension({ target, outDir, ...(server ? { server } : {}) });
  const archive = join(root, `alias-${target}-${version()}.zip`);
  await writeFile(archive, await zip(outDir));
  console.log(`${relative(process.cwd(), archive)}`);
}
