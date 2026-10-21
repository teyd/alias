---
name: alias-testing
description: Use when writing, placing, or debugging tests in the Alias repo. Explains the test tiers (unit, repository, contract, stack), the emulators behind them (fakecloud, DynamoDB Local, ses-emulator, lambda-emulator), how to keep tests hermetic so parallel agents can run them, and which command runs which suite.
---

# Testing in Alias

Everything runs against emulators. There is no AWS account and no Docker in any test. Tools (fakecloud, Java for DynamoDB Local) come from `mise.toml`.

## Pick the tier

| Tier | Runs | Use for | Example |
|---|---|---|---|
| unit | Node | Pure logic and emulator behaviour | `packages/core/test`, `tools/*/test` |
| repository | Node + **fakecloud and DynamoDB Local** | Anything that reads or writes DynamoDB | `packages/db/test/support/aliasRepoSuite.ts` |
| contract | Node | Checking AWS payloads (from docs now, recorded later) and emulator output against the schemas production parses with | `packages/aws/test`, `tools/ses-emulator/test/Headers.test.ts` |
| handler | Node + fakecloud | A Lambda handler called with real-shaped events | `apps/api/test/api.test.ts` |
| stack | Node + one fakecloud | Paths across services: SMTP → SES emulator → S3, HTTP → function URL emulator → handler → DynamoDB | `e2e/test/stack.test.ts` |

Prefer the lowest tier that can observe the behaviour, but every new path through the system also gets one stack test.

## The emulators

| AWS service | Emulator | Verified by |
|---|---|---|
| DynamoDB | `FakeCloud.layer()` and `DynamoDbLocal.layer()` (AWS's own, Java) | the same repository suite passing on both |
| S3 | `FakeCloud.layer()` | `tools/aws-emulators/test`; production code (`Inbound.readMessage`) reads what the SES emulator wrote |
| SES receiving | `SesEmulator.layer(config)` (SMTP, receipt rules, verdicts, S3 action, Lambda events) | `SesEvent` schema decodes the AWS-documented event and the emulator's events |
| SES sending (SESv2 `SendEmail`) | `FakeCloud.layer()`; read sent mail with `FakeCloud.sentEmails` | `Transport` decodes the AWS-documented response and fakecloud's; the documented raw message arrives byte for byte (PLAN.md §20.5) |
| Lambda function URLs | `FunctionUrlServer.layer({ handler })` | `FunctionUrl` schemas decode AWS-documented payloads; emulator events decode with them |

Clients point at emulators through `AwsClient.emulator(url)` from `@alias/aws`. A new AWS dependency needs an emulator and a contract test before any feature uses it.

## Hermetic rules

1. Port `0` only. Read the bound port back from the service (`FakeCloud.url`, `emulator.smtpPort`, `FunctionUrlServer.url`).
2. One emulator process per test file is fine. Use one **table per test** (`freshTable()` from `@alias/db/testing`).
3. No Docker, no network, no cloud credentials.
4. Time and randomness come from Effect services (`TestClock`, `Crypto`), not `Date.now()`. Emulators that wait for a real process use `inRealTime`.

## Write once, run on many backends

For anything behind a service interface, put the behaviour in `test/support/<name>Suite.ts`, which takes the backend as a layer. Then add one tiny runner file per backend (`*.fakecloud.test.ts`, `*.dynamodb-local.test.ts`).

## Commands

```sh
pnpm test:affected                                  # before handing work back
pnpm --filter @alias/db test:dynamodb-local         # one tier
pnpm --filter @alias/api test -- -t "404"           # one test by name
```

`pnpm test` runs under `mise exec`, because `vp run` passes only a filtered environment to tasks.

## Known issues

- `@distilled.cloud/aws` treats some "already exists" errors as retryable (for example, DynamoDB `ResourceInUseException`). Idempotent create helpers pass `Retry.none`. See `Table.ensure`.
- DynamoDB Local rejects port 0, so `DynamoDbLocal.ts` picks a free port first.
- The AWS doc samples contain placeholders (`<url-id>`); tests substitute realistic values where an invalid URL would otherwise be built.
