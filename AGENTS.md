# Alias: agent guide

Open-source (AGPL-3.0) email alias service. The production target is AWS eu-west-1 (SES for all mail, S3, Lambda, DynamoDB), with Cloudflare used only for DNS. **Development and every test run against emulators**, with no AWS account and no Docker. Read `PLAN.md` (§15, §19, §20) for the architecture and the reasons behind it.

## Stack

TypeScript 7 · Effect v4 · Vite+ (`vp`) · React 19 · TanStack Router/Query/Form · shadcn/ui on Base UI · AWS Lambda (Node 24, arm64) + DynamoDB + SES + S3 · `@distilled.cloud/aws` (Effect-native AWS SDK) · Alchemy v2 (infra).

## Layout

| Path                    | What lives there                                                                                                                                                                                                                                                                                 | Test tier                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `packages/core`         | Pure domain logic (addresses, rewriting, reverse tokens, `SharedDomains`…). No I/O.                                                                                                                                                                                                              | unit                                          |
| `packages/contracts`    | Effect `HttpApi` + Schemas shared by API, web, CLI, MCP                                                                                                                                                                                                                                          | via api                                       |
| `packages/aws`          | The AWS boundary: `AwsClient` (real or emulated), Lambda/SES/SNS event schemas (incl. `SendingEvent` bounces/complaints), function URL adapter, `Inbound` spool (size/read/delete), `Transport` (SESv2 sending + suppression list), `Parameters` (SSM `SecureString`); `fixtures/` from AWS docs | contract                                      |
| `packages/db`           | DynamoDB single table (`Table.spec`) + repositories                                                                                                                                                                                                                                              | **fakecloud and DynamoDB Local** (same suite) |
| `apps/api`              | API Lambda: HttpApi handlers, `src/handler.ts` entrypoint, `bin/dev.ts` for `pnpm dev`                                                                                                                                                                                                           | handler on fakecloud                          |
| `apps/inbound`          | Inbound Lambda (SES receipt action): resolve → policy → loop/size/rate guards → rewrite → send, `src/handler.ts`; feedback Lambda (SNS: bounces/complaints), `src/feedbackHandler.ts`; `bin/dev.ts` runs the ses-emulator and the SNS subscriber into them                                       | unit + handler on fakecloud                   |
| `apps/web`              | React app on the design system (shadcn base-nova on Base UI, tokens in `src/styles.css`, PLAN.md §20.16); talks to the API only through `@alias/contracts`                                                                                                                                       | build + check                                 |
| `tools/ses-emulator`    | SES receiving: SMTP, receipt rules, verdicts, S3 action (to fakecloud), Lambda events                                                                                                                                                                                                            | unit + contract                               |
| `tools/aws-emulators`   | fakecloud (S3 + DynamoDB + SES sending/events + SNS + SSM, one process) and Amazon DynamoDB Local (Java), as Effect layers                                                                                                                                                                       | unit                                          |
| `tools/lambda-emulator` | Function URL server (HTTP ⇄ payload-2.0 events) and SNS subscriber (HTTP notifications → SNS Lambda events), as AWS documents                                                                                                                                                                    | unit + contract                               |
| `e2e`                   | Whole emulated stack (SMTP → SES → S3 → inbound Lambda (keys from SSM) → SES sending → SNS → feedback Lambda, HTTP → function URL → DynamoDB) on one fakecloud                                                                                                                                   | stack                                         |
| `infra/alchemy.run.ts`  | Production AWS resources (not deployed yet)                                                                                                                                                                                                                                                      | typecheck                                     |
| `scripts/*.ts`          | Repo tooling, run with plain `node` (no build step)                                                                                                                                                                                                                                              | none                                          |

## Commands

```sh
pnpm agent:setup        # once per worktree: mise tools, deps, DynamoDB Local, port block, .dev/env
pnpm dev                # fakecloud + api (function URL emulator) + web + inbound (ses-emulator → inbound Lambda) on this worktree's ports
pnpm check              # format + lint + typecheck (incl. infra) + knip (dead code), whole repo (~5 s)
pnpm test               # every suite, cached per package
pnpm test:affected      # only packages you changed + their dependents (use this before handing back)
pnpm --filter @alias/db test:dynamodb-local   # one tier of one package
```

Definition of done: `pnpm check` and `pnpm test:affected` both pass.

## Rules

- **No dead or duplicate code.** `pnpm check` runs knip with `includeEntryExports`, so an unused file, export, dependency, or catalog entry fails the build. Delete it instead of keeping it "for later". Export only what another package imports. Required entry exports (the Lambda handler and the Alchemy stack) carry `/** @public */`.
- **Toolchain comes from `mise.toml`**, locked with checksums in `mise.lock`. It pins Node 24 (the Lambda runtime), pnpm, Java 17, and fakecloud. mise is required, and root scripts run under `mise exec`. Don't install these tools another way, and don't add `.node-version` or `.nvmrc`. Bump versions with `mise up --bump && mise lock`.
- **Emulators only, and every emulator is verified.** Code talks to AWS through `@distilled.cloud/aws` via `AwsClient`, the one place that picks real AWS or an emulator URL. Never mock an AWS client. Each emulator must match AWS's documented behaviour. The payloads in `packages/aws/fixtures` (from AWS docs now, recorded ones later) must decode with the schemas production uses. Emulator output must decode with the same schemas. DynamoDB behaviour must agree with AWS's own DynamoDB Local. A new AWS dependency needs an emulator and a contract test before features use it. fakecloud's SES receiving is too shallow (it has no subdomain rules, verdicts, or raw MIME), so `tools/ses-emulator` owns SES receiving. SES sending runs on fakecloud (PLAN.md §20.5).
- **Two DynamoDB engines, never skipped.** Repository suites live in `packages/db/test/support` and run on fakecloud **and** DynamoDB Local (AWS's own reference). Both always run, locally and in CI.
- **One table spec.** `packages/db/src/Table.ts` is the only definition of keys and indexes. Infra deploys it, and the emulators create it. Don't create tables any other way.
- **Tests are hermetic.** Bind only port `0`, create a fresh table per test with `freshTable()`, and share no state between files. Tests need no Docker and no cloud account. These rules let many agents run every suite at once.
- **Emulators run in real time.** `@effect/vitest` uses a `TestClock`, so code that waits on a real process must provide the live clock (see `DynamoDbLocal.ts`).
- **Effect at the edges only.** `Effect.runPromise` and `runSync` belong in entrypoints (`apps/api/src/handler.ts`, `bin/`, React query functions) and tests. Everything else returns Effects and declares its services.
- **Parse at the boundary.** Lambda events go through `FunctionUrl.decode` or the `SesEvent` schemas. DynamoDB items go through the `Attribute` schemas. Inner code takes parsed types, never `unknown`.
- **No `console.*` in app code** (lint-enforced). Scripts and `bin/` are exempt.
- **Effect lint (`@mpsuesser/oxlint-plugin-effect`, all 73 rules as errors).** Key conventions:
  - Namespace imports from submodules: `import * as Effect from "effect/Effect"` (`R` for `effect/Record`, `P` for `effect/Predicate`).
  - Errors are `Schema.TaggedError`, never `new Error` or `Data.TaggedError`.
  - Use `Effect.fn("Name")` instead of assigning `Effect.gen` to a variable.
  - No loops. Use `Arr.*` or `Effect.forEach` with an explicit `concurrency`.
  - Use `DateTime`/`Clock` and the `Crypto` service instead of `Date`/`randomUUID`.
  - Use `Option` instead of null checks, and boolean schema fields start with `is`/`has`/`can`.
  - `vite.config.ts` scopes some exemptions. Composition roots may run Effects and read `process.env`. Emulators (`tools/*/src`) may use Node servers, processes, and files. Tests may use `fetch` and JSON. Tooling (`scripts/`, configs, `infra/`) is exempt.
- **Import test APIs from `vite-plus/test` or `@effect/vitest`**, never from `vitest` directly.
- **Vendored skills** in `.agents/skills` come from pstack (see `skills-lock.json`). Don't edit them. Add project skills with an `alias-` prefix.
- Scripts are `.ts` run by Node's type stripping: erasable syntax only (no enums or namespaces), relative imports with `.ts` extensions.

## Skills

- `alias-testing`: which tier a test belongs in and how to write it.
- `alias-dev-stack`: running and debugging the local stack and ports.
- pstack: start larger tasks with `/poteto-mode`. `/how`, `/why`, `/interrogate`, `/blast-radius` and `/tdd` also work on their own.
