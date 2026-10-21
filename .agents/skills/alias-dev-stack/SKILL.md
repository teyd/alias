---
name: alias-dev-stack
description: Use when starting, debugging, or poking the local Alias stack (fakecloud for S3, DynamoDB and SES sending, API Lambda behind the function URL emulator, Vite web app, ses-emulator), when ports collide between worktrees, or when sending test mail locally.
---

# Local dev stack

`pnpm agent:setup` installs the mise tools, dependencies and DynamoDB Local, claims a 20-port block for this worktree and writes `.dev/env`. The block is recorded in `<git-common-dir>/alias-dev-ports.json`, which all worktrees share. `pnpm dev` reads `.dev/env` and runs under `mise exec`.

| Offset | Service |
|---|---|
| +0 | web (`vp dev`, proxies `/v1` and `/health` to the api) |
| +1 | api, the real Lambda handler behind the function URL emulator (`apps/api/bin/dev.ts`) |
| +2 | ses-emulator SMTP inbound (spools to S3 on fakecloud) |
| +4/+5 | Mailpit UI/SMTP (optional) |
| +7 | fakecloud (S3, DynamoDB and SESv2 sending), with state in `.dev/fakecloud` |

On start, the api creates the table from `Table.spec` and seeds `shop@alias.test`. The ses-emulator creates the `alias-spool` bucket and verifies the dev domains (`alias.test`, `custom.test`) as SES sending identities on fakecloud. All of this is idempotent across restarts.

## Common tasks

- **See your ports:** `cat .dev/env`
- **Check the API:** `curl localhost:$ALIAS_API_PORT/v1/aliases/alias.test/shop`. Vite listens on `localhost`, which may be IPv6 only, so use `localhost`, not `127.0.0.1`, for the web port.
- **Send a test mail:** `swaks --server localhost:$ALIAS_SMTP_PORT --to shop@user1.alias.test` (or any SMTP client). The ses-emulator logs the Lambda event it would invoke.
- **Read sent mail:** `curl -s localhost:$ALIAS_FAKECLOUD_PORT/_fakecloud/ses/emails | jq '.emails[] | {messageId, from, to}'`. Each entry's `rawData` holds the raw MIME as base64 (`jq -r '.emails[-1].rawData' | base64 -d`). Tests use `FakeCloud.sentEmails` from `@alias/aws-emulators` instead.
- **List spooled mail:** `curl "localhost:$ALIAS_FAKECLOUD_PORT/alias-spool?list-type=2"`
- **Query DynamoDB directly:** `aws dynamodb scan --table-name alias --endpoint-url http://localhost:$ALIAS_FAKECLOUD_PORT --region eu-west-1`. Any dummy credentials work.
- **Reset local data:** stop `pnpm dev`, then `rm -rf .dev/fakecloud`.
- **DynamoDB Local missing:** `pnpm agent:setup` (or `node tools/aws-emulators/bin/install-dynamodb-local.ts`, which installs to `~/.cache/alias`).
