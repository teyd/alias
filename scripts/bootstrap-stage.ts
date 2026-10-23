/**
 * Creates the keyrings a stage reads from SSM Parameter Store (PLAN.md §20.14, §20.19, §20.22.2,
 * §20.26, §20.30) that don't exist yet, each a `SecureString` holding one fresh key
 * (`1:<base64url of 32 random bytes>`, `Keyring.parse` in `@alias/core`). An existing parameter is
 * never read or overwritten: `PutParameter` without `--overwrite` refuses it, so running this
 * twice, or against a stage whose keys were rotated by hand, changes nothing. The values stay out
 * of the Alchemy state (the owner's decision); only `origin-secrets` is read back, by the deploy.
 *
 * Usage: `ALIAS_STAGE=<stage> node scripts/bootstrap-stage.ts`, with AWS credentials in the
 * environment (`scripts/deploy.ts` runs it with them). Needs the AWS CLI v2.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = process.env.ALIAS_STAGE?.trim() ?? "";
if (!/^[a-z0-9][a-z0-9-]*$/.test(stage)) {
  console.error("ALIAS_STAGE must name the stage (lowercase letters, digits and dashes).");
  process.exit(1);
}

/** Every keyring `infra/alchemy.run.ts` names; the Turnstile secret is the stack's own. */
const keyrings = [
  "reverse-token-keys",
  "image-proxy-keys",
  "inbox-keys",
  "webhook-keys",
  "origin-secrets",
];

// The value goes to the CLI in a file only this user can read, never on its command line, where
// any process on the machine could see it.
const scratch = mkdtempSync(join(tmpdir(), "alias-bootstrap-"));
try {
  for (const keyring of keyrings) {
    const name = `/alias/${stage}/${keyring}`;
    const input = join(scratch, `${keyring}.json`);
    writeFileSync(
      input,
      JSON.stringify({
        Name: name,
        Type: "SecureString",
        Value: `1:${randomBytes(32).toString("base64url")}`,
        Description: "Keyring (PLAN.md §20.14); made by scripts/bootstrap-stage.ts",
      }),
      { mode: 0o600 },
    );
    const put = spawnSync(
      "aws",
      ["ssm", "put-parameter", "--region", "eu-west-1", "--cli-input-json", `file://${input}`],
      { encoding: "utf8" },
    );
    rmSync(input);
    if (put.error !== undefined) throw put.error;
    if (put.status === 0) {
      console.log(`created ${name}`);
    } else if (put.stderr.includes("ParameterAlreadyExists")) {
      console.log(`kept    ${name}`);
    } else {
      console.error(put.stderr.trim());
      throw new Error(`could not create ${name}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
