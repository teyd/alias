import { readFileSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite-plus";
import { manifest, type Target } from "./src/Manifest.ts";

/**
 * Builds the unpacked extension for one browser (PLAN.md §20.35): the popup and the background
 * bundled by Vite, every script local (no remote code), the manifest, the icons. Run by
 * `pnpm --filter @alias/extension build` (both browsers into `dist/<target>`), by
 * `scripts/package-extension.ts`, and by the browser tests.
 */

const root = dirname(fileURLToPath(import.meta.url));

interface Options {
  readonly target: Target;
  readonly outDir: string;
  /** The server offered at sign-in and granted at install, e.g. `https://alias.example`. */
  readonly server?: string;
  /**
   * More origins granted at install. Only tests use it: they can't click the toolbar button or
   * the context menu, the gestures that grant `activeTab`, so the test site is granted outright.
   */
  readonly extraHostOrigins?: ReadonlyArray<string>;
}

export const version = (): string =>
  (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

export const buildExtension = async (options: Options) => {
  await rm(options.outDir, { recursive: true, force: true });
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    plugins: [react()],
    define: { "import.meta.env.VITE_ALIAS_SERVER": JSON.stringify(options.server ?? "") },
    build: {
      outDir: options.outDir,
      emptyOutDir: true,
      // Readable output: store reviewers read it, and it's small either way.
      minify: false,
      modulePreload: false,
      rollupOptions: {
        input: { popup: join(root, "popup.html"), background: join(root, "src/background.ts") },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });
  await mkdir(join(options.outDir, "icons"), { recursive: true });
  await cp(join(root, "icons"), join(options.outDir, "icons"), { recursive: true });
  const hostOrigins = [
    ...(options.server === undefined ? [] : [options.server]),
    ...(options.extraHostOrigins ?? []),
  ];
  await writeFile(
    join(options.outDir, "manifest.json"),
    `${JSON.stringify(manifest({ target: options.target, version: version(), hostOrigins }), null, 2)}\n`,
  );
};

// `node build.ts`: both browsers, with the server from `ALIAS_EXTENSION_SERVER` if set.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = process.env.ALIAS_EXTENSION_SERVER;
  for (const target of ["chromium", "firefox"] as const) {
    await buildExtension({
      target,
      outDir: join(root, "dist", target),
      ...(server === undefined || server === "" ? {} : { server }),
    });
  }
}
