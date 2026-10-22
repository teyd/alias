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
| +8 | image proxy, the real Lambda handler behind the function URL emulator (`apps/image-proxy/bin/dev.ts`); serves the proxied images of forwarded mail in `proxy-images` mode (PLAN.md §20.19). Worktrees set up before it existed need `pnpm agent:setup` again for `ALIAS_IMAGE_PROXY_PORT`. |

On start, the api creates the table from `Table.spec` and seeds `shop@alias.test` for a demo user whose verified forwarding address is `demo@mailbox.test` (`ALIAS_DEV_RECIPIENT` overrides it). Inbound creates the `alias-spool` bucket and verifies the dev domains (`alias.test`, `custom.test`) as SES sending identities on fakecloud. It signs reverse aliases with a fixed dev key that it puts into fakecloud's SSM Parameter Store as the `SecureString` `/alias/dev/reverse-token-keys` (only if that parameter doesn't exist yet, so `aws --endpoint-url http://localhost:$ALIAS_FAKECLOUD_PORT ssm put-parameter --overwrite …` replaces it) and reads back the way the Lambda does. Image proxy URLs are signed the same way with `/alias/dev/image-proxy-keys`, which the image proxy reads (it waits until inbound has put it). All of this is idempotent across restarts.

fakecloud accepts a sender only on an exactly verified domain, while AWS also accepts its subdomains (PLAN.md §20.5). So, in dev only, `apps/api/bin/dev.ts` verifies `<username>.<shared domain>` as an SES identity whenever someone signs up. Users created before that hook existed (or seeded straight into the table) still get their subdomain mail dropped as `rejected` until you verify it: `aws sesv2 create-email-identity --email-identity ada.alias.test --endpoint-url http://localhost:$ALIAS_FAKECLOUD_PORT --region eu-west-1`.

Bounces and complaints: both dev bins send through the `alias-events` configuration set; inbound creates it with an SNS destination and feeds every notification to the feedback handler (log lines `feedback bounce` / `feedback complaint`). Add `bounce@simulator.amazonses.com` as a forwarding address to watch a confirmation bounce, the recipient get `bouncedAt`, and later forwards drop as `recipient-bounced`.

Webhooks (PLAN.md §20.20): the api, inbound and feedback publish to the SQS queue `alias-webhooks` on fakecloud, and a fourth process, `webhooks` (`apps/webhooks/bin/dev.ts`), polls it with the emulated event source mapping and runs the real delivery handler (log lines `webhook event queued`, `webhook delivered` / `webhook retry`). Dev allows `http://localhost` receivers (`ALIAS_WEBHOOK_ALLOW_LOOPBACK`), production never does. Register an endpoint in Settings (signed in), or `POST /v1/webhooks {"url": "http://localhost:9000/hook", "eventTypes": ["mail.forwarded"]}`, then mail the alias. Failed deliveries come back after 5 s, 5 min, 30 min…; peek at the queue with `aws sqs receive-message --queue-url http://localhost:$ALIAS_FAKECLOUD_PORT/123456789012/alias-webhooks --endpoint-url http://localhost:$ALIAS_FAKECLOUD_PORT --region eu-west-1`.

On-the-fly aliases: turn them on with `PATCH /v1/settings {"isOnTheFlyEnabled": true}` (signed in), then mail any new address on your subdomain; the inbound log shows `inbound alias created on the fly` before `inbound forwarded`.

## Common tasks

- **See your ports:** `cat .dev/env`
- **Check the API:** `curl localhost:$ALIAS_API_PORT/v1/aliases/alias.test/shop`. Vite listens on `localhost`, which may be IPv6 only, so use `localhost`, not `127.0.0.1`, for the web port.
- **Send a test mail:** `swaks --server localhost:$ALIAS_SMTP_PORT --from orders@store.example --to shop@alias.test` (or any SMTP client). The inbound log shows `inbound forwarded` (or `inbound dropped <reason>`) per recipient, and the forwarded copy, sent from a `shop+r.<token>@alias.test` reverse alias to `demo@mailbox.test`, appears in fakecloud's sent mail. Reply by sending from `demo@mailbox.test` to that reverse alias.
- **Read sent mail:** `curl -s localhost:$ALIAS_FAKECLOUD_PORT/_fakecloud/ses/emails | jq '.emails[] | {messageId, from, to}'`. Each entry's `rawData` holds the raw MIME as base64 (`jq -r '.emails[-1].rawData' | base64 -d`). Tests use `FakeCloud.sentEmails` from `@alias/aws-emulators` instead.
- **List spooled mail:** `curl "localhost:$ALIAS_FAKECLOUD_PORT/alias-spool?list-type=2"`
- **Query DynamoDB directly:** `aws dynamodb scan --table-name alias --endpoint-url http://localhost:$ALIAS_FAKECLOUD_PORT --region eu-west-1`. Any dummy credentials work.
- **Reset local data:** stop `pnpm dev`, then `rm -rf .dev/fakecloud`.
- **DynamoDB Local missing:** `pnpm agent:setup` (or `node tools/aws-emulators/bin/install-dynamodb-local.ts`, which installs to `~/.cache/alias`).
