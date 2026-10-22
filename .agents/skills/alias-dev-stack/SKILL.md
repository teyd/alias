---
name: alias-dev-stack
description: Use when starting, debugging, or poking the local Alias stack (fakecloud for S3, DynamoDB and SES sending, API Lambda behind the function URL emulator, Vite web app, ses-emulator feeding the inbound Lambda), when ports collide between worktrees, or when sending test mail locally.
---

# Local dev stack

`pnpm agent:setup` installs the mise tools, dependencies and DynamoDB Local, claims a 20-port block for this worktree and writes `.dev/env`. The block is recorded in `<git-common-dir>/alias-dev-ports.json`, which all worktrees share. `pnpm dev` reads `.dev/env` and runs under `mise exec`.

| Offset | Service |
|---|---|
| +0 | web (`vp dev`, proxies `/v1` and `/health` to the api) |
| +1 | api, the real Lambda handler behind the function URL emulator (`apps/api/bin/dev.ts`) |
| +2 | ses-emulator SMTP inbound (spools to S3 on fakecloud), each Lambda event handed to the real inbound pipeline (`apps/inbound/bin/dev.ts`) |
| +4/+5 | Mailpit UI/SMTP (optional) |
| +7 | fakecloud (S3, DynamoDB and SESv2 sending), with state in `.dev/fakecloud` |

On start, the api creates the table from `Table.spec` and seeds `shop@alias.test` for a demo user whose verified forwarding address is `demo@mailbox.test` (`ALIAS_DEV_RECIPIENT` overrides it). Inbound creates the `alias-spool` bucket and verifies the dev domains (`alias.test`, `custom.test`) as SES sending identities on fakecloud. It signs reverse aliases with a fixed dev key unless `ALIAS_REVERSE_TOKEN_KEYS` is set. All of this is idempotent across restarts.

fakecloud accepts a sender only on an exactly verified domain, while AWS also accepts its subdomains (PLAN.md §20.5). Mail to aliases on `<user>.alias.test` is therefore dropped as `rejected` in dev until that subdomain is verified too.

## Common tasks

- **See your ports:** `cat .dev/env`
- **Check the API:** `curl localhost:$ALIAS_API_PORT/v1/aliases/alias.test/shop`. Vite listens on `localhost`, which may be IPv6 only, so use `localhost`, not `127.0.0.1`, for the web port.
- **Send a test mail:** `swaks --server localhost:$ALIAS_SMTP_PORT --from orders@store.example --to shop@alias.test` (or any SMTP client). The inbound log shows `inbound forwarded` (or `inbound dropped <reason>`) per recipient, and the forwarded copy, sent from a `shop+r.<token>@alias.test` reverse alias to `demo@mailbox.test`, appears in fakecloud's sent mail. Reply by sending from `demo@mailbox.test` to that reverse alias.
- **Read sent mail:** `curl -s localhost:$ALIAS_FAKECLOUD_PORT/_fakecloud/ses/emails | jq '.emails[] | {messageId, from, to}'`. Each entry's `rawData` holds the raw MIME as base64 (`jq -r '.emails[-1].rawData' | base64 -d`). Tests use `FakeCloud.sentEmails` from `@alias/aws-emulators` instead.
- **List spooled mail:** `curl "localhost:$ALIAS_FAKECLOUD_PORT/alias-spool?list-type=2"`
- **Query DynamoDB directly:** `aws dynamodb scan --table-name alias --endpoint-url http://localhost:$ALIAS_FAKECLOUD_PORT --region eu-west-1`. Any dummy credentials work.
- **Reset local data:** stop `pnpm dev`, then `rm -rf .dev/fakecloud`.
- **DynamoDB Local missing:** `pnpm agent:setup` (or `node tools/aws-emulators/bin/install-dynamodb-local.ts`, which installs to `~/.cache/alias`).
