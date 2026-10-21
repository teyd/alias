/**
 * Downloads Amazon DynamoDB Local into the per-user cache and verifies its SHA-256.
 * Idempotent. It does nothing when the pinned version is already installed.
 * Usage: node bin/install-dynamodb-local.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DynamoDbLocal } from "../src/index.ts";

const { RELEASE, installation: target } = DynamoDbLocal;

if (existsSync(target.jar)) {
  console.log(`DynamoDB Local ${RELEASE.version} already installed (${target.dir})`);
  process.exit(0);
}

console.log(`Downloading DynamoDB Local ${RELEASE.version}…`);
const response = await fetch(RELEASE.url);
if (!response.ok) {
  console.error(`Download failed: HTTP ${response.status}`);
  process.exit(1);
}
const archive = new Uint8Array(await response.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== RELEASE.sha256) {
  console.error(
    `Checksum mismatch: expected ${RELEASE.sha256}, got ${digest}.\n` +
      "AWS has probably published a new release at the same URL. Check the release notes, then update RELEASE in src/DynamoDbLocal.ts.",
  );
  process.exit(1);
}

const staging = `${target.dir}.partial-${process.pid}`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
writeFileSync(`${staging}/archive.tar.gz`, archive);
execFileSync("tar", ["-xzf", "archive.tar.gz"], { cwd: staging });
rmSync(`${staging}/archive.tar.gz`);
rmSync(target.dir, { recursive: true, force: true });
renameSync(staging, target.dir);
console.log(`Installed DynamoDB Local ${RELEASE.version} to ${target.dir}`);
