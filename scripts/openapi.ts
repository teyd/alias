/**
 * Writes the API's OpenAPI document to `packages/contracts/openapi.json`, the copy SDK users and
 * reviewers read. Usage: `node scripts/openapi.ts [--check]`; `--check` (run by `pnpm check`)
 * fails when the checked-in copy differs from what the contracts generate.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { openApiDocument } from "../packages/contracts/src/index.ts";

const file = new URL("../packages/contracts/openapi.json", import.meta.url);
const generated = `${JSON.stringify(openApiDocument, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(file, "utf8");
  if (current !== generated) {
    console.error("packages/contracts/openapi.json is out of date: run `pnpm openapi`.");
    process.exit(1);
  }
} else {
  writeFileSync(file, generated);
  console.log("wrote packages/contracts/openapi.json");
}
