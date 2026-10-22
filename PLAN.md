# Alias: open-source, serverless, privacy-first email alias service

> Status: planning (rev 2) · Last researched: 2026-10-21
>
> **The current target architecture (decided 2026-10-21) is all AWS in eu-west-1, except DNS.** Mail flows from SES (all mail, in and out) through an S3 spool to Lambda (arm64, Node 24) and DynamoDB. CloudFront + S3 serve the web app, and Cloudflare handles DNS only. §15 covers the stack, §19 covers SES for all mail, and §20 covers the port to AWS (done 2026-10-22). §3, §7 and §11 to §14 describe the earlier Cloudflare/D1 design and are superseded where they conflict.
> The goal is an addy.io-class **public** alias service, **open source**, that runs on managed cloud primitives,
> stays extremely cheap, and is developed **almost entirely against local emulators**. Contributors need
> no cloud accounts.

## 0. Decisions so far

| #               | Decision                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audience        | Public service eventually, open source from day one. Build against emulators first, with no public launch until late.                                                                                                      |
| Frontend        | React 19 + Vite+ (TanStack Router/Query/Form, shadcn/ui on Base UI) ✅                                                                                                                                                     |
| Language        | TypeScript 7 + Effect v4 everywhere; Vite+ toolchain; Alchemy v2 for infra and local dev ✅ (full stack in §11)                                                                                                            |
| Domains         | **Shared domain with per-user subdomains** (`anything@user1.alias.example`), shared random aliases (`x7k2p9@alias.example`), and **custom domains (recommended)**. Aliases, replies and temp mail work on **all** of them. |
| AI OTP fallback | Yes, opt-in per user (the cost analysis in §6 shows it's cheap)                                                                                                                                                            |
| License         | **AGPL-3.0** ✅                                                                                                                                                                                                            |
| SES region      | **eu-west-1** ✅ (receiving + sending + S3 spool + SNS all in eu-west-1)                                                                                                                                                   |
| Compute         | **AWS Lambda** (arm64, Node 24), Effect HttpApi behind CloudFront ✅ (§15, decided 2026-10-21)                                                                                                                             |
| Database        | **DynamoDB** on-demand, single table ✅ (§15, replaces D1/DSQL)                                                                                                                                                            |
| Mail            | **SES for all mail**, shared and custom domains, in and out ✅ (§19)                                                                                                                                                       |
| DNS             | Cloudflare (free), DNS only ✅                                                                                                                                                                                             |
| Domain names    | Deferred. Dev uses `.test` domains until then.                                                                                                                                                                             |

---

## 1. What changed since rev 1, and why

Rev 1 recommended Cloudflare Email Routing for inbound. **The new requirements rule it out for the public service:**

1. **No wildcard subdomains.** Email Routing catch-all is **apex-only**. Subdomains must be added **one at a time**, capped at **30 per zone**. That means `*@user1.alias.example` can't work for more than ~29 users.
2. **No third-party custom domains.** The zone must live in _our_ Cloudflare account. Email Sending has the same restriction, so we can't send _as_ `alias@usersdomain.com` either.

**AWS SES (classic receipt rules) handles both natively** (verified in current docs):

- A recipient condition `.alias.example` matches **all subdomains**, and `alias.example` matches the apex.
- A rule with **no recipient condition matches every verified domain**. New custom domains need _no_ rule changes, only a verified SES identity.
- Verifying `alias.example` also covers sending from `a.alias.example` and `a.b.alias.example`.
- For custom domains, the user adds MX + 3 DKIM CNAMEs, and we can then receive _and_ send DKIM-aligned mail for them.

**The new split.** **AWS SES is the mail edge** (in and out). **Cloudflare runs everything else** (compute, DB, storage, realtime, UI, MCP). Cloudflare Email Routing stays as an optional inbound adapter for self-hosters who only need their own apex domains.

---

## 2. Emulation research into building 100% locally

**Short answer.** Cloudflare's compute/storage platform can be emulated at near-100% fidelity, because the local runtime _is_ the production runtime (`workerd`). No email provider ships a working inbound emulator. SES's integration contract is small and documented, though: an S3 object, an SNS JSON notification, and a handful of SESv2 HTTP calls. **We build our own SES emulator** and keep it honest with contract tests recorded from real AWS. The parts nobody can emulate (real-world deliverability, spam foldering, other MTAs' DMARC behavior) get a short staging smoke test before launch.

### 2.1 Emulation matrix

| Component                                 | Production                                                                                              | Local emulator                                                                                                                                                                                                   | Fidelity                                                                                                 | Gap and mitigation                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workers runtime, HTTP, Cron, Queues       | Cloudflare Workers                                                                                      | `wrangler dev` / Miniflare (`workerd`) + `@cloudflare/vitest-pool-workers`                                                                                                                                       | **~100%**                                                                                                | CPU/memory limits and geo placement aren't enforced. Load-test in staging.                                                                                                                                                                                                                                                                                   |
| D1 (SQLite)                               | D1                                                                                                      | Miniflare (local SQLite)                                                                                                                                                                                         | **~100%**                                                                                                | Read replication and size limits aren't enforced                                                                                                                                                                                                                                                                                                             |
| R2, KV                                    | R2, KV                                                                                                  | Miniflare                                                                                                                                                                                                        | **~100%**                                                                                                | Miniflare doesn't simulate KV eventual consistency, so never rely on read-after-write.                                                                                                                                                                                                                                                                       |
| Durable Objects + WebSockets              | DO                                                                                                      | Miniflare                                                                                                                                                                                                        | **~100%**                                                                                                | Single location locally                                                                                                                                                                                                                                                                                                                                      |
| Static assets (React app)                 | Workers Static Assets                                                                                   | `wrangler dev` + Vite                                                                                                                                                                                            | **100%**                                                                                                 | none                                                                                                                                                                                                                                                                                                                                                         |
| Turnstile (anti-abuse)                    | Turnstile                                                                                               | Official **test sitekeys/secrets** (always-pass/always-fail)                                                                                                                                                     | **100%**                                                                                                 | none                                                                                                                                                                                                                                                                                                                                                         |
| Rate limiting                             | DO-based (our code)                                                                                     | Miniflare                                                                                                                                                                                                        | **100%**                                                                                                 | none                                                                                                                                                                                                                                                                                                                                                         |
| **Workers AI**                            | Workers AI                                                                                              | **None.** The binding always calls the real API and bills real usage.                                                                                                                                            | 0%                                                                                                       | `Classifier` interface. Local = **Ollama** with `llama3.2:1b` (the same model family), or a deterministic stub in tests.                                                                                                                                                                                                                                     |
| CF Email Routing (self-host adapter)      | Email Routing → `email()`                                                                               | `POST /cdn-cgi/local/email?from=&to=` with raw RFC 5322                                                                                                                                                          | High for the handler and `forward()`. The local behavior of `reply()` and `setReject()` is undocumented. | Only used in self-host mode, and adapter tests cover it                                                                                                                                                                                                                                                                                                      |
| CF Email Sending                          | Email Sending                                                                                           | Local simulation logs and writes `.eml` files (or a `remote: true` binding)                                                                                                                                      | Medium                                                                                                   | Not on the SaaS path                                                                                                                                                                                                                                                                                                                                         |
| **SES inbound** (receipt rule → S3 → SNS) | SES classic, configured once via the **v1 API**                                                         | **LocalStack only mocks receipt rules and never receives mail.** LocalStack has also required an auth token since 2026.03, which is bad for OSS contributors. **moto only does rule CRUD and receives nothing.** | 0% off-the-shelf                                                                                         | **Our `ses-emulator`.** A local SMTP server applies the same recipient-matching semantics (`domain`, `.domain`, _no recipient = all verified_), writes raw MIME to its built-in S3 subset, and POSTs a **signed SNS notification** to the worker. The notification carries the documented SES `Received` JSON, including spf/dkim/dmarc/spam/virus verdicts. |
| **SES outbound + identities**             | **SESv2 API** (`SendEmail` raw, `CreateEmailIdentity`, `GetEmailIdentity`, suppression list, MAIL FROM) | moto implements SESv2 `send_email` + identity CRUD, but the **suppression list isn't implemented** and sent mail is only inspectable through an internal Python API                                              | Partial                                                                                                  | **Our `ses-emulator`** implements the SESv2 subset we call and **relays sent mail to Mailpit** so you can see the result in a browser. It also simulates DKIM verification and injects Bounce/Complaint SNS events.                                                                                                                                          |
| S3 (raw mail spool)                       | S3                                                                                                      | Built-in S3 subset in `ses-emulator` (tests). moto server (Apache-2.0, no auth token) is optional for the interactive stack.                                                                                     | High                                                                                                     | Contract tests cover the S3 calls we make (Put/Get/Delete + lifecycle)                                                                                                                                                                                                                                                                                       |
| SNS signature verification                | SNS → HTTPS                                                                                             | `ses-emulator` signs with a local cert; the worker's cert-host allowlist is configurable in dev                                                                                                                  | High                                                                                                     | Contract test with real recorded SNS messages                                                                                                                                                                                                                                                                                                                |
| DNS checks (custom-domain setup UX)       | DoH (1.1.1.1)                                                                                           | DoH stub inside `ses-emulator` with editable records                                                                                                                                                             | 100%                                                                                                     | none                                                                                                                                                                                                                                                                                                                                                         |
| Viewing delivered mail                    | Users' real inboxes                                                                                     | **Mailpit** (MIT): web UI + API                                                                                                                                                                                  | n/a                                                                                                      | Mailpit's API is also used for e2e assertions                                                                                                                                                                                                                                                                                                                |
| Real-world deliverability                 | Gmail / Outlook / Proton / iCloud                                                                       | **Not emulatable**                                                                                                                                                                                               | n/a                                                                                                      | A pre-launch staging smoke test with seed inboxes, mail-tester, and DMARC reports                                                                                                                                                                                                                                                                            |

### 2.2 Alternatives evaluated for the mail edge (none beat SES)

| Option                                         | Wildcard subdomains                        | Third-party custom domains | Emulator                                                | Cost                                                           | Verdict                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------ | -------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS SES (receipt rules + SESv2)**            | ✅ `.domain`                               | ✅ via identity + MX       | Build our own (small, documented contract)              | ~$0.30 / 1k forwarded                                          | **Chosen**                                                                                                                                                |
| Cloudflare Email Routing/Sending               | ❌ apex-only catch-all, 30 subdomains/zone | ❌ zone must be ours       | ✅ official                                             | $0 in / $0.35 per 1k out                                       | Self-host adapter only                                                                                                                                    |
| Mailgun / Postmark / SendGrid / Resend inbound | per-domain setup                           | ✅                         | ❌ none                                                 | 3 to 10× SES                                                   | Pricier. Transactional ESPs dislike forwarding third-party mail.                                                                                          |
| SES Mail Manager                               | ✅                                         | ✅                         | ❌                                                      | $50/mo per open ingress endpoint                               | Overkill for us                                                                                                                                           |
| **Own MX (Haraka / `smtp-server`) on Fly.io**  | ✅                                         | ✅                         | **100%** (it's our code)                                | ~$2 IPv4 + ~$2 to $4 machine per region, with 2 regions for HA | **Plan B inbound adapter.** We'd operate TLS, spam filtering, HA and IP reputation. Fly also discourages outbound SMTP (no PTR), so SES would still send. |
| LocalStack as the dev emulator                 | n/a                                        | n/a                        | Receipt rules mocked, auth token required since 2026.03 | Free Hobby plan for non-commercial use only                    | Rejected for OSS contributor friction                                                                                                                     |
| Floci (MIT LocalStack alternative)             | n/a                                        | n/a                        | Young project, SES coverage unconfirmed                 | Free                                                           | Watchlist. It could replace moto later.                                                                                                                   |

Because the pipeline is adapter-based (§3.2), switching to Plan B later only means adding an inbound adapter. The core is untouched.

---

## 3. Architecture

```
               ┌──────────────────────── AWS (mail edge) ────────────────────────┐
 Internet ───▶ │ SES inbound (MX: alias.example, *.alias.example, custom domains) │
   MX          │   receipt rule set (v1 API):                                    │
               │     rule "all": no recipient → all verified domains             │
               │       action 1: S3 PutObject (spool, 1-day lifecycle, SSE)      │
               │       action 2: (on S3 action) SNS notify ──────────┐           │
               │ SESv2: identities, SendEmail(raw), suppression ◀──┐ │           │
               └───────────────────────────────────────────────────┼─┼───────────┘
                                                                   │ │ HTTPS (SNS-signed)
               ┌──────────────────── Cloudflare (everything else) ─┼─┼───────────┐
               │  worker-api  /hooks/ses ◀─────────────────────────┼─┘           │
               │    verify SNS sig → enqueue {s3Key, receipt verdicts}           │
               │  Queue consumer (inbound pipeline, retries, DLQ)                │
               │    GET raw from S3 (aws4fetch) → resolve alias → policy →       │
               │    rewrite/sanitize/PGP → Transport.send ──────────┘            │
               │    → inbox mode: encrypt → R2 · metadata → D1 · push → DO       │
               │    → DELETE S3 object                                           │
               │  worker-api (Effect HttpApi, OpenAPI) + static React app        │
               │  worker-mcp (remote MCP, OAuth)                                 │
               │  Cron: TTL purge, identity verification polling, digests        │
               │  D1 · R2 · KV · Durable Objects · Queues · Workers AI           │
               └─────────────────────────────────────────────────────────────────┘
```

### 3.1 Domains & addressing

| Domain type                     | Example                                                                               | DNS                                                                                        | Who                               |
| ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------- |
| Shared random                   | `k7m2qx9p@alias.example`                                                              | apex MX → SES                                                                              | everyone                          |
| Shared per-user subdomain       | `<anything>@<username>.alias.example` (created on the fly)                            | **wildcard** `*.alias.example MX → inbound-smtp.eu-west-1.amazonaws.com`                   | every registered user             |
| Custom domain (**recommended**) | `<anything>@mydomain.com`                                                             | user adds MX, 3 DKIM CNAMEs, SPF `include:amazonses.com`, DMARC; optional custom MAIL FROM | registered users                  |
| Temp-mail public domain         | `x9q2@tmp.example` (a separate registrable domain so blocklisting can't hurt aliases) | MX → SES                                                                                   | anyone, including anonymous users |
| Reverse alias (for replies)     | `<alias-local>+r.<token>@<same alias domain>`                                         | (same as alias)                                                                            | system                            |

- Reverse aliases live **on the alias's own domain**, so replies are DKIM-aligned with that domain (including custom domains) and nothing reveals the service's main domain.
- `token` is a base32 HMAC over `{aliasId, contactId, keyVersion}`. It's stateless to verify, revocable via the contact row, and rotatable.
- Usernames must be DNS-label-safe, with a reserved list (`www`, `mail`, `admin`, `api`, brand names…) and confusable-character checks.
- **Temp mail on any domain.** A temp inbox is just an alias with `mode=inbox` and an `expires_at`. Users can create them on their subdomain or custom domain too.

### 3.2 Inbound pipeline (adapter-based)

```
InboundAdapter  ──normalize──▶  InboundEnvelope { rcpt[], mailFrom, rawRef, verdicts{spf,dkim,dmarc,spam,virus} }
  • ses-sns         (production SaaS)
  • cf-email-routing (self-host on own CF zones, $0 inbound)
  • smtp            (Plan B own MX; also what the dev emulator speaks)
```

The steps after normalization are shared by every adapter:

1. **Resolve** the recipient to a domain and then to an alias, checking the KV cache before D1. Drop mail to an unknown recipient silently (no backscatter). If enabled, create aliases on the fly for user subdomains and custom domains.
2. **Policy.** Drop when `virus=FAIL`. On `spam=FAIL`, quarantine or drop according to the user's setting. Also handle disabled aliases, blocked contacts, per-alias/per-user rate limits (DO), and max size.
3. **Reverse-alias path** (the address carries `+r.<token>`). Verify the token. **Require the sender to be the alias owner's verified recipient, with DKIM/DMARC passing**, and reject otherwise. This prevents spoofed sends. Strip identifying headers and the quoted real address, set `From: alias`, and send to the contact.
4. **Forward path.** For each recipient of the alias, rewrite `From: "Sender Name (sender@x.com)" <alias+r.<token>@domain>` and set `Reply-To` to the same address. Keep the `Subject` and body, then apply the optional banner, tracker stripping and optional PGP. Then call `Transport.send`.
5. **Inbox path (temp or inbox mode).** Encrypt the message (per-user DEK, AES-GCM) and store it in R2. Write the metadata, OTP and magic link to D1. Push to the inbox DO, which serves WebSocket subscribers.
6. **Cleanup.** Delete the spool object from S3 right away. Forward-only aliases **never persist content**.

### 3.3 Transport (outbound)

`Transport.send(rawMime, {from, to[]})` implementations:

- `ses` (default) calls SESv2 `SendEmail` with `Content.Raw`. It takes up to 40 MB, works for custom domains, and costs $0.10/1k + $0.12/GB. Built as `Transport.ses` in `packages/aws` and verified on fakecloud (§20.5).
- `cf-email-sending` is for self-hosters on CF-owned domains (5 MiB limit, $0.35/1k).
- `smtp` is generic: Mailpit in dev, or any SMTP relay.

Bounces and complaints flow from SES (configuration-set event destination) through SNS to the feedback Lambda, which updates the suppression list and flags recipients (built, §20.11). Keep the **bounce rate below 5% and the complaint rate below 0.1%** (the SES enforcement thresholds).

### 3.4 Privacy features

- **Data minimization.** Forward-only aliases store only counters. Inbox/temp content is encrypted at rest with envelope encryption and a configurable TTL. The pipeline deletes the S3 spool object after processing, with a 1-day lifecycle as a backstop.
- **PGP/MIME** encryption to recipients with a public key (OpenPGP.js; built, §20.21). Inbox storage can optionally be "zero-access", encrypted to the user's key, in which case OTP extraction happens in flight only.
- **Tracker defense.** Strip pixels and known tracker hosts, clean `utm_*`/`fbclid`/`gclid`/`mc_eid`… (built, §20.19), and optionally proxy images through our own Lambda behind CloudFront (built, §20.19).
- **Header hygiene on replies.** Remove `Received`, `X-Originating-IP`, `User-Agent`, `X-Mailer`, and the real address from quoted text and signatures (built, §20.6 and §20.10).
- **Account security.** Passkeys (WebAuthn) come first, with TOTP, a magic-link fallback, scoped hashed API tokens, and an audit log.
- **No content in logs.** Addresses are hashed in analytics. A threat-model doc and a published data-flow diagram ship with the repo.

### 3.5 Temp mail

- `POST /inboxes {domain?, ttl?}` returns `{address, expiresAt, token}`. Anonymous use of the public temp domain requires Turnstile and an IP rate limit. Logged-in users can use any of their domains.
- Live updates arrive over WebSocket (one DO per inbox). A long-poll endpoint, `GET /inboxes/:id/wait?match=&timeout=60`, serves the CLI, MCP and CI.
- Temp inboxes are receive-only (no sending from anonymous temp inboxes). Message count and size are capped, and a Cron job runs the TTL purge.

### 3.6 OTP / 2FA / magic-link extraction

1. **Deterministic extractor** (`packages/core/extract`), which handles most mails:
   - Normalize HTML to text.
   - Score candidates near i18n keywords (_code, verification, OTP, one-time, 2FA, PIN_…), penalizing years, prices, phone numbers, order numbers and zip codes.
   - Use sender-specific patterns for the top senders.
   - Detect magic links (and never visit them).
2. **AI fallback** (opt-in). It runs only when the mail _looks_ auth-related and step 1's confidence is low. It uses a small Workers AI model on truncated text (~1k tokens) and returns strict JSON `{code, link, confidence}`.
3. The outputs are a field on the message, an optional subject prefix (`[493021] Your code…`), and pushes to WS/CLI/MCP/webhooks.
4. A golden corpus of anonymized real OTP mails lets CI check extraction precision and recall.

---

## 4. Local dev environment (zero cloud accounts)

```
pnpm agent:setup →  install + claim this worktree's 20-port block + write .dev/env
pnpm dev         →  alchemy dev (workerd + local D1)  +  vp dev (web)  +  ses-emulator (SMTP)
                    later: SESv2/SNS/DoH on the emulator, optional Mailpit and Ollama
```

| Offset in port block | Service                                                    | Status  |
| -------------------- | ---------------------------------------------------------- | ------- |
| +0                   | web (`vp dev`, proxies `/v1` and `/health` to the api)     | ✅      |
| +1                   | api (`alchemy dev`, state in `infra/.alchemy`)             | ✅      |
| +2                   | ses-emulator SMTP inbound                                  | ✅      |
| +3                   | ses-emulator SESv2 API + SNS delivery to the worker        | phase 2 |
| +4 / +5              | Mailpit UI / SMTP (optional, for viewing "delivered" mail) | phase 3 |

Dev domains use `.test` (`alias.test`, `*.user1.alias.test`, `custom.test`). Docker is never required. Tests are hermetic (§12), and moto is no longer needed because the emulator carries its own S3 subset.

The code reaches AWS with **`aws4fetch`** (a tiny, Workers-native SigV4 client) instead of AWS SDK v3, with an endpoint override that points at the emulator in dev.

**§12** covers testing tiers, results and known issues.

---

## 5. Repo layout (✅ = exists today)

```
apps/
  api/          ✅ API Lambda (function URL): Effect HttpApi handlers, handler.ts entry, bin/dev.ts
  web/          ✅ React 19 + TanStack + shadcn/ui
  inbound/      ✅ inbound Lambda (SES receipt action): resolve → policy → guards → forward/reply → spool delete (§20.6, §20.7)
  mcp/             Remote MCP + OAuth
  cli/          ✅ `alias` CLI: effect/cli, device-code login, Bun-compiled binaries (§20.23)
packages/
  core/         ✅ pure logic: addressing (done), rewrite, sanitize, trackers, PGP, OTP extract, tokens
  contracts/    ✅ Effect HttpApi + Schemas shared by API, web, CLI, MCP; OpenAPI document (§20.23)
  sdk/          ✅ @alias/sdk: publishable typed client (§20.23)
  aws/          ✅ AWS boundary: AwsClient (real/emulated), Lambda + SES event schemas, function URL adapter, Inbound spool (size/read/delete), Transport (SESv2 sending); fixtures/ = AWS payloads
  db/           ✅ DynamoDB single table (Table.spec) + repositories (tested on fakecloud and DynamoDB Local)
tools/
  ses-emulator/      ✅ SMTP inbound + receipt rules + verdicts + S3 action (fakecloud) + SES Lambda events
  aws-emulators/     ✅ fakecloud (S3 + DynamoDB + SESv2 sending, one binary via mise) + Amazon DynamoDB Local (Java)
  lambda-emulator/   ✅ function URL server (HTTP ⇄ payload 2.0)
e2e/            ✅ whole emulated stack in one process (layers shared as @alias/e2e/stack)
browser/        ✅ real-browser tests of apps/web: headless Chromium + virtual passkey (§20.17)
infra/          ✅ alchemy.run.ts: DynamoDB, S3 spool, API + inbound Lambdas, SES rules (not deployed)
scripts/        ✅ agent-setup.ts, dev.ts, affected.ts, cost-model.ts (+ lib/ports, worktree, devEnv)
.agents/skills/ ✅ pstack + alias-* skills (symlinked into .claude/skills)
```

---

## 6. Costs

### 6.1 Mail pipeline (public SaaS, à la carte SES, avg mail < 256 KB)

| Item                                  | per 1,000 forwarded mails |
| ------------------------------------- | ------------------------- |
| SES inbound ($0.10 + one $0.09 chunk) | $0.19                     |
| S3 put/get/delete (spool)             | ~$0.006                   |
| SNS → HTTPS (first 100k/mo free)      | $0 to $0.0006             |
| SES outbound ($0.10 + $0.12/GB)       | ~$0.106                   |
| **Total**                             | **≈ $0.30**               |

| Volume / month            | AWS   | Cloudflare (Workers Paid) | **Total** |
| ------------------------- | ----- | ------------------------- | --------- |
| Dev (emulators)           | $0    | $0                        | **$0**    |
| 10k forwards (early beta) | ~$3   | $5                        | **~$8**   |
| 100k                      | ~$30  | $5                        | **~$35**  |
| 1M                        | ~$300 | $5 + overages             | **~$310** |

Spam to non-existent addresses still costs the inbound $0.19/1k. That's the price of catch-all. The pipeline limits it by dropping mail with spam/virus verdicts before any further work.

**Gotchas:**

- Switch the SES account to **à la carte**. Accounts with no SES activity since 2025-06-01 default to _Essentials_ ($0.16/1k) as of 2026-07-21.
- New SES accounts start in the **sandbox (200 mails/24h, 1/s)**, so request production access with a clear forwarding and abuse-handling description.

### 6.2 The AI OTP fallback is cheap

Workers AI gives **10,000 neurons/day free**, then charges **$0.011 per 1k neurons**. `llama-3.2-1b-instruct` costs $0.027/M input and $0.201/M output tokens. `granite-4.0-h-micro` is cheaper still, at $0.017/$0.112.

A fallback call (~1,000 input + ~30 output tokens) uses about **2.5 neurons, or about $0.00003**.

| Fallback calls          | Cost                     |
| ----------------------- | ------------------------ |
| ≤ ~4,000/day (~120k/mo) | **$0** (free allocation) |
| 1M/mo                   | **~$30**                 |

The fallback only runs on auth-looking mails where the regex extractor is unsure (expected to be a small fraction), so the realistic cost is ~$0. For privacy, the fallback is opt-in, runs inside Cloudflare (no third-party LLM), and only sees truncated text.

---

## 7. Data model (D1 / @effect/sql-d1)

```
users(id, username UNIQUE, plan, settings_json, created_at)
credentials(id, user_id, kind[passkey|totp], data, created_at)
api_tokens(id, user_id, name, hash, scopes, expires_at, last_used_at)
domains(id, owner_user_id NULL=shared, name UNIQUE, kind[shared|user_sub|custom|temp_public],
        ses_identity_status, dkim_tokens_json, mx_ok, catch_all, created_at)
recipients(id, user_id, email, verified_at, pgp_public_key, can_reply_from)
aliases(id, user_id NULL=anon-temp, domain_id, local_part, mode[forward|inbox|both],
        active, description, created_via[web|api|cli|mcp|on_the_fly], expires_at,
        options_json(pgp, banner, strip_trackers, otp_prefix, ai_otp), counters…)
alias_recipients(alias_id, recipient_id)
contacts(id, alias_id, address, display_name, blocked, token_key_version, last_seen_at)
messages(id, alias_id, contact_id, received_at, from, subject, size, r2_key, dek_id,
         otp, magic_link, verdicts_json, expires_at)          -- inbox/temp only
suppressions(address_hash, reason, source, created_at)
events(id, user_id, alias_id, type, at)                       -- counters/audit, no content
webhooks(id, user_id, url, secret, events)
```

---

## 8. Roadmap (emulator-first)

| Phase                                     | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Exit criteria                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **1. Foundations** ✅ (2026-10-21)        | Vite+ monorepo (pnpm 12), TS7, Effect v4, React 19 web, Effect HttpApi (now a Lambda on DynamoDB, §20), local dev, SES emulator (SMTP + rules + spool), port blocks, AGENTS.md + skills, AGPL, CI, browser tests (§20.17)                                                                                                                                                                                                                                                            | Done. `pnpm dev` boots with no cloud account, and three checkouts ran all suites and dev stacks at once      |
| **2. `ses-emulator` + contract fixtures** | SMTP in → receipt matching → S3 → signed SNS. SESv2 subset → Mailpit. DoH stub. Record real AWS fixtures once (sandbox account, ~$0).                                                                                                                                                                                                                                                                                                                                                | Emulator passes the contract tests                                                                           |
| **3. Forwarding core** ✅ (2026-10-22)    | ✅ SES → Lambda pipeline (§20.6): alias resolution on shared + user-subdomain domains, verdict policy, `ses` transport, counters, idempotency, passkey auth, minimal React UI (rebuilt on the design system, §20.16). ✅ Forwarding safety (§20.7): loops, auto-replies, bounces, hourly cap, size. ✅ Opt-in on-the-fly aliases on the user's subdomain (§20.8)                                                                                                                     | `swaks` → fakecloud sent mail works for all address types                                                    |
| **4. Replies & send-as** ✅ (2026-10-22)  | ✅ Reverse aliases, sender verification (verified recipient + DKIM/DMARC), header hygiene incl. `Message-ID` (§20.6). ✅ Contacts with block/unblock, contact-id tokens (§20.9). ✅ Quoted-text scrubbing (§20.10). ✅ Bounces/complaints, suppression list (§20.11). ✅ Reputation alarms (§20.13). ✅ Reverse-token keys from SSM Parameter Store (§20.14)                                                                                                                         | ✅ Two-way thread in the stack test with no real-address leak (header-diff test)                             |
| **5. Custom domains** ✅ (2026-10-22)     | ✅ Domain model, SESv2 identity + Easy DKIM, custom MAIL FROM, ownership token, DoH checks against a verified DoH emulator, verification Cron (§20.18.1). ✅ Receiving and sending on verified custom domains, per-domain catch-all, aliases on them via the API (§20.18.2). ✅ Domain wizard in the web app (§20.18.3). Later: Domain Connect one-click setup (§18)                                                                                                                 | ✅ Custom domain verified end-to-end in the emulators (stack test: add → publish → verify → forward → reply) |
| **6. Privacy hardening** (in progress)    | ✅ Data lifecycle (§20.15): deactivate vs. delete (tombstone, contacts purged) vs. account erasure (GDPR Art. 17), 14-day log retention. ✅ Tracker pixels and link tracking removed from forwarded mail, ✅ image proxy (§20.19). ✅ PGP/MIME encryption to a destination's OpenPGP key, optional hidden subject (§20.21). Open: encryption at rest, threat model, security review                                                                                                  | No plaintext content at rest for forward aliases                                                             |
| **7. Temp mail + OTP** (in progress)      | ✅ Verification-code and magic-link extractor with a 69-mail corpus (§20.22.1). ✅ Inbox mode with envelope-encrypted storage, temporary inboxes on a temp-mail domain, long-poll API, `inboxes:*` token scopes, erasure (§20.22.2). Open: web Inbox screen (§20.22.3), anonymous temp inboxes (Turnstile), AI fallback (Ollama locally)                                                                                                                                             | ✅ `alias temp --wait --otp` path < 5 s locally: stack test, SMTP → stored → long poll → code                |
| **8. API tokens, SDK, CLI, webhooks**     | ✅ Scoped personal API tokens, ✅ signed webhooks over SQS (§20.20). ✅ OpenAPI document + typed SDK, ✅ device-code login (RFC 8628), ✅ Bun-compiled `alias` CLI, binaries as CI artifacts (§20.23). Open: `alias temp` (with phase 7), publishing (npm, Homebrew tap)                                                                                                                                                                                                             | CLI release (npm + Homebrew tap)                                                                             |
| **9. MCP** (in progress)                  | ✅ OAuth 2.1 authorization server for MCP clients: PKCE, metadata documents and dynamic registration, consent behind a passkey session, rotating refresh tokens. ✅ Stateless MCP endpoint on the API Lambda (2026-07-28 and the 2025 revisions), alias and contact tools. ✅ Confirm-gated send: drafts that only the signed-in user sends, MRTR URL elicitation (all §20.24). Works with the official TypeScript SDK client in the stack test. Open: temp-mail tools (with §20.22) | Works from MCP clients against local stack                                                                   |
| **10. Staging**                           | Real CF + AWS, IaC (Alchemy v2, OpenTofu fallback), SES production access, deliverability smoke tests, abuse runbook                                                                                                                                                                                                                                                                                                                                                                 | Private beta                                                                                                 |
| **11. Public launch**                     | Billing (Stripe), plans/quotas, status page, ToS/privacy policy, abuse@ handling                                                                                                                                                                                                                                                                                                                                                                                                     | Public                                                                                                       |

---

## 9. Risks

| Risk                                                         | Mitigation                                                                                                                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SES denies production access, or suspends for forwarded spam | Strong abuse controls before applying (drop spam/virus, rate limits, suppression, user blocking). Keep the `cf-email-sending` transport for shared domains as a fallback and Plan B MX for inbound. |
| Emulator drift from real AWS                                 | Contract fixtures from real AWS plus an optional nightly re-record job. The emulator covers only the calls we make.                                                                                 |
| Workers AI not emulatable                                    | `Classifier` interface + Ollama locally. AI is never required for correctness.                                                                                                                      |
| Public temp domain gets blocklisted                          | Separate registrable domains, rotation, encourage custom domains                                                                                                                                    |
| D1 limits (10 GB/db, single writer)                          | Content lives in R2. Only metadata in D1. Shard by user later if needed.                                                                                                                            |
| Reply spoofing                                               | HMAC tokens + DKIM/DMARC-pass + sender must be the owner's verified recipient                                                                                                                       |
| Catch-all spam cost                                          | Early drop on verdicts. Per-domain stats. Users can disable catch-all.                                                                                                                              |
| Legal for a public service                                   | Privacy policy, DPA, abuse process, and a GDPR-friendly region choice (e.g. `eu-west-1` receiving) before launch                                                                                    |

## 10. Still open

1. **Domain names** for the shared, temp and app domains are deferred. Temp mail and aliases must use different registrable domains.

---

## 11. Tech stack (locked, verified 2026-10-21)

> **Partly superseded by §14.** Compute moves to Lambda and the database moves to DSQL. Toolchain, Effect, React, Alchemy and the testing approach stay.

Every row below is installed in the repo and exercised by a passing check or test.

| Layer             | Choice                                                             | Version                      | Notes                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain         | **Vite+** (`vp`)                                                   | 1.3.0                        | One CLI: `vp dev/build/test/check/run`. Bundles Vite 8, Vitest 5.0.5, Oxlint 1.88 + tsgolint 7.0.2004 (type-aware lint **and** typecheck), oxfmt, tsdown. Replaces Turborepo (`vp run` caches tasks and tracks inputs automatically), lefthook (`vp staged` via `.vite-hooks/`) and Prettier/ESLint.                                                 |
| Language          | **TypeScript 7**                                                   | 7.0.2                        | `vp check` typechecks the whole monorepo in ~0.5 s.                                                                                                                                                                                                                                                                                                  |
| Effect            | **Effect v4**                                                      | 4.0.5                        | HTTP, HttpApi, SQL and CLI are now inside `effect` (`effect/http`, `effect/http-api`, `effect/sql`, `effect/cli`). The v3-era `@effect/platform` and `@effect/cli` packages are not used.                                                                                                                                                            |
| DB                | **D1** via `@effect/sql-d1`                                        | 4.0.5                        | See §13 for why not DSQL. Repositories depend on the generic `SqlClient`, so the same code also runs on `@effect/sql-sqlite-node` in fast unit tests.                                                                                                                                                                                                |
| API               | Effect `HttpApi` on Workers                                        | n/a                          | `HttpRouter.toWebHandler(ApiLive)` in `apps/api/src/worker.ts`. Typed errors map to HTTP status (`AliasNotFound` maps to 404).                                                                                                                                                                                                                       |
| Frontend          | **React 19** + Vite (through Vite+)                                | 19.3.1                       | TanStack Router 1.170 (file routes), Query 5.104, Form 1.33. shadcn/ui (base-nova style on Base UI, Tailwind 4.3), lucide icons, Geist fonts self-hosted (§20.16). The API client is `HttpApiClient` from `@alias/contracts`.                                                                                                                        |
| IaC + local dev   | **Alchemy v2**                                                     | 2.0.0-beta.83                | `infra/alchemy.run.ts` declares D1 + the Worker as an _async worker_ (`main:` points at our plain entry, so runtime code doesn't import Alchemy). `alchemy dev` runs workerd + local D1 **without a Cloudflare account**, using file state in `infra/.alchemy`. Covers SES receipt rules, S3 and SNS for later phases. Apache-2.0 (AGPL-compatible). |
| Worker tests      | `@cloudflare/vitest-plugin`                                        | 1.4.6                        | Renamed from `vitest-pool-workers`, and the first version that accepts Vitest 5. It's configured inline (`miniflare: { d1Databases }`), so it needs no wrangler config.                                                                                                                                                                              |
| Effect tests      | `@effect/vitest`                                                   | 4.0.5                        | `it.effect`, `it.layer`.                                                                                                                                                                                                                                                                                                                             |
| Scripts           | `.ts` run directly by Node 24 (type stripping)                     | Node ≥ 24.11                 | `scripts/agent-setup.ts`, `dev.ts`, `affected.ts`.                                                                                                                                                                                                                                                                                                   |
| Package manager   | pnpm via `devEngines`                                              | 12.14.0                      | Auto-downloaded. Build scripts are gated (`allowBuilds: esbuild, workerd`).                                                                                                                                                                                                                                                                          |
| Agent skills      | pstack (project-level) + `alias-*` skills                          | pinned in `skills-lock.json` | §12.5                                                                                                                                                                                                                                                                                                                                                |
| CLI / MCP (later) | `effect/cli` → `bun build --compile`; Cloudflare `agents` McpAgent | n/a                          | Phases 8 and 9.                                                                                                                                                                                                                                                                                                                                      |

### 11.1 "One capability, many surfaces" (borrowed from Rat Stack)

We define each feature **once**: an Effect Schema input/output, required services, a policy and a handler. Thin projectors expose it as an **HTTP** endpoint (plus OpenAPI), a **CLI** command, an **MCP** tool, and the **web** typed client. Today `packages/contracts` holds the HttpApi definition. A `packages/capabilities` layer arrives once there are enough features to project.

### 11.2 Borrow ideas from Rat Stack, don't adopt it

[Rat Stack](https://ratstack.sh/) (MIT, single maintainer) uses **Foldkit instead of React**, XState 6 alpha and strict house rules such as no comments. We borrow capability projection, hexagonal adapters, the "fence" (lint-enforced rules plus a debt ledger) and its version pins as a sanity reference.

---

## 12. Parallel development & test architecture (built and verified)

### 12.1 Principle

Isolating _runtimes_ per agent (containers/VMs) is the expensive fix. The repo instead makes isolation unnecessary:

- **Hermetic tests.** They use no fixed ports, no shared state, no Docker, and no cloud accounts.
- **Per-worktree state and ports.** The interactive stack gets its own state and port block in each worktree.

Containers and microVMs remain optional wrappers: the devcontainer as a spec for cloud agents and CI, and Docker Sandboxes for unattended agents.

### 12.2 Test tiers

| Tier         | Runner                                                       | Isolation                               | What it covers                                                                                          | Status    |
| ------------ | ------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------- |
| **unit**     | Vitest 5 in Node                                             | in-process; emulators on port 0         | `core` logic, `ses-emulator` (SMTP → rule matching → spool → notification), repositories on node:sqlite | ✅        |
| **worker**   | `@cloudflare/vitest-plugin` (workerd)                        | per-file storage; tables reset per test | Repositories on real D1, API handlers via `SELF.fetch`                                                  | ✅        |
| **stack**    | Alchemy `Test.make({ dev: true })` + in-process ses-emulator | per-file Alchemy stage + random ports   | SMTP in → worker pipeline → transport out                                                               | phase 3   |
| **contract** | Node                                                         | offline fixtures                        | Recorded real SES/SNS payloads vs emulator + worker parsers                                             | phase 2   |
| **e2e**      | Playwright vs `pnpm dev` stack                               | per-worktree port block                 | Web flows                                                                                               | ✅ §20.17 |
| **live**     | real CF + AWS staging                                        | per-PR Alchemy stage                    | Deliverability smoke tests                                                                              | phase 10  |

**Layer-matrix pattern.** We write each behaviour once, as a suite that takes a `makeLayer` factory (`packages/db/test/support/aliasRepoSuite.ts`), and each backend gets a tiny runner file. The same 3 tests pass on node:sqlite (ms) and on D1 in workerd. Future adapters reuse the pattern, both the SES, CF and SMTP transports and the SES-SNS, CF Email Routing and SMTP inbound adapters.

### 12.3 Verified results (2026-10-21)

- **Concurrency.** A copy of the repo with **two extra git worktrees** ran the full suite in all three checkouts **at the same time**, while one dev stack was running. Each checkout ran 22 tests, all green, and the whole run took **8 s wall** time.
- **Parallel dev stacks.** **Three `pnpm dev` stacks** ran side by side (port blocks 41000/41020/41040). Each served the web proxy to the API, API health, and SMTP, with separate `infra/.alchemy` state.
- **Affected runs.** `pnpm test:affected` runs only the changed packages and their dependents.
- **Cache invalidation.** `vp run`'s input tracking re-ran `apps/api` when `packages/db/src` changed, even though the tests execute inside workerd. It replayed suites whose inputs didn't change.

### 12.4 Per-worktree dev stack

- `pnpm agent:setup` installs deps, claims a **20-port block**, and writes `.dev/env`.
  - The block is recorded in `<git-common-dir>/alias-dev-ports.json`, which every worktree of the repo shares. Writes take an mkdir lock.
  - Setup probes blocks for free ports and prunes entries for deleted worktrees.
  - T3 Code should run this as the project setup script.
- `pnpm dev` starts:
  - `alchemy dev` (workerd + local D1, strict port);
  - `vp dev` (proxies `/v1` and `/health` to the API);
  - the ses-emulator SMTP server.

### 12.5 Agent guardrails

- **`AGENTS.md`** (plus the `CLAUDE.md` symlink) covers layout, commands, hermetic rules, and the definition of done (`pnpm check` + `pnpm test:affected`).
- **Project skills** in `.agents/skills/alias-*`, symlinked into `.claude/skills`:
  - `alias-testing` (tiers, hermetic rules, known issues);
  - `alias-dev-stack` (ports, local D1, sending test mail).
- **pstack** (vendored at project level, pinned by hash in `skills-lock.json`, MIT) provides all 56 upstream skills, including the 24 `principle-*` skills that `/poteto-mode` reads, and the `poteto-agent` subagent. The repo installs the full set because `poteto-mode` routes to skills such as `figure-it-out`, `no-comments`, `benchmark-checklist` and `ketchup`, and the pstack README says it needs most of the others. A partial install broke those routes.
  - Install or update with `pnpm dlx skills add backnotprop/pstack -a codex -a claude-code`. That puts each skill in `.agents/skills` and links it into `.claude/skills`. With `-a claude-code` alone, the CLI copies every skill into `.claude/skills` instead.
  - `deslop`, `control-cli` and `control-ui` ship in Cursor's `cursor-team-kit` plugin, not in pstack, so they stay unavailable here.
  - Restore with `pnpm dlx skills experimental_install`.
- **Lint fence (today).** It bans `any` and bans `console.*` outside scripts, and it prefers Vite+ imports. Planned additions: no `Effect.runPromise` outside entrypoints, no `Date.now`/`Math.random` in `core`, and a `debt.md` ledger.
- **CI** (`.github/workflows/ci.yml`) runs `check`, a per-package `test` matrix, and a web `build`.

### 12.6 Known issues & mitigations

| Issue                                                                                                                                                                            | Impact                                     | Mitigation                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vitest 5 support in `@cloudflare/vitest-plugin` is days old. Open bugs: #16331 (`cloudflare:test` in setupFiles kills workerd with large Effect graphs), #16252, #16238, #16349. | Worker tier could flake as the graph grows | Never import `cloudflare:test` in setup files. Keep most logic in the unit tier via the layer-matrix pattern. As a fallback, pin a Vitest 4.1 project for the worker tier only. |
| `alchemy dev` can serve requests before local D1 migrations finish (one 500 observed right after start)                                                                          | Flaky first request in e2e                 | Readiness wait in `dev.ts` / e2e setup                                                                                                                                          |
| Alchemy v2 is beta (83 betas so far)                                                                                                                                             | API churn                                  | Runtime code doesn't import Alchemy. Only `infra/` does.                                                                                                                        |
| `@effect/sql-d1`: no transactions                                                                                                                                                | Multi-statement writes                     | `D1Client.batch` for atomic groups                                                                                                                                              |
| Workers AI has no local emulator                                                                                                                                                 | n/a                                        | `Classifier` service + stub/Ollama (phase 7)                                                                                                                                    |

---

## 13. D1 vs Aurora DSQL

> **Superseded by §14, which chose DSQL.** With compute on Lambda, D1 is no longer reachable natively, and DSQL's free tier makes it $0 early on.

**Short answer.** For this workload, D1 is effectively **$0**, while DSQL is **not much cheaper and costs us emulation, latency and simplicity**. Stay on D1, and keep repositories on the generic `SqlClient` so a later move to Postgres/DSQL is a Layer swap plus SQL dialect fixes.

|                                                       | **D1** (Workers Paid, already paid for)                                    | **Aurora DSQL**                                                                                                                                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Included                                              | 25 B rows read + 50 M rows written + 5 GB / month                          | 100 k DPUs + 1 GB / month                                                                                                                                                                                                              |
| Overage                                               | $0.001 / M rows read, $1 / M rows written, $0.75 / GB-mo                   | ~$8 / M DPUs (us-east; eu-west-1 is region-priced), $0.33 / GB-mo                                                                                                                                                                      |
| Our scale: 1 M forwards/mo (~5 reads + 2 writes each) | 5 M reads + 2 M writes, which is **inside the included quota, $0**         | ~0.14 DPU per small transaction (AWS's TPC-C figure) gives ~1 M DPUs, or **~$8/mo** + storage                                                                                                                                          |
| Local emulation                                       | **Exact.** The same workerd SQLite engine runs in `alchemy dev` and Vitest | **None official.** LocalStack wraps plain Postgres (auth token required). Nothing local reproduces these DSQL traits: no FKs, no sequences, no triggers, Repeatable Read only, 3,000-row transactions, optimistic-concurrency retries. |
| Access from Workers                                   | Native binding, zero network hop                                           | TCP over `cloudflare:sockets` with a SigV4 IAM token per connection (max 1 week), or Hyperdrive with weekly token rotation. Cross-cloud round trip per query to eu-west-1.                                                             |
| Limits that matter                                    | 10 GB per database, single writer                                          | Effectively unlimited, multi-region active-active                                                                                                                                                                                      |
| Fit                                                   | Metadata is small, because mail bodies go to R2 or are never stored        | Overkill until we outgrow 10 GB/DB, then shard per tenant group or migrate                                                                                                                                                             |

**Revisit** when a single D1 database approaches ~5 GB or write contention shows up. At that point, the options are to shard by user (D1 supports many databases), or move hot tables to DSQL/Neon via a `SqlClient` Layer swap.

---

## 14. Pivot to AWS-native (SES classic + Lambda + DSQL), Cloudflare R2 only (decided 2026-10-21)

**Decision:**

- **Mail:** SES classic (v1 receipt rules for inbound, SESv2 for sending).
- **Compute:** Lambda (arm64).
- **Database:** Aurora DSQL.
- **Cloudflare:** only **R2** object storage (free tier), plus free DNS.

The reason is that the first months bring no revenue, and AWS's free allowances make compute and database **$0**, where Workers Paid is a flat **$5/month**.

This supersedes the Cloudflare-compute parts of §3, §11, §12 and §13.

### 14.1 Monthly cost (eu-west-1 prices, `node scripts/cost-model.ts`)

| Scenario                   | Users | Mails/mo | API req/mo | Mail edge (SES + S3 spool) | **AWS compute + DB** | CF Workers Paid compute | **AWS total** | CF total  |
| -------------------------- | ----- | -------- | ---------- | -------------------------- | -------------------- | ----------------------- | ------------- | --------- |
| Pre-launch (you + testers) | 5     | 2 k      | 20 k       | $0.72                      | **$0.00**            | $5.00                   | **$0.72**     | $5.72     |
| Early beta                 | 100   | 30 k     | 300 k      | $10.73                     | **$0.00**            | $5.00                   | **$10.73**    | $15.73    |
| Growing                    | 1 k   | 300 k    | 3 M        | $107.29                    | $7.51                | $5.17                   | $114.79       | $112.46   |
| Established                | 10 k  | 3 M      | 30 M       | $1,072.86                  | $119.66              | $18.41                  | $1,192.52     | $1,091.27 |

How to read it:

- **You're right for the first months.** AWS compute + DB is $0 up to roughly 100 to 300 k mails/month, thanks to Lambda's always-free 1 M requests + 400 k GB-s and DSQL's 100 k DPU + 1 GB/month.
- **Break-even is around the "growing" row.** Beyond that, Cloudflare's flat plan scales better. DSQL DPUs and CloudFront requests grow linearly, while Workers include 10 M requests + 30 M CPU-ms.
- **SES dominates every row,** and it's identical in both designs. Inbound is $0.19/1k (receive + one 256 KB chunk), including catch-all junk. Outbound is $0.10/1k. The infrastructure choice moves the bill by single digits until you have paying users. The levers that matter are mail-side: reject junk early, limit catch-all, and charge for volume.
- **New-account credits ($100 to $200 over 6 months)** cover the early-beta row entirely. Accounts on the AWS _Free plan_ have restrictions (e.g. no CloudFront flat-rate plans), so check whether SES production access needs the paid plan before applying.
- **The biggest uncertainty is DPU per operation.** AWS quotes ≈0.14 DPU per small read-mostly transaction, and the model assumes 0.8 per mail and 0.2 per API call. Measure in staging and update `ASSUME` in the script.

**Cost traps to design out** (each is easily more than the $5 we're saving):

| Trap                          | Cost                              | Avoid by                                                                                                                  |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Lambda in a VPC → NAT Gateway | ~$35+/mo + data                   | No VPC. DSQL has a public, IAM-authenticated endpoint.                                                                    |
| Public IPv4 addresses         | $3.60/mo each                     | No EC2/NAT. Lambda and DSQL don't need one.                                                                               |
| API Gateway HTTP API          | $1.11 / M requests                | Lambda **Function URL** (free) behind CloudFront (10 M req/mo always free, or the $0 flat-rate plan)                      |
| CloudWatch Logs               | $0.57/GB ingested                 | Lambda advanced logging: JSON format, system log level `WARN` (drops START/END/REPORT), app level `WARN`, 7-day retention |
| Secrets Manager               | $0.40/secret/mo                   | SSM Parameter Store standard (free)                                                                                       |
| Customer-managed KMS keys     | $1/key/mo                         | AWS-managed keys, with envelope encryption in-app                                                                         |
| Route 53 hosted zones         | $0.50/zone/mo (3 domains = $1.50) | Keep DNS on Cloudflare (free)                                                                                             |
| SES default plan              | Essentials $0.16/1k vs $0.10      | Switch the account to à la carte                                                                                          |
| CloudWatch alarms             | $0.10/alarm/mo (standard)         | Four SES reputation alarms only (§20.13), inside the 10 free alarms; no per-user or per-set alarms, no high resolution    |

### 14.2 New architecture

```
Internet MX ─▶ SES (eu-west-1) receipt rule set (v1 API)
                 rule: no recipient = all verified domains, plus `.alias.example`
                 action 1: S3 PutObject (spool bucket, 1-day lifecycle)
                 action 2: Lambda (Event invoke) ─▶ inbound Lambda (arm64)
                                                     GET raw from S3 → resolve alias (DSQL)
                                                     → policy / rewrite → SESv2 SendEmail
                                                     → inbox/temp: encrypt → R2 · metadata → DSQL
                                                     → DELETE spool object
                                                     (async retries + SQS DLQ, both free tier)
Browser ─▶ CloudFront ─┬─▶ /v1/* → API Lambda (Function URL, Effect HttpApi)
                       └─▶ /*    → static React app (S3 or R2 origin)
Cron: EventBridge Scheduler (14 M/mo free) → TTL purge, identity polling
Realtime (temp inbox live view): API Gateway WebSocket ($1.14/M msgs, $0.285/M conn-min)
                                 or long-poll on the API Lambda (start with long-poll)
Object storage: Cloudflare R2 (inbox bodies, attachments; free egress, 10 GB free)
```

There's no SNS hop any more. SES invokes Lambda directly.

### 14.3 What changes in the repo

| Area                      | Today (phase 1)                      | After pivot                                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`             | `@effect/sql-d1` + node:sqlite tests | `@effect/sql-pg` against DSQL (IAM token via `@aws-sdk/dsql-signer`, refreshed per connection). Tests on **`@effect/sql-pglite` 4.0.5**: Postgres in-process, no Docker, no ports, still hermetic. The layer-matrix suite stays, and the backends change.   |
| Migrations                | SQLite DDL with `REFERENCES`         | Postgres DDL that's DSQL-safe: no foreign keys, sequences or triggers; `CREATE INDEX ASYNC`; one DDL per transaction. Add a `scripts/dsql-lint.ts` check so PGlite tests can't hide DSQL-only failures.                                                     |
| `apps/api`                | Workers `fetch` + workerd tests      | Lambda handler (Function URL event → `Request` → the same `HttpRouter.toWebHandler(ApiLive)`). Tests become plain Node tests with fixture events, which **removes the Vitest 5 + workerd risk** from §12.6.                                                 |
| Inbound                   | Planned SNS → Worker                 | Lambda handler receiving SES `Received` events. The `ses-emulator` invokes the handler in-process instead of POSTing to SNS.                                                                                                                                |
| `infra/alchemy.run.ts`    | Cloudflare D1 + Worker               | Alchemy AWS: `DSQL.Cluster` + `DSQL.Migrations`, `Lambda.Function` (Function URL), S3 spool bucket, `SES.ReceiptRuleSet/ReceiptRule/EmailIdentity`, Scheduler, CloudFront. Cloudflare R2 bucket only. All of these exist in Alchemy beta.83.                |
| `pnpm dev`                | `alchemy dev` (workerd)              | API as a Node HTTP server (same `ApiLive` layer) on PGlite (file-backed in `.dev/`), ses-emulator calling the inbound handler, `vp dev` for web. **No Docker.** Alchemy's Floci-based Lambda emulation (needs Docker) stays optional, for packaging checks. |
| Hermetic / parallel story | ✅                                   | ✅ Unchanged. PGlite is in-process, handlers are functions, and ports come from the per-worktree block.                                                                                                                                                     |
| Contract tier             | SES/SNS fixtures                     | SES Lambda-event fixtures + a nightly job against a real DSQL cluster (stays within the 100 k DPU free tier)                                                                                                                                                |

### 14.4 Trade-offs accepted

- **Higher compute cost at scale.** Above roughly 300 k mails/month, AWS compute + DB costs more than Workers' flat plan (≈$120 vs ≈$18 at 3 M mails). That's revisitable later, because handlers stay runtime-agnostic (`toWebHandler`).
- **Weaker local database fidelity.** PGlite is Postgres, not DSQL. It doesn't reproduce DSQL's optimistic-concurrency retries, transaction limits or async indexes. The mitigations are the DSQL lint, the retry wrapper on writes, and nightly real-DSQL contract tests.
- **Lambda cold starts** (~100 to 300 ms with arm64 + bundled Effect) on the API. They're acceptable for a dashboard, CLI and MCP.
- **Realtime is clunkier than Durable Objects.** Start with long-poll, and use API Gateway WebSocket if needed.

---

## 15. Fresh recommendation, October 2026 (proposed; supersedes §14's database choice)

Starting from zero, optimizing for **cheap before revenue, reliable, scales**:

| Concern        | Pick                                                                                                                                                                                                           | Why                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mail in        | SES classic receipt rules (eu-west-1) → S3 spool + **direct Lambda invoke**                                                                                                                                    | The only cheap option with wildcard subdomains and arbitrary custom domains. No SNS/internet hop.                                                                                                            |
| Mail out       | SESv2 `SendEmail` (raw)                                                                                                                                                                                        | $0.10/1k, with DKIM for custom domains                                                                                                                                                                       |
| Compute        | **Lambda** arm64, Node 24                                                                                                                                                                                      | Always-free 1 M requests + 400 k GB-s. Same region as SES/S3, so no egress and no cross-cloud credentials                                                                                                    |
| Database       | **DynamoDB on-demand** (single table, PITR on, TTL for temp data)                                                                                                                                              | Access is key-value (address → alias, token → contact, user → aliases). 25 GB always free. **~$14/mo at 3 M mails vs ~$79 on DSQL.** Free TTL deletes handle temp-mail expiry. The most mature AWS database. |
| Objects        | **S3** (spool with 1-day lifecycle; encrypted inbox bodies with TTL lifecycle)                                                                                                                                 | Cents at our size. SES writes to it natively. R2 only pays off once user downloads exceed AWS's 100 GB/mo free egress.                                                                                       |
| API + web      | CloudFront → Lambda Function URL (`/v1/*`) + S3 (SPA)                                                                                                                                                          | No API Gateway fee. CloudFront always-free 10 M req/mo (or the $0 flat-rate plan).                                                                                                                           |
| Background     | Lambda async retries + SQS DLQ, and EventBridge Scheduler                                                                                                                                                      | All inside free tiers                                                                                                                                                                                        |
| Realtime       | Long-poll on the API Lambda first, API Gateway WebSocket when needed                                                                                                                                           | Pennies                                                                                                                                                                                                      |
| Secrets / logs | SSM Parameter Store, and JSON logs at `WARN`                                                                                                                                                                   | Avoids the Secrets Manager and CloudWatch traps                                                                                                                                                              |
| DNS            | Cloudflare (free)                                                                                                                                                                                              | Route 53 would be $0.50/zone                                                                                                                                                                                 |
| IaC            | Alchemy v2 (pinned beta), with AWS CDK as the conservative fallback                                                                                                                                            | Small stack (~15 resources), so switching later is cheap                                                                                                                                                     |
| Local + tests  | Handlers are plain functions. DynamoDB via `dynalite` (in-process) or Floci (MIT native binary). The ses-emulator invokes the inbound handler in-process. Nightly contract tests against real AWS (free tier). | Hermetic, no Docker, parallel-safe                                                                                                                                                                           |

**Compute + DB per month (excluding the identical SES/S3 mail edge), from `node scripts/cost-model.ts`:**

| Scenario    | Mails/mo | **Lambda + DynamoDB**                                         | Lambda + DSQL | CF Workers Paid |
| ----------- | -------- | ------------------------------------------------------------- | ------------- | --------------- |
| Pre-launch  | 2 k      | **$0.01**                                                     | $0.00         | $5.00           |
| Early beta  | 30 k     | **$0.14**                                                     | $0.00         | $5.00           |
| Growing     | 300 k    | **$1.91**                                                     | $7.51         | $5.17           |
| Established | 3 M      | **$54.78** (CloudFront is $24 of it, or $15 on the flat plan) | $119.66       | $18.41          |

**Rejected:**

- **Lambda + DSQL.** It has relational features we don't use, costs 5× DynamoDB at scale, and is a young service with IAM-token connections and no faithful local emulator.
- **Hyperdrive.** It's free and good, but it's only a pooler from Workers to Postgres/MySQL. It supports password auth only, so it can't connect to DSQL, and it would add a third vendor (Neon/PlanetScale).
- **Cloudflare Workers + D1.** It has the best developer experience and is the cheapest at large scale, but it costs $5 from day one. Every mail crosses clouds (SES → SNS → Worker → S3), mail bodies are processed at the global edge (a weaker EU-residency story for a privacy product), and D1 caps at 10 GB per database. It's a close second.

**The real risks are mail-side, not infrastructure:**

- **SES account health.** The bounce rate must stay under 5% and complaints under 0.1%. Forwarded spam can get the account paused.
- **SES limits.** We have to exit the sandbox and get through the sending-quota ramp.
- **Lambda quotas.** New accounts get reduced concurrency. Request an increase before launch.
- **Unit economics.** At ~$0.30 per 1,000 forwarded mails, SES is over 90% of the bill at every stage. Free-plan limits and pricing must cover it.

---

## 16. Can it all run on Cloudflare's $5 plan? (researched 2026-10-21)

### 16.1 Cloudflare can't natively give 100k users per-user subdomains (`…@user1.example.com`)

- **Catch-all is apex-only.** Cloudflare's docs say _"Catch-all rules are only available for the apex domain."_
- **Subdomains are enabled one by one,** and _"A zone can have up to 30 domains configured for Email Routing or Email Sending combined, including the apex domain."_ That's about 29 users per zone, not 100k.
- **No wildcard** routing domain is documented. Community threads asking for it remain unresolved.
- **A limit increase** form exists, but nothing suggests 100k subdomains (≈3,300× the default) is grantable. Don't build the product on it.
- **Sending is different.** The Email Sending API accepts a _leftmost wildcard_ sending domain (`*.example.com`). Sending from subdomains is possible, but receiving isn't.
- **Custom domains.** Email Routing only works for zones in our Cloudflare account, so users would have to move their nameservers to us. There's no "add an MX + TXT record" flow, and Cloudflare for SaaS (custom hostnames) doesn't cover email.

### 16.2 Workarounds that keep Cloudflare

| Option                                                                                       | Address shape                                                          | Cost impact                                                                  | Verdict                                                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Username in the local part**, on a dedicated namespace domain with apex catch-all → Worker | `user1.shop@ns-domain` (SimpleLogin's "directories" use the same idea) | none                                                                         | **Recommended.** Same privacy and UX, with no special infrastructure. |
| SES bridge for subdomains: `*.alias.example` MX → SES receipt rule → SNS → Worker            | `shop@user1.alias.example`                                             | ≈+$0.12/1k received mails for every subdomain mail (≈+$310/mo at 100k users) | Only if the subdomain format is a hard requirement                    |
| SES bridge for custom domains only                                                           | `anything@user-domain.com`                                             | SES inbound only on custom-domain mail (typically a paid tier)               | **Recommended for custom domains**                                    |
| Users move their domain's nameservers to our Cloudflare account                              | `anything@user-domain.com`                                             | free                                                                         | Optional power-user path with poor onboarding UX                      |

### 16.3 Whole-design cost, mail included (`node scripts/cost-model.ts`, re-run after the doc check)

| Scenario                             | A: Cloudflare only | **B: Cloudflare + SES for sending** | C: AWS only |
| ------------------------------------ | ------------------ | ----------------------------------- | ----------- |
| Pre-launch (2 k mails)               | $5.00              | $5.21                               | **$0.54**   |
| Early beta (30 k)                    | $14.45             | $8.11                               | **$8.05**   |
| Growing (300 k)                      | $108.95            | **$36.08**                          | $80.95      |
| 100k users (2 M mails, 10 M API req) | $717.42            | **$225.67**                         | $536.75     |

Why B wins once there's real volume:

- **Inbound is free** on Cloudflare Email Routing (unlimited; catch-all junk costs nothing). SES bills every received mail.
- **Outbound is 3.5× cheaper** on SES ($0.10/1k vs $0.35/1k), with 40 MB messages instead of CF's 5 MiB.
- **`message.forward()` doesn't scale.** It's free, but only to verified destinations (≤200 per account), so real forwarding is a re-send through SES.

The $5 plan covers the 100k-user platform side: 10 M requests + 30 M CPU-ms; D1 25 B reads / 50 M writes / 5 GB; D1 10 GB per database (single-threaded), 50,000 databases per account; R2 10 GB free with free egress.

### 16.4 Trade-offs vs all-AWS (§15)

- **Pre-launch costs ~$4.50/mo more** (the Workers Paid minimum). From early beta on, B is the cheapest design.
- **Address format.** User namespaces live in the local part, not a subdomain, unless we pay for the SES bridge for subdomains.
- **Two vendors.** Cloudflare handles inbound, compute and storage. SES handles outbound and the custom-domain inbound bridge.
- **Data residency.** Email Routing MX and Workers run on Cloudflare's global network, while AWS keeps everything in eu-west-1. For an EU privacy story, D1 can be created with an EU jurisdiction. Worker execution location is not guaranteed on non-Enterprise plans.
- **SLAs.** Cloudflare offers no SLA below Enterprise. AWS SES/Lambda/DynamoDB have published SLAs.

### 16.5 Verified against the official docs (2026-10-21)

The check read these pages directly: Cloudflare `email-service/*` markdown (subdomains, limits, pricing, routing rules, email handler, send API, changelog, Email Sending REST API schema) and AWS `ses/latest/dg/*` markdown (receiving concepts, setup, verification, MX, receipt rules, Lambda/S3/SNS actions, notification contents, quotas) plus aws.amazon.com/ses/pricing.

| Claim                                                                      | Status            | Source quote / note                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CF catch-all only on apex                                                  | ✅                | "Catch-all rules are only available for the apex domain." / "Catch-all entries support apex domains only."                                                                                                                                                                                                      |
| CF max 30 routing+sending domains per zone                                 | ✅                | "A zone can have up to 30 domains configured for Email Routing or Email Sending combined, including the apex domain." A limit-increase form exists, with no promise.                                                                                                                                            |
| CF wildcard **routing**                                                    | ✅ none           | Routing API matchers are only `all` or `literal`. No wildcard anywhere in the Email Service docs.                                                                                                                                                                                                               |
| CF wildcard **sending** domain                                             | ✅ (API only)     | Email Sending subdomain `name`: "The exact domain name or a leftmost wildcard such as `*.example.com`". Not mentioned in the guides.                                                                                                                                                                            |
| CF needs Cloudflare DNS                                                    | ✅                | "You must be using Cloudflare DNS to use Email Service."                                                                                                                                                                                                                                                        |
| CF inbound unlimited on Free and Paid                                      | ✅                | The pricing table lists Inbound (Email Routing) as "Unlimited". Email Workers are billed as Workers.                                                                                                                                                                                                            |
| CF outbound 3,000/mo then $0.35/1k, Paid only                              | ✅                | Pricing table                                                                                                                                                                                                                                                                                                   |
| CF 5 MiB send limit (25 MiB to verified)                                   | ✅                | Limits table                                                                                                                                                                                                                                                                                                    |
| CF `forward()` only to verified destinations, 200 per account              | ✅                | "All destinations must be verified beforehand." / "Destination addresses per account: 200"                                                                                                                                                                                                                      |
| CF `send()` accepts raw MIME                                               | ✅                | `send(message: EmailMessage \| EmailMessageBuilder)`                                                                                                                                                                                                                                                            |
| CF inbound spam verdicts                                                   | ⚠️ not provided   | Docs show only Worker-side spam filtering (an example class). SES gives spam/virus/SPF/DKIM/DMARC verdicts.                                                                                                                                                                                                     |
| SES `.example.com` matches all subdomains                                  | ✅                | Receipt-rule walkthrough table                                                                                                                                                                                                                                                                                  |
| SES rule with no recipients covers all verified domains **and subdomains** | ✅                | "…applied to everything - all email addresses, domains, and sub-domains that belong to your verified domains."                                                                                                                                                                                                  |
| SES receiving needs domain verification + MX                               | ✅                | Setup page. A wildcard MX (`*.alias.example`) isn't mentioned, but subdomain receiving is. **Confirm wildcard MX in staging.**                                                                                                                                                                                  |
| SES Lambda action gets no body                                             | ✅                | "…it doesn't contain the body of the message." So S3 is required (≤40 MB). SNS carries ≤150 KB.                                                                                                                                                                                                                 |
| SES blocking after SMTP is still billed                                    | ✅                | "…because receipt rules are processed after the SMTP conversation, we bill you for each message that you receive." Only IP filters block for free.                                                                                                                                                              |
| SES identities ≤10,000 per region                                          | ✅                | The quotas page says "Please contact your AWS Account Manager" to raise it. **This caps custom domains on SES at ~10k.**                                                                                                                                                                                        |
| SES receipt recipients per rule                                            | ⚠️ docs disagree  | The quotas page says 500 and the walkthrough says 100. It doesn't matter, because we use domain and no-recipient rules.                                                                                                                                                                                         |
| SES inbound $0.10/1k + chunks                                              | ✅, **corrected** | Chunks are $0.09/1k _chunks of 256 KB_, billed by volume. AWS's example is "(50KB × 300K) ÷ 256KB × $0.09/1K". A 50 KB mail costs ≈$0.118/1k, **not $0.19/1k** as used in §6 and §14. The same page also says "Email size over 256KB will be charged…", which suggests small mails may pay no chunk fee at all. |
| SES default Essentials plan for inactive accounts                          | ✅                | "…no metered SES activity since June 1, 2025 will start on the Essentials plan beginning July 21, 2026. You can … switch to à-la-carte pricing at any time."                                                                                                                                                    |
| SES sandbox 200/day, 1/s; v2 messages ≤40 MB                               | ✅                | Quotas page                                                                                                                                                                                                                                                                                                     |
| R2 free tier                                                               | ✅                | 10 GB-month, 1 M Class A, 10 M Class B; free egress                                                                                                                                                                                                                                                             |
| CloudFront always-free 10 M requests (pay-as-you-go)                       | ⚠️ unverified     | The official page now leads with flat-rate plans (a $0 Free plan exists). The pay-as-you-go always-free numbers weren't found on it.                                                                                                                                                                            |

**Earlier mistakes this check corrected:**

1. SES inbound cost was overstated (about $0.19 instead of about $0.12 per 1k for typical mail), so §6/§14/§15 AWS totals were too high.
2. "Cloudflare supports wildcard sending subdomains" is true only in the REST API schema, not in the guides. Treat it as undocumented behaviour until tested.

---

## 17. Custom domains (up to 3 per user) on a 100% Cloudflare build (docs read 2026-10-21)

### 17.1 Hard facts from the docs

| Fact                                                                | Source quote                                                                                                            |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Email Service only works on domains using Cloudflare DNS            | "You must be using Cloudflare DNS to use Email Service."                                                                |
| Routing **and** sending only accept domains in _our_ account        | Onboarding: "Choose a domain from your Cloudflare account."                                                             |
| Free/Pro accounts can only do full setup (nameserver delegation)    | "If you are on a Free or Pro plan, primary setup (full) is the only one available."                                     |
| Partial (CNAME) setup                                               | "only available to customers on a Business or Enterprise plan"                                                          |
| Delegating only a subdomain (`mail.userdomain.com`) as its own zone | Subdomain setup availability: Free No, Pro No, Business No, Enterprise Yes                                              |
| Zone creation rate                                                  | "you can only sign up a maximum of 25 domains every 10 minutes"                                                         |
| Pending-zone block                                                  | "if you have over 50 domains and, of those domains, more are pending than active, you will be blocked from adding more" |
| Pending zones expire                                                | Pending for 28 days → Deleted                                                                                           |
| DNS records per Free zone                                           | 200 (zones created on or after 2024-09-01)                                                                              |
| Total zones per account                                             | No documented cap found. Treat as "talk to Cloudflare before 10k+".                                                     |
| Sending onboarding writes DMARC                                     | Adds `_dmarc` `v=DMARC1; p=reject;` plus `cf-bounce` MX/SPF/DKIM                                                        |

**Consequence.** The addy.io UX ("keep your DNS provider, add an MX and a TXT record") is **impossible on Cloudflare alone**. Cloudflare's MX only serves zones that are on Cloudflare DNS in the account that owns the routing.

### 17.2 Options

|                                              | A: Domain moves into **our** Cloudflare account                                             | B: Domain stays in the **user's own** Cloudflare account                                                                                          | C: SES bridge (not 100% Cloudflare)                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| User does                                    | Changes nameservers at the registrar to the pair Cloudflare assigns our account             | Deploys our open-source relay Email Worker (Deploy button) as the catch-all. It POSTs `message.to` + raw MIME to our API with a per-domain token. | Adds MX + 3 DKIM CNAMEs at any DNS provider                      |
| Receive                                      | ✅ catch-all → our Worker, set up via API                                                   | ✅ (their Worker, and the Free plan is fine for relaying)                                                                                         | ✅ SES → S3/SNS → Worker                                         |
| Reply / send as `alias@userdomain`           | ✅ onboard as our sending domain via API                                                    | ❌ unless _their_ account has Workers Paid (sending to arbitrary recipients needs Paid)                                                           | ✅ SES DKIM                                                      |
| Rest of the user's DNS (website, other mail) | **We host it.** We need a DNS editor in our UI, and the apex MX belongs to us.              | Unchanged                                                                                                                                         | Unchanged                                                        |
| Scale limits                                 | 25 zones / 10 min; blocked if pending > active (above 50); no documented total cap          | none on our side                                                                                                                                  | 10,000 SES identities per region (raise via AWS account manager) |
| Cost                                         | Free zones $0                                                                               | $0                                                                                                                                                | ≈$0.12 / 1k received mails                                       |
| Trust / lock-in                              | High. We control their whole domain's DNS, so it needs a zone-file export and an exit path. | Low                                                                                                                                               | Low                                                              |

### 17.3 Recommendation for "100% Cloudflare"

**Option A as the main path, B for users already on Cloudflare, and C only if demand shows up.**

Guardrails for A (all needed because of the documented limits):

1. **Recommend a dedicated domain** for aliases. The user's website and work mail stay on their main domain.
2. **Protect the "pending > active" rule.** It's a denial-of-service vector, since anyone could add domains they don't own.
   - Only verified accounts can add domains.
   - Max **1 pending domain per user** (3 active).
   - Delete pending zones after **48 h** via API (Cloudflare waits 28 days).
   - Keep a global budget of pending ≤ ½ active.
3. **Respect the creation rate:** queue zone creation at ≤25 per 10 min, then show the assigned nameservers and poll until the zone is active.
4. **On activation,** call the API to enable Email Routing DNS, set the catch-all to our Worker, and onboard the sending domain. Warn before overwriting an existing `_dmarc` record.
5. **DNS management.** Provide a minimal record editor in our UI (A/AAAA/CNAME/TXT/MX on non-apex hostnames), a zone-file export, and a documented exit path (re-add the zone in their own Cloudflare account, switch nameservers).
6. **Before ~10k custom-domain zones,** contact Cloudflare about account zone volume. They may require Enterprise or a platform agreement.

**Capacity math.** In theory, 100k users with up to 3 domains each means up to 300 k zones. Realistically, 2 to 10 % of users add a domain, so expect ~2 to 30 k zones. A plain Free/Paid account is fine at the low end and needs a Cloudflare conversation at the high end.

---

## 18. Custom-domain UX reality check (2026-10-21) drops option A for MX records + Domain Connect

**Option A (domain moves into our Cloudflare account) is technically possible but not one-click and not trustworthy:**

- **Onboarding steps:**
  - We create the zone (status _Pending_), then run quick scan or a BIND import.
  - The user reviews records, turns off DNSSEC at the registrar, and changes nameservers by hand at the registrar.
  - Cloudflare's activation check runs first after 60 s, then at increasing intervals (re-triggerable via API).
- **Import is incomplete.** Quick scan "is built upon a list of recurring patterns" and "is not guaranteed to find all existing DNS records". BIND import is limited to 256 KiB and 3 requests/min. Missed records (e.g. DKIM selectors of an existing mail provider, odd subdomains) break the user's website or mail.
- **DNSSEC trap.** "Changing nameservers while DNSSEC is active can cause your domain to become unreachable."
- **Cloudflare Registrar domains can't do it at all.** Their nameservers "must remain in place" for the owning account. The only path would be moving the _registration_ into our account.
- **Trust.** The zone would live in _our_ account. We'd control the user's entire DNS, including TLS issuance, the website, and all mail, and the user would get no Cloudflare dashboard access. A compromise of our account would hijack every user domain. Hosting/CDN platforms ask for this. Email/alias providers (addy.io, SimpleLogin, Fastmail, Proton, Google Workspace) only ask for MX/TXT/CNAME records. For a privacy product this is a red flag.

**Decision (proposed).** Custom domains use **records only**:

- MX → `inbound-smtp.eu-west-1.amazonaws.com`
- 3 SES DKIM CNAMEs
- SPF / DMARC (plus an optional custom MAIL FROM)

Receiving and sending as the custom domain go through SES (§16.2 option C). Shared domains stay 100% Cloudflare.

**One-click via Domain Connect.** It's an open standard (DNS providers listed on domainconnect.org include **Cloudflare, GoDaddy, IONOS, Vercel, WordPress.com, NameSilo, Plesk**). The user authenticates at their DNS provider, sees the records, and approves.

- Publish a template in the `Domain-Connect/Templates` GitHub repo. Cloudflare supports the synchronous flow only, needs `syncBlock: false` and a `syncPubKeyDomain`, and onboarding happens via `domain-connect@cloudflare.com`.
- For other providers (Namecheap, Porkbun, Hetzner, Strato…), fall back to copy-paste records and a live DNS check (≈5 records, done in minutes).

Option B (relay Worker in the user's own Cloudflare account) stays an optional power-user path. It can only receive unless the user pays for Workers themselves.

---

## 19. SES for all mail, tips, and what's next (2026-10-21)

### 19.1 Decision: SES receives _all_ mail (shared and custom domains)

**Why it's better despite costing more than free Cloudflare inbound:**

- **One inbound path.** That means one emulator, one test matrix and one set of failure modes.
- **Every mail gets spam/virus/SPF/DKIM/DMARC verdicts.** Cloudflare provides none.
- **Both address formats work:**
  - `anything@user1.example.com` (via `.example.com` receipt rules);
  - `amazon.user1@example.com`.
- **No limits** apply from the 30-domains-per-zone cap or the Cloudflare-DNS requirement.
- **SES takes 40 MB messages and keeps EU residency in eu-west-1,** and it has published SLAs.

**As a consequence, compute should also move to AWS.** From `node scripts/cost-model.ts`:

| Scenario   | C: all AWS (Lambda + DynamoDB + S3 + SES) | D: SES all + Cloudflare compute (SNS → Worker) |
| ---------- | ----------------------------------------- | ---------------------------------------------- |
| Pre-launch | **$0.54**                                 | $5.53                                          |
| Early beta | **$8.05**                                 | $12.90                                         |
| Growing    | **$80.95**                                | $84.22                                         |
| 100k users | **$536.75**                               | $549.07                                        |

Once SES handles inbound, Cloudflare compute only adds a cross-cloud hop (SNS push + S3 GET over the internet) and the $5 minimum. **The recommended target is §15 (Lambda + DynamoDB + S3 + SES, eu-west-1).** Cloudflare stays for DNS (free) and, optionally, R2.

The phase-1 scaffold (Workers/D1) gets ported. The test architecture carries over unchanged: hermetic suites, the layer-matrix pattern, the in-process SES emulator, and the per-worktree ports.

### 19.2 Tips & tricks

**End-user simplicity**

1. **Speak the addy.io/SimpleLogin API dialect.** Bitwarden's username generator supports addy.io and SimpleLogin _with a self-hosted server URL_. A compatible "create alias" endpoint gives users alias generation inside Bitwarden on day one, with zero client work.
2. **Domain Connect** gives one-click custom-domain setup (Cloudflare, GoDaddy, IONOS, Vercel, …), with copy-paste plus a live DNS check as the fallback.
3. **Passkeys first.** The WebAuthn **PRF** extension can derive per-user encryption keys for zero-access stored mail. It works on Chromium/Android and Safari platform authenticators, but support is uneven elsewhere, so make it opt-in with a recovery key.
4. **Reply and send-new from an alias** without hand-typed reverse addresses, by composing in the web app, CLI and MCP. Comparison sites call this the new dividing line between services.

**Mail correctness and SES account health** (the real outage risk)

5. **Never spoof the original sender.** Rewrite `From` to a reverse alias on our domain (DMARC-aligned) and keep the original in the display name. That's what keeps forwarding working under DMARC. DMARCbis is RFC 9989 to 9991, published May 2026.
6. **Bounces and complaints.** Use the SESv2 suppression list, auto-disable recipients that hard-bounce (built, §20.11), and alert well before the 5 % bounce and 0.1 % complaint thresholds (open).
7. **Junk control:**
   - Drop on spam/virus verdicts before any work.
   - Rate-limit on-the-fly alias creation per user, and make catch-all opt-in per domain.
   - Use SES IP filters to block known-bad sources for free. Receipt-rule rejects are still billed.
8. **Loop and auto-reply safety** (built, §20.7):
   - Honour `Auto-Submitted`.
   - Never forward to another alias.
   - Cap forwards per alias per hour.
9. **Idempotency.** Lambda async invokes are at-least-once, so dedupe on the SES `messageId` (DynamoDB conditional write with a TTL). Built as `DeliveryRepo` (§20.6).

**Testability (already partly enforced)**

10. **Functional core.** `InboundEnvelope → Decision[]` stays pure, and I/O lives only in adapters. The Effect lint already forces Clock/Crypto/Config through services, so tests are deterministic.
11. **A golden `.eml` corpus** of anonymized real mail (newsletters, OTPs, attachments, broken MIME, non-UTF-8), with snapshot tests of the rewritten output and a header-leak diff.
12. **Property-based tests** (`Schema` arbitraries) for address parsing, reverse-alias tokens and MIME round-trips.
13. **Contract fixtures:**
    - Decode recorded real SES events with `ReceivedNotification` (now an Effect Schema).
    - Run the same fixtures against the emulator.
    - Re-record nightly from a sandbox account.

### 19.3 What the future looks like (researched)

| Trend                                                                               | Status Oct 2026                                            | Play for us                                                                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Email for AI agents** (AgentMail, Sendmux, inbound-as-webhook APIs)               | Fast-growing category                                      | Temp inboxes + OTP extraction + MCP are exactly this. Position the API/MCP as "disposable inboxes for agents and CI".   |
| **Lambda durable functions** (Dec 2025)                                             | GA in Node.js                                              | Multi-step mail pipelines (wait for verification, retries) without Step Functions. Effect `workflow` is an alternative. |
| **SES Mail Manager** (Apr 2026: Lambda action, SMTP bounce, address lists of 100 k) | Mature, but $50/mo per open ingress                        | Future upgrade path to reject unknown recipients _during SMTP_ once junk volume justifies it                            |
| **SES inbox-placement metrics + blocklist monitoring** (May 2026)                   | New                                                        | Watch shared-domain reputation                                                                                          |
| **DMARCbis** (RFC 9989 to 9991, May 2026)                                           | Published                                                  | Keep sender rewriting; don't force `p=reject` onto user domains                                                         |
| **Passkey PRF encryption**                                                          | Usable, uneven                                             | Optional zero-access vault                                                                                              |
| **JMAP**                                                                            | Fastmail, Stalwart, Thundermail; little traction elsewhere | Skip for now, maybe later for inbox mode                                                                                |

---

## 20. Port to AWS, emulator-only (done 2026-10-22)

The user decided on 2026-10-21 to use AWS for everything except DNS. The requirement is to develop and test **only against emulators** and keep it that way. Every emulator must itself be verified.

### 20.1 What changed

| Area                   | Before                              | After                                                                                                                                  |
| ---------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| API                    | Cloudflare Worker, tests in workerd | Lambda function URL handler (`apps/api/src/handler.ts`), with the same `ApiLive` via `HttpRouter.toWebHandler` + `FunctionUrl` adapter |
| Database               | D1 + SQL migrations                 | DynamoDB single table (`Table.spec`), `AliasRepo` on `@distilled.cloud/aws` (Effect-native, the SDK Alchemy uses)                      |
| Inbound events         | SNS-style notification              | SES Lambda-action event (`SesEvent`), spool key `prefix + messageId`                                                                   |
| Local API              | `alchemy dev` (workerd)             | real handler behind `tools/lambda-emulator`                                                                                            |
| Infra                  | CF D1 + Worker                      | AWS DynamoDB, S3 spool, API Lambda + URL, inbound Lambda, SES rule set (typechecked, not deployed)                                     |
| Docker / cloud account | none                                | none. Tools (fakecloud, Java 17, Node, pnpm) come from `mise.toml`                                                                     |

### 20.2 How emulation is verified

1. **Two independent DynamoDB engines, never skipped.** The repository suite runs on fakecloud and on Amazon DynamoDB Local 3.3.2 (AWS's own; SHA-256-pinned download). Behaviour must agree on both (§20.4).
2. **Contract fixtures.** AWS-documented payloads (SES Lambda event, function URL request/response) live in `packages/aws/fixtures`. Production schemas must decode them, and emulator output must decode with the same schemas. A test checks the `commonHeaders` derivation against the documented sample.
3. **No shared conversion code.** The function URL emulator (HTTP → event) and the production adapter (event → `Request`) are written separately, so one can't hide the other's bug.
4. **One table spec** feeds both `infra/alchemy.run.ts` and the emulators.
5. **Stack test** (`e2e`). It runs SMTP → SES emulator → S3 spool on fakecloud + Lambda event → the inbound pipeline → SES sending on the same fakecloud, and signs up, confirms a forwarding address and creates an alias over the API Lambda behind a function URL, all on port 0.

This setup has already caught two problems. The documented function URL sample uses `<url-id>` as a domain, which made the adapter throw instead of failing typed (fixed). DynamoDB Local writes a metadata file into its working directory (now a temp dir).

### 20.3 Known gaps (next)

- **Recorded AWS payloads.** Replace doc samples with recorded ones once a sandbox account exists (phase 2). The doc samples stay as a second source.
- **TTL.** fakecloud can expire items on demand (`/_fakecloud/dynamodb/ttl-processor/tick`), but DynamoDB Local can't. Readers ignore expired items (sessions, challenges, delivery claims), because AWS deletes them late.
- **Infra** is only typechecked (`tsc -p infra` in `pnpm check`; `vp check` alone skipped it until 2026-10-22). Done since: the receipt rule invokes the inbound Lambda after the S3 action, with a `lambda:InvokeFunction` permission for SES limited to this account and this receipt rule (`aws:SourceAccount` + `aws:SourceArn`); the spool bucket policy has the same two conditions, with the rule ARN built from fixed rule-set and rule names because SES checks both before the rule exists; the inbound Lambda gets least-privilege grants (S3 get/delete on `inbound/*`, five single-item DynamoDB actions, no index or transactions) and the shared-domain `SendMail` statements, inline on its role because Alchemy's `Lambda.Function` creates the role and takes no managed policies; IAM ARNs name the account. Four CloudWatch alarms on the account's SES reputation metrics notify an SNS topic, mailed to `ALIAS_ALERT_EMAIL` when set (§20.13). The reverse-token keys moved out of the Lambda environment into an SSM `SecureString` that the inbound Lambda reads at cold start, with `ssm:GetParameter` on that one parameter's ARN and no value in the Alchemy state (§20.14). Still open: the ARNs use the fixed table name, and the keys parameter must be put by hand before a stage's first deploy (§20.14). Review before the first deploy.
- **SES sending error paths fakecloud can't produce** (§20.5). Record them from a sandbox account in phase 2.
- **fakecloud doesn't let a verified domain cover its subdomains** (§20.5). Tests verify user subdomains explicitly. Dev works around it with a dev-only hook: `apps/api/bin/dev.ts` verifies `<username>.<shared domain>` when someone signs up (§20.8). The gap itself stays: production relies on AWS covering subdomains, which no emulator here reproduces, so the first deploy must send from a user subdomain once to confirm it.
- **Null envelope sender.** The bounce check (§20.7) treats an SES `mail.source` of `""` or `<>` as the null reverse-path. AWS doesn't document which one SES writes for `MAIL FROM:<>`; the emulator writes `""`. Record one in phase 2.
- **Inbound gaps** (§20.6): spam is always dropped (no quarantine yet), for inboxes too. (Inbox mode stores mail since §20.22.2.) (Long senders work since contacts, §20.9; quoted text is scrubbed since §20.10.)
- **Reply scrubbing limits** (§20.10): attachments (including attached messages) and UTF-16/32 text parts pass as they are; an address written with HTML entities (`&#64;`) or split by markup isn't recognised.
- **SES events and SNS → Lambda** (§20.11). Unrecorded so far: whether SES writes `""` or a name for `mail.source`; the Lambda SNS event's field spelling (the docs sample has `SigningCertURL` next to `UnsubscribeUrl`) and its `Subject` when none was published (the emulator writes `null`); whether turning off email feedback forwarding is accepted with only an event destination (AWS requires some bounce/complaint notification). fakecloud divergences found by reading v0.51.0's source and probing: a suppressed recipient is refused instead of accepted and dropped, `softbounce@simulator` becomes a `Permanent` bounce, published events have no `feedbackId`, `reportingMTA` or `headers`, and an unknown configuration set name is accepted. None of these is on a path the code relies on. Record the real events in phase 2.
- **SSM Parameter Store** (§20.14). fakecloud v0.51.0 matches the documented `GetParameter` for what the keys need (decrypted `SecureString`, fields, `Version` counting up on overwrite, `ParameterNotFound`). It diverges where nothing relies on it: without `WithDecryption` it returns `kms:<key id>:<plaintext>` instead of ciphertext, and it checks no IAM or KMS permissions. Unverified until a deploy: that `ssm:GetParameter` alone reads a parameter under `aws/ssm`, and that a failed Lambda init is retried in a fresh environment.
- **Data lifecycle residue** (§20.15). Fixed since: deleting an alias leaves no contacts behind. Since the addendum: point-in-time recovery keeps 7 days, and an erasure journal names whose erasure to re-apply after a restore; sender-only reverse-alias tokens are gone. Still open, by decision: an alias created on the fly in the instant an account is erased can outlive the sweep if the index hasn't caught up by its second pass (it forwards nothing: the account has no recipients).
- **Web UI checks** (§20.16): the flows are now covered by browser tests (§20.17). Light mode exists only as tokens: the app always renders dark.
- **Browser coverage** (§20.17): Chromium only (no Firefox or WebKit/Safari), and a virtual authenticator, not Touch ID, Windows Hello, a security key or a phone. The web app is served by `vite preview` over `http://localhost`; the production HTTPS origin and its CDN routing (not in infra yet) aren't exercised.
- **Inbox storage** (§20.22.2): unverified until a deploy: the S3 lifecycle rules (only declared in infra; no emulator exercises expiry), the `aws:SecureTransport` deny, IAM for `s3:ListBucket` on the inbox bucket, and Lambda-side WebCrypto performance. Expired temporary inboxes are cleaned up when their owner next lists inboxes, not by a schedule; a never-listed expired inbox keeps its (sealed, TTL-expired) data out of reach but its alias item until an EventBridge sweep exists.
- **Webhooks** (§20.20): signing secrets are stored in the table as they are (an application-level encryption key would need Secrets Manager or KMS, so an emulator first); the per-user endpoint cap isn't atomic; the SQS → Lambda mapping is emulated from the docs, not recorded.
- **Device login** (§20.23): an approved grant carries the approver's user id for at most 10 minutes and isn't part of the erasure sweep; redeeming checks the user still exists, so the gap is a token item created in the instant between that check and an erasure (unusable: a token authenticates only while its user exists; TTL removes it after 90 days). The device-request limit keys on `sourceIp`, so it needs the same CloudFront switch as the token-failure limit.
- **SDK and CLI not released** (§20.23): `@alias/sdk` builds and packs, the CLI binaries are CI artifacts; publishing needs an npm account (scope `@alias` or another), a Homebrew tap repository with a token CI may push to, macOS code signing + notarization (an Apple Developer ID) so Gatekeeper runs the binary, and a decision on the SDK's license (AGPL-3.0 today, which binds every program that bundles it). The CLI's default API URL is a placeholder (`https://alias.example`) until the domain is chosen (§10). `alias temp` waits for the temp-mail API (§20.22).
- **OAuth authorization server and MCP endpoint** (§20.24): CloudFront (§15) must route `/mcp`, `/.well-known/*` and `/v1/*` to the API Lambda and serve `/oauth/authorize` from the app, with `frame-ancestors 'none'` on the app so the consent page can't be framed (clickjacking); `pnpm dev` and the tests reach the API directly. Client metadata documents are fetched on every authorization request (no HTTP caching yet, which the draft only recommends). The Lambda's outbound fetch through `Egress` is the webhooks' one, equally unverified on Lambda's network.
- **Client address behind CloudFront** (§20.20). The token-failure rate limit keys on the function URL's `sourceIp`, which becomes CloudFront's address once CloudFront fronts the API. Switch to `CloudFront-Viewer-Address` in the same change.
- **Tracker protection limits** (§20.19): remote stylesheets, fonts, VML and `<base href>` images aren't handled, and in `block-trackers` mode a visible open pixel from an unlisted host still loads. The image proxy's CloudFront/OAC wiring, caching and limits are typechecked only (§20.19, part 2).
- **OpenPGP** (§20.21): not checked in real mail clients (the format decrypts with OpenPGP.js and Sequoia and parses with Python's `email`); a key revoked after its upload is only noticed if the owner uploads the revocation (no keyserver or WKD lookups); the hidden subject is encrypted but not authenticated (no signature: RFC 9788 scopes header protection to signed mail); mail to a destination whose key expired is dropped as `key-unusable`, never sent in the clear (the destinations screen warns ahead). OpenPGP.js 6.x has no published audit yet.

- **Custom domains** (§20.18.1). fakecloud v0.51.0 verifies a domain identity the moment it is created, always reports DKIM `SUCCESS`, hands out the same tokens (`token1`…`token3`) for every domain, names no `SigningHostedZone`, and spells `MailFromDomainStatus` in SES v1's case (`Success`). So in tests and dev only the published DNS records (DoH emulator) decide; SES's `PENDING`/`FAILED`/`TEMPORARY_FAILURE` paths are tested on the documented responses through the pure `DomainVerification.decide`. Unverified until a sandbox account: the real `CreateEmailIdentity`/`GetEmailIdentity` responses (the fixtures follow the Response Syntax with plausible values), eu-west-1's `SigningHostedZone`, and whether an identity deleted and created again gets new Easy DKIM tokens (the ownership token makes us independent of it). The DoH JSON format has no RFC; the client and emulator follow Cloudflare's documented and recorded answers (Google's differ only in quoting TXT records, which the client reads both ways).

### 20.4 fakecloud replaces dynalite (2026-10-22)

Research on GitHub (2026-10-22) ruled out LocalStack (archived March 2026, community edition behind an auth token) and MinIO (archived April 2026). Floci (MIT, ~27k stars) needs Docker on macOS and doesn't emulate SES receiving; Ministack (Python) doesn't either. **fakecloud** (Rust, one ~19 MB binary, AGPL dev dependency, v0.51.0 pinned and checksummed in `mise.lock`) speaks S3 and DynamoDB (transactions, TTL) without Docker, starts in ~200 ms and binds port 0.

| Concern       | Choice                           | Why                                                                                                                                                                                                                                                                                                                                         |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3 (spool)    | fakecloud                        | Real S3 API. The SES emulator writes, and `Inbound.readMessage` (production code) reads, through `@distilled.cloud/aws`                                                                                                                                                                                                                     |
| DynamoDB      | fakecloud **and** DynamoDB Local | fakecloud has transactions and TTL (dynalite had neither). DynamoDB Local stays the AWS-made reference. dynalite is removed.                                                                                                                                                                                                                |
| SES receiving | our `tools/ses-emulator`         | fakecloud's receipt rules only match exact addresses or `@domain` (no `.domain` subdomains, labels, case folding or verified-domain check), and take subject/body instead of raw MIME. Its Lambda event lacks headers, timestamps and every verdict, so it doesn't decode with the AWS-documented schema (read in fakecloud v0.51.0 source) |
| Lambda        | our `tools/lambda-emulator`      | fakecloud runs Lambda only in Docker                                                                                                                                                                                                                                                                                                        |

The switch also surfaced a bug. `@distilled.cloud/aws` marks DynamoDB `ResourceInUseException` retryable, so `Table.ensure` hung on an existing table on every engine (second `pnpm dev`). `Retry.none` fixes it, and a regression test proves it.

### 20.5 SES sending: fakecloud, not our emulator (2026-10-22)

Phase 3 forwards mail through SESv2 `SendEmail` with `Content.Raw`. Before `Transport.ses` existed, we read the fakecloud v0.51.0 source (`crates/fakecloud-ses/src/service/sending.rs`) and probed it with `@distilled.cloud/aws`. **fakecloud is the emulator for SES sending.** `tools/ses-emulator` stays receive-only.

| Check                                                                                                                   | fakecloud v0.51.0                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request                                                                                                                 | `POST /v2/email/outbound-emails`, SigV4 required. Needs `Content` with `Raw.Data` as base64. `Destination` overrides the raw `To`/`Cc`/`Bcc`, as AWS documents.                                             |
| Response                                                                                                                | `{"MessageId": "<uuid>"}`. It decodes with the schema production uses.                                                                                                                                      |
| Unverified sender                                                                                                       | `MessageRejected` (400). The sender passes when its address or its domain is a verified identity.                                                                                                           |
| Sandbox recipient                                                                                                       | `MessageRejected` when `PutAccountDetails` turns production access off. The default is production access **on**, while new AWS accounts start in the sandbox.                                               |
| Suppressed recipient                                                                                                    | `MessageRejected`, with the `SuppressedReasons` filter applied. **Diverges from AWS**, which documents accepting the message, not sending it, and publishing a bounce (`OnAccountSuppressionList`) (§20.11) |
| Sending paused                                                                                                          | `SendingPausedException` (account or configuration set)                                                                                                                                                     |
| Inspection                                                                                                              | `GET /_fakecloud/ses/emails` lists each sent message with its envelope (`from`, `to`, `cc`, `bcc`) and the raw MIME, byte for byte                                                                          |
| 40 MB size limit, 50 recipients                                                                                         | **Not enforced.** AWS documents both limits but not which error each one raises                                                                                                                             |
| `AccountSuspendedException`, `MailFromDomainNotVerifiedException`, `TooManyRequestsException`, `LimitExceededException` | **Never raised**                                                                                                                                                                                            |

**Why not extend `tools/ses-emulator`?** fakecloud already gets the documented paths right, and its inspection endpoint shows the exact bytes. The paths it misses have no documented error code, so our own emulator would have to guess those codes. A guessed error would look verified without being verified. We take documented behaviour from fakecloud and leave the rest as an open gap until recorded payloads exist (§20.3).

**How it is verified.** The documented `SendEmail` request and response live in `packages/aws/fixtures` (`sesv2-*`). The response fixture and fakecloud's responses decode with the same `Transport` schema. `Transport.send` sends the documented raw message on fakecloud, and the inspection endpoint shows the documented envelope and exactly the same bytes. Each error fakecloud can produce is tested through `Transport`. A dead endpoint covers network failure.

**Error policy.** `Transport.send` fails with one of two errors. The pipeline drops on `TransportRejected` (`MessageRejected`, `BadRequestException`), because only the message's own content is at fault. Every other failure (account paused or suspended, MAIL FROM, quotas, throttling, network, unknown) becomes `TransportRetryable`. The mail stays queued, and alerting watches for it.

**Subdomains (found 2026-10-22).** AWS lets a verified domain identity cover all of its subdomains: "if you create and verify an identity for example.com, you don't need to create separate identities for a.example.com" ([SES DG, creating identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)). fakecloud v0.51.0 rejects `shop+r.x@user1.alias.test` with `MessageRejected` when only `alias.test` is verified. Production needs one identity per shared domain; tests verify each user subdomain explicitly, and say so where they do it.

**Dev.** `pnpm dev` verifies the dev domains as SES identities on fakecloud, and (dev-only hook in `apps/api/bin/dev.ts`) each new user's subdomains when they sign up. Sent mail is listed at `http://localhost:$ALIAS_FAKECLOUD_PORT/_fakecloud/ses/emails`.

### 20.6 Inbound Lambda (2026-10-22)

Mail to an alias now reaches the owner's verified mailbox, and the owner's reply leaves as the alias.

**Layout.** `apps/inbound` is a second Lambda app next to `apps/api`, with the same shape: `src/handler.ts` is the entrypoint Alchemy bundles, `src/config.ts` reads the Lambda environment, and `bin/dev.ts` runs it for `pnpm dev`. A separate app, not a route in the API, because SES invokes it with its own event type, IAM role (S3 spool, SES sending), timeout and concurrency, and it never serves HTTP.

**Pipeline** (`src/Pipeline.ts`, decisions in `src/Route.ts` and `src/Policy.ts`):

1. **Parse.** `SesEvent.decode` at the entrypoint. One outcome per recipient in `receipt.recipients`.
2. **Resolve.** `Address.parse` + `classify` against `SharedDomains`; `+r.<token>` goes down the reply path. Unknown recipients, custom domains that aren't verified (§20.18.2), inactive aliases and owners without a verified default recipient are dropped silently: no bounce, one log line with the reason and the SES message ID, never an address or content.
3. **Policy.** Virus `FAIL` and spam `FAIL` are dropped and counted as `blocked` on the alias. `Policy.spamAction(alias)` is the seam for a per-user quarantine setting.
4. **Forward.** `ReverseToken.mint` for the contact of the `From` sender (else the envelope sender; contacts since §20.9), `Mail.forward`, then `Transport.send` from the reverse alias to the owner's default recipient. Counts `forwarded`.
5. **Reply.** `ReverseToken.verify`, then the sender must be one of the alias owner's verified recipients **and** SES must report DKIM and DMARC `PASS`. `Mail.reply` sets `From` to the alias, `To` to the contact and a fresh `Message-ID` on the alias domain (the original's domain named the owner's mail provider), and strips client and network headers. Anything else is dropped silently.
6. **Cleanup.** The spool object is deleted once every recipient is done (`Inbound.deleteMessage`). Nothing else about the message is stored.

**Idempotency.** Before any side effect (send or blocked count), the pipeline claims `DELIVERY#<sesMessageId>` / `RECIPIENT#<address>` with a conditional `PutItem` (`DeliveryRepo`, TTL one week, in `Table.spec`, tested on fakecloud and DynamoDB Local). A redelivered or concurrent event finds the claim and sends nothing. When SES can't take a message now (`TransportRetryable`) or the spool can't be read, the claim is released, the record fails with `InboundDeferred`, the spool object stays, and Lambda's retry sends only what is still missing. `TransportRejected` drops (§20.5's error policy). The trade-off: a Lambda that dies between the claim and the send (a timeout, say) loses that one copy, because the claim stays. Delivery is at most once per recipient, by choice: a duplicate forward is visible to the user, a lost one only in the logs. A two-phase claim (`sending` → `sent`, reclaimable after a timeout) would close it if it ever shows up.

**Keys.** `<version>:<base64url secret>` entries, the first one minting (`ReverseKeys.parse`, ≥ 32-byte secrets, errors never echo a secret), stored as an SSM Parameter Store `SecureString` that `ALIAS_REVERSE_TOKEN_KEYS_PARAMETER` names and the Lambda reads once per container (§20.14). Dev puts a fixed, public dev key into fakecloud's SSM; tests use their own.

**Config.** `ALIAS_SHARED_DOMAINS` has one parser and one service, `SharedDomains` in `@alias/core`, used by the API (aliases, recipient checks, the confirmation sender) and the inbound Lambda. `Dynamo.config` and `Transport.config` read the shared table and SES settings for both Lambdas.

**Dev.** `apps/inbound/bin/dev.ts` replaces `tools/ses-emulator/bin/serve.ts`: it runs the SES emulator's SMTP listener and hands every Lambda event to the real pipeline. The API seeds the demo alias `shop@alias.test` with the verified recipient `demo@mailbox.test`.

**Tests.** Unit (`apps/inbound/test/decisions.test.ts`: routing, verdicts, reply authentication, keys, on the AWS-documented event), handler on fakecloud (`pipeline.test.ts`: drops, blocks, redelivery after a clean run and after a crash, concurrent redelivery, paused sending and retry, SES rejection), repository (`DeliveryRepo` on both engines) and stack (`e2e`: SMTP → forward with rewritten `From`/`Reply-To` → reply round trip with a header diff → spoofed replies dropped → redelivery sends nothing).

### 20.7 Forwarding safety (2026-10-22)

Guards that keep the pipeline from feeding loops, relaying machines' mail to contacts, or flooding a mailbox, all decided from data the pipeline already has, with no new AWS service.

**Where each check runs.** `Pipeline.plan` still decides from the SES event and the table alone. After the delivery claim, `Pipeline.send` runs, in order:

1. **Size.** `Inbound.messageSize` asks S3 `HeadObject` for `Content-Length` (the SES event carries no size). Mail over `Limits.maxMessageBytes` (25 MiB) is dropped as `too-large` and counted as blocked, before the body is read. fakecloud answers `HeadObject` with the stored size and a missing key with a bare 404 (`NotFound`), as the S3 API reference documents; `tools/aws-emulators/test/emulators.test.ts` checks both through the production helper.
2. **Header signals.** `Mail.signals` (core, pure) reads the raw header block: our `X-Alias-Forwarded` markers, the `Received` count, RFC 3834 `Auto-Submitted` other than `no` or `Precedence: bulk|junk|list` (`isAutomated`), and RFC 6522 `multipart/report` (`isReport`). It reads the spooled message, not the event's `headers`, because SES truncates those above 10 KB (`headersTruncated`), and a loop's marker sits under its newest `Received` fields.
3. **Forward path** (`Policy.forwardLoop`), each dropped as `loop` and counted as blocked:
   - the message carries this alias's marker. `Mail.forward` adds `X-Alias-Forwarded: <alias>` and keeps other aliases' markers, so a loop through several aliases is caught when it gets back to one of them, while a one-way chain (alias → mailbox → someone else's alias) still forwards;
   - more than 50 `Received` fields (`Policy.MAX_HOPS`, Postfix's `hopcount_limit`; RFC 5321 §6.3 recommends counting);
   - automated mail whose `From` or envelope sender is one of the owner's own recipients: the owner's mailbox auto-forwarding or auto-replying into the alias.

   `Auto-Submitted` and `Precedence` do nothing else here: newsletters and notifications forward.

4. **Hourly cap.** `AliasRepo.reserveForward` adds one to the alias's `FORWARDS#<hour>` counter (`Table.spec`, TTL an hour after the hour, one conditional `UpdateItem`, tested on both engines including concurrent callers). Past `Limits.forwardsPerHour` (100) the mail is dropped as `rate-limited` and counted as blocked. A retry after a temporary SES failure counts again; the cap is a safety net, not billing. `RecipientRepo.reserveMail` now uses the same `Quota` helper.
5. **Reply path** (`Policy.automatedReply`), before the reply's authentication (§20.6), dropped without counting: a null envelope sender on a report, an automated message or mail from `MAILER-DAEMON`/`postmaster` is a `bounce`; any other automated message or report is an `auto-reply` (an out-of-office or read receipt from the owner's mailbox must not reach the contact). `Mail.reply` strips `X-Alias-Forwarded`, which names the alias.

A database failure while reserving the quota releases the claim and defers the record, like a temporary SES failure.

**Infra.** The inbound Lambda may now `s3:ListBucket` the spool. Without it, S3 answers a missing key with 403 instead of 404, so a message processed earlier looked like a spool failure and was retried instead of dropped as gone.

**Tests.** Core (`Mail.signals`, the marker on forward and its removal on reply), unit (`forwardLoop`, `automatedReply` on the AWS-documented event), repository (`reserveForward` on fakecloud and DynamoDB Local), contract (`HeadObject` on fakecloud), handler (`pipeline.test.ts`: newsletters forward, a copy that comes back is a loop, 50 vs 51 hops, the cap, oversized mail, an out-of-office and a bounce to a reverse alias) and stack (`e2e`: a bulk newsletter forwards, the mailbox's redirect of it back to the alias is dropped as `loop`, and the mailbox's out-of-office to the reverse alias is dropped as `auto-reply`).

### 20.8 On-the-fly aliases on the user's subdomain (2026-10-22)

Phase 3's last item. Mail to an unknown address on `<username>.<shared domain>` creates that alias and is forwarded, if the subdomain's owner opted in. Off by default (PLAN §19.2: catch-all is opt-in).

**Setting.** `UserRepo.settings`/`updateSettings` on a `USER#<userId>` / `SETTINGS` item (`Table.spec`; no item means the defaults). The API serves it as `GET`/`PATCH /v1/settings` (`SettingsGroup` in `@alias/contracts`, `{ isOnTheFlyEnabled }`, signed in only).

**Inbound** (`Pipeline.createOnTheFly`). `route` now names the subdomain's owner (`Forward.username`). When `findByAddress` finds nothing on a user subdomain:

1. `UserRepo.findByUsername` reads the Username item and requires the stored username to match exactly; a lookalike that only shares the confusable skeleton finds no one.
2. The owner's settings must have `isOnTheFlyEnabled`; otherwise `unknown-alias`, as before.
3. Spam and virus `FAIL` never create an alias (dropped as `spam`/`virus`, nothing to count it on). Reverse-alias shapes take the reply path and never create one.
4. `AliasRepo.reserveCreation` counts one creation against `Limits.aliasesCreatedPerDay` (20) on a `USER#<userId>` / `ALIASES#<date>` quota item with TTL (the same `Quota` helper as §20.7). Past it: `creation-limited`. Existing aliases keep working.
5. `AliasRepo.insert` stores a forward-mode alias; `AliasTaken` from a concurrent message to the same address is fine, and both use the stored alias.

Creation happens in the planning step, before the delivery claim. That's safe because it is idempotent: a redelivered event finds the alias and spends no quota. The inbound role already had every DynamoDB action this needs.

**Dev.** fakecloud refuses senders on a subdomain of a verified domain (§20.5), so forwarding from `shop+r.…@ada.alias.test` would fail in dev. `apps/api/bin/dev.ts` wraps the real handler: after a successful `POST /v1/auth/register` it verifies `<username>.<shared domain>` for each shared domain on fakecloud. It's dev-only (in `bin/`, never in the Lambda), logged, and documented in the `alias-dev-stack` skill. The gap stays open in §20.3. Smoke-tested on `pnpm dev`: sign-up → subdomain verified → `PATCH /v1/settings` → SMTP to `club@<user>.alias.test` → `inbound alias created on the fly` → forwarded from `club+r.…@<user>.alias.test`.

**Tests.** Repository on both engines (exact-username lookup vs a skeleton lookalike, settings defaults and changes, the daily creation quota under concurrency), API handler (toggle, per-user isolation, validation, 401s), unit (`route` names the owner only for subdomains), handler on fakecloud (creation and reuse, opted out / unknown user / shared domain, spam/virus/reverse alias, the daily cap, two concurrent first messages create one alias) and stack (`e2e`: dropped before opting in, forwarded and listed in `/v1/aliases` after, another user's subdomain untouched).

### 20.9 Contacts (2026-10-22)

A contact is someone who wrote to an alias. Contacts make reverse aliases revocable (§3.1: "revocable via the contact row") and let long sender addresses reply.

**Data** (`ContactRepo`, in `Table.spec`, suite on fakecloud and DynamoDB Local). Each contact is stored under `CONTACTS#<aliasId>` / `CONTACT#<lowercased address>`, with a random 16-character id (`ReverseToken.newContactId`), the address as first seen, the first display name, `createdAt` and `isBlocked`. A `CONTACT-ID#<id>` item points from the id to the address. Both items are written and deleted in one transaction. Partitions are keyed by the alias **id**, so an alias recreated at the same address starts with no contacts. A forward looks up the contact with one GetItem by address, a reply with two GetItems by id, and listing an alias's contacts is one Query.

**Forward path.** The pipeline gets the contact for the `From` sender, or creates it on the first message (a concurrent first message creates it only once). If the contact is blocked, the mail is dropped as `blocked-contact` and counted as blocked. Otherwise the token carries **only the contact id**. Reverse aliases now have a fixed length (45-character token since §20.15's addendum, 47 before): long senders fit RFC 5321's 64-octet local part, and only addresses over 254 octets (`Policy.isStorableAddress`, more than any real address) are dropped as `unencodable-sender`.

**Reply path** (`Pipeline.replyTarget`). A contact-id token must name an existing contact on that alias that isn't blocked; otherwise the reply is dropped as `unknown-contact` or `blocked-contact`, and it goes to the contact's stored address. (Sender-only tokens minted before contacts kept verifying until §20.15's addendum removed them; they were never deployed.) Deleting a contact revokes its reverse alias for good: if the sender writes again, they get a new id.

**API** (`ContactsGroup`, signed in, the caller's own aliases only; other users' aliases answer `AliasNotFound`): `GET /v1/aliases/:domain/:local/contacts`, `PATCH …/contacts/:contactId { isBlocked }`, `DELETE …/contacts/:contactId`. The alias ownership check (`ownedAlias`) is now shared with alias lookup.

**IAM.** Creating a contact is the inbound Lambda's first `TransactWriteItems`. IAM authorizes it per item through `PutItem`, which the role already had.

**Tests.** Core (`newContactId` format, contact-only token round trip and length), repository (case-insensitive lookup, per-alias isolation, one contact under 4 concurrent creates, order, block/unblock, delete revokes the id even after the sender writes again), unit (`isStorableAddress`), API handler (list with optional name, block/unblock/delete, 404s for others' aliases and other aliases' contacts, 400, 401), pipeline on fakecloud (one contact per sender in any letter case with a stable reverse alias, blocked both ways and unblocked again, deleted contact stays revoked, a 200-character sender replied to) and stack (`e2e`: blocking a sender via the API drops its next mail; a reply to a contact deleted via the API is dropped).

### 20.10 Reply hygiene: quoted text and attribution lines (2026-10-22)

Mail clients quote the thread, and with it the owner's identity: `On Mon, Ada Lovelace <ada@mailbox.example> wrote:`, Outlook's `From:/To:` block, an old signature. `Mail.reply` now takes the owner (`Mail.Owner`: every verified recipient address, plus the display name from the reply's `From`) and removes them before the reply goes out.

**What changes** (`internal/scrub.ts`):

- Each owner address becomes the alias address, anywhere in the text, case-insensitively, but never inside a longer address (`xada@…`, `…example.org`).
- The owner's name becomes the alias address in quoted text and attribution lines only. In plain text that means `>` lines, everything after an Outlook-style rule (`-----Original Message-----`, `____…`), and the one or two lines before a quote block that end in a colon (`wrote:`, `schrieb:`, `a écrit :`). In HTML it means everything from the first quote marker of the major clients onward (`<blockquote`, `gmail_quote`/`gmail_attr`, `moz-cite-prefix`, `divRplyFwdMsg`, `appendonsend`). A name the owner typed themselves, such as their signature, stays. Names need two letters and match only as whole words.

**What doesn't** (`internal/mime.ts`): a MIME walk visits only inline `text/plain` and `text/html` leaves. Headers, preambles, boundaries, epilogues, attachments, attached messages and text parts without owner data are copied **byte for byte**. A part that changes is decoded (7bit/8bit/binary, quoted-printable, base64), rewritten on bytes (one char per byte, so any ASCII-compatible charset works and nothing is transcoded) and re-encoded with its own transfer encoding and line endings, so its headers stay true. UTF-16/32 parts and unknown transfer encodings pass unchanged.

**Golden corpus** (`packages/core/test/corpus`, §19.2 point 11): Gmail (plain + QP HTML, nested quotes, wrapped attribution), Apple Mail (QP, attribution inside the blockquote), Thunderbird (German, `format=flowed`, 8bit), Outlook (base64 plain + HTML, `From:/Sent:/To:` block), ISO-8859-1 QP with a non-ASCII owner name, multipart/mixed with a PDF and an attached text file, and a reply with nothing to scrub. Each must match its reviewed `.expected.eml` byte for byte, relaying the output again must change nothing, and an independent test-side MIME decoder must find no owner address in any inline text part. The expected outputs were also read back with Python's `email` package.

**Tests besides the corpus.** Core (longer addresses and lookalike words untouched, an address split by a QP soft break found, UTF-16 and `x-uuencode` untouched), pipeline on fakecloud (all verified addresses and the name scrubbed, the owner's own signature kept) and stack (`e2e`: the reply round trip now quotes the thread; header diff as before, and the decoded body diff is exactly the two quoted lines that named the owner; the owner's address appears nowhere in the relayed message).

### 20.11 Bounces and complaints (2026-10-22)

A new AWS dependency (SES event publishing, SNS → Lambda), so the emulation was researched and verified first.

**Research** (fakecloud v0.51.0 source, `crates/fakecloud-ses/src/fanout.rs`, `crates/fakecloud-sns/src/service_publish.rs`, then probed with `@distilled.cloud/aws`):

| Piece                                            | fakecloud                                                                                                                                                          | Verdict                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| SESv2 configuration sets, SNS event destinations | ✅ Publishes `Bounce`/`Complaint` (and `Send`/`Delivery`) for the mailbox simulator addresses, with `mail.tags` holding the send's `EmailTags` and the `ses:` tags | used; events decode with `SendingEvent`                             |
| SNS topics, HTTP(S) subscriptions                | ✅ `SubscriptionConfirmation` POST with a working `SubscribeURL`, `Notification` POSTs in the documented JSON                                                      | used                                                                |
| SNS → Lambda                                     | Builds the documented Lambda event, but invokes Lambda only through Docker/Podman/Kubernetes                                                                       | **not usable**: own emulator                                        |
| Suppression list API                             | ✅ Put/Get/Delete, `NotFoundException` on a missing address                                                                                                        | used                                                                |
| Sending to a suppressed address                  | `MessageRejected`                                                                                                                                                  | diverges from AWS (accept, don't send, bounce event); not relied on |

**Emulator.** `tools/lambda-emulator` gains `SnsSubscriber`: it subscribes to a topic over HTTP (port 0), confirms the subscription by visiting `SubscribeURL` as AWS documents for HTTP endpoints, turns each notification into the documented SNS Lambda event (`toEvent`, written apart from the production schema) and queues it. It unsubscribes when its scope closes. Verified by contract tests: the AWS-documented HTTP notification maps to an event with exactly the documented Lambda event's fields, which the production `SnsEvent` schema decodes; on fakecloud a real subscription confirms and a published message arrives as a decodable event.

**Production code.**

- `packages/aws`: `SnsEvent` (Lambda's SNS event) and `SendingEvent` (SES event publishing: bounces and complaints read strictly, other types passed on as `Other`), both decoding AWS-documented fixtures. `SendingEvent.tags(userId, kind)` names each send's user and kind (`forward`, `reply`, `confirmation`) as SES message tags, and `origin(mail)` reads them back, so nothing per message is stored. `Transport.layer({ configurationSet })` names the set on every send and passes the tags; `Transport.suppress`/`unsuppress` wrap `PutSuppressedDestination`/`DeleteSuppressedDestination`. `ALIAS_SES_CONFIGURATION_SET` configures it in both Lambdas.
- `apps/inbound/src/Feedback.ts` + `feedbackHandler.ts` (a third Lambda, same app and config): a **permanent** bounce suppresses each address and marks the tagged user's recipient (`RecipientRepo.markBounced`); a complaint about forwarded mail is recorded (`markComplained`) and nothing is suppressed; transient bounces, other events and unreadable messages change nothing. Idempotent for SNS retries; database or SES failures fail the invocation so SNS retries.
- Pipeline: a default recipient with `bouncedAt` gets nothing forwarded (`recipient-bounced`), whatever SES would do with the address. That covers the fakecloud divergence above.
- API: `Recipient` shows `bouncedAt`/`complainedAt`. Sending a confirmation (add or resend) first takes the address off the suppression list, since the owner asked to try it again, and a resend clears `bouncedAt`.
- Infra (typecheck only): configuration set `alias-events-<stage>` with `suppressedReasons: ["BOUNCE"]`, an SNS topic, a BOUNCE+COMPLAINT event destination, the feedback Lambda (UpdateItem on the table, `ses:PutSuppressedDestination`), a `lambda:InvokeFunction` permission for SNS with the topic as `sourceArn`, the `lambda` subscription, the configuration-set ARN in both sending policies, `ses:DeleteSuppressedDestination` for the API, and email feedback forwarding off on the shared identities.

**Tests.** Contract (fixtures for the SNS Lambda event, the HTTP notification and confirmation, the bounce and complaint records), emulator (`SnsSubscriber` on the fixtures and on fakecloud), aws-emulators (suppress/unsuppress, sending through a configuration set with tags), repository (`markBounced`/`markComplained`, a resend clears the bounce, both engines), feedback handler on fakecloud through the real chain (simulator → SNS → subscriber: fakecloud's events decode and carry the tags; a hard bounce marks and suppresses, twice idempotently; a complaint is recorded but not suppressed; a reply complaint is ignored) and on the documented payloads (untagged bounce suppresses; transient, other and unreadable are ignored), pipeline (`recipient-bounced`), API (re-adding a suppressed address unsuppresses it) and stack (`e2e`: a forwarding address that bounces its confirmation is marked in `GET /v1/recipients`, suppressed, and later mail to the alias is dropped as `recipient-bounced`).

### 20.12 Web UI for phases 3 and 4 (2026-10-22)

The React app now shows what the last steps built, through `@alias/contracts` only:

- **Alias counters.** `AliasView` gained `forwardedCount` and `blockedCount` (API handler test included), shown under each alias.
- **Contacts.** "Contacts" on an alias opens its list (`?contacts=<address>` in the URL, so the panel survives a reload and can be linked; the Effect lint forbids `useState`). Each contact shows its name and address, when it first wrote and whether it's blocked, with Block/Unblock and Remove (`GET/PATCH/DELETE …/contacts`).
- **On-the-fly toggle.** A checkbox in the aliases card reads and writes `/v1/settings`, naming the user's subdomain.
- **Recipient bounce status.** The forwarding page marks a bounced address ("nothing is forwarded here", with how to retry) and a recorded complaint.

Verified by `pnpm check` (lint, types, knip) and `vite build`, and against live data on `pnpm dev` through the API (counters 3/1 after a blocked sender, contacts, `bouncedAt`). Not looked at in a browser: the preview browser can't sign in (no passkey authenticator, and it refuses the `Secure` session cookie over plain http). A Playwright run with a virtual WebAuthn authenticator would close that gap (done: §20.17).

### 20.13 SES reputation alarms (2026-10-22)

The last open item of phase 4. Infra only (`infra/alchemy.run.ts`, typecheck only); no runtime code changes, no emulator: nothing in the repo reads CloudWatch or the alert topic, so the rule "a new AWS dependency needs an emulator" doesn't apply until code does.

**Where SES acts** (SES sending review FAQ, read 2026-10-22): an account is placed under review at a bounce rate of **5%** or more and may have sending paused at **10%**; complaints: review at **0.1%**, pause at **0.5%**. AWS recommends staying below 2% bounces and 0.1% complaints. The bounce rate counts only hard bounces to unverified domains; both rates are computed over a "representative volume", not a fixed window, so they can't be recomputed from our own events. SES publishes them to CloudWatch as `Reputation.BounceRate` and `Reputation.ComplaintRate` in `AWS/SES` (fractions: `0.05` = 5%), free of charge.

**Alarms.** Four account-level alarms, `alias-<stage>-ses-{bounce,complaint}-{warning,critical}`:

| Metric                     | Warning (½ of review) | Critical (80% of review) | SES review / pause |
| -------------------------- | --------------------- | ------------------------ | ------------------ |
| `Reputation.BounceRate`    | ≥ 2.5% (`0.025`)      | ≥ 4% (`0.04`)            | 5% / 10%           |
| `Reputation.ComplaintRate` | ≥ 0.05% (`0.0005`)    | ≥ 0.08% (`0.0008`)       | 0.1% / 0.5%        |

Why these numbers: the warning leaves room to act before a review; the critical one still fires before SES does, and two levels let a slow drift be told apart from an incident. Lower warnings (AWS's 2% "best results") would fire on noise at low volume, where the representative volume is small and one bounce moves the rate a lot. Settings: `Maximum` over 1 hour, 1 evaluation period (the metric is already SES's running rate, so one datapoint is the current state), `GreaterThanOrEqualToThreshold`, and missing data `ignore` (no sends, no datapoint, keep the last state), as the SES alarm guide recommends. Both `ALARM` and `OK` notify, so the all-clear arrives too.

**Notification.** An SNS topic `alias-alerts-<stage>` whose policy lets only `cloudwatch.amazonaws.com` publish, for alarms named `alias-<stage>-ses-*` in this account (`aws:SourceArn` + `aws:SourceAccount`, the confused-deputy policy from the CloudWatch docs). `ALIAS_ALERT_EMAIL` (optional) adds an `email` subscription; SNS mails a confirmation link and delivers nothing until it's followed. Unset, there's no subscription: the alarms still change state and keep history in CloudWatch, and a subscriber can be added later.

**Not added.** Per-configuration-set reputation metrics (`ReputationMetricsEnabled`, dimension `ses:configuration-set`): every send goes through the one set `alias-events-<stage>` (§20.11), so they would repeat the account metrics at extra alarm cost. They become useful if forwards and confirmations ever get separate sets. Auto-pausing (SES's Lambda recipe that disables sending) is left out on purpose: pausing all forwarding for everyone is worse than one user's bad recipient. SES also emits no event when it pauses an account; `GetAccount`'s `EnforcementStatus` is the programmatic check.

**Cost.** Four standard-resolution alarms at $0.10/alarm/month = $0.40/month, or $0 inside CloudWatch's 10 free alarms; SNS email is free for the first 1,000 notifications a month. Keep the count small (§14.1): no per-user, per-domain or high-resolution alarms.

**Runbook (an alarm fired).**

1. Check the SES console's reputation page or `GetAccount` (`EnforcementStatus`): healthy, under review, or paused.
2. Find the source. The feedback Lambda (§20.11) is the record: it reads the SES message tags `alias-user` (user id) and `alias-kind` (`forward`, `reply`, `confirmation`) that every send carries and marks the user's recipient item (`pk = USER#<id>`, `sk = RECIPIENT#<address>`) with `bouncedAt` or `complainedAt`; the owner also sees them in `GET /v1/recipients`. A scan of the table for items that have either attribute, sorted by time, names the users and addresses behind the spike. Its logs only carry counts and the SNS message id, not the user. A cluster on one user is the usual answer: bounces usually mean someone added bad forwarding addresses (the confirmation bounces); complaints mean a user's own mailbox reports forwarded mail as spam. Bounces on replies (`alias-kind = reply`) are suppressed but not marked, since there's no recipient of ours; if the bounce rate climbs with no new marks, look there: the suppression list (`ListSuppressedDestinations`, with `LastUpdateTime`) holds every hard-bounced address, replies included.
3. Stop it. Hard-bounced addresses are already on the suppression list and get nothing forwarded (`recipient-bounced`). For complaints, or a user whose traffic is the problem, pause that user's forwarding: set `isActive = false` on their aliases or delete the complaining recipient. There's no admin switch yet, so today that's a manual DynamoDB edit.
4. If SES opened a review case, reply in Support Center with the cause and the fix, as the FAQ asks.

**Needs a real account (not done).** Whether `AWS/SES` reputation metrics appear before the first send (the docs suggest sending to the mailbox simulator once), the exact publishing cadence, and a test of the topic policy with `aws cloudwatch set-alarm-state` after the first deploy.

### 20.14 Reverse-token keys from SSM Parameter Store (2026-10-22)

Until now the reverse-token keys were the Lambda environment variable `ALIAS_REVERSE_TOKEN_KEYS`, so the secret also sat in the Alchemy state and showed in the Lambda console. §14.1 chose SSM Parameter Store (standard tier, free) over Secrets Manager ($0.40/secret/month). A new AWS dependency, so the emulator was checked first.

**Research** (API reference `GetParameter`; KMS encryption for Parameter Store in the SSM user guide; fakecloud v0.51.0 `crates/fakecloud-ssm/src/service/parameters.rs`, then probed with `@distilled.cloud/aws`):

| Check                                   | AWS docs                                                                                                                                                       | fakecloud v0.51.0                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `GetParameter` + `WithDecryption: true` | `Parameter` with `ARN`, `DataType`, `LastModifiedDate`, `Name`, `Type`, `Value`, `Version`                                                                     | ✅ the same fields, `Value` decrypted                           |
| `Version`                               | counts up on every overwrite                                                                                                                                   | ✅ 1, then 2 after `PutParameter --overwrite`                   |
| Missing name                            | `ParameterNotFound` (400)                                                                                                                                      | ✅ `ParameterNotFound` (400)                                    |
| ARN of `/alias/<stage>/…`               | `arn:aws:ssm:<region>:<account>:parameter/alias/<stage>/…` (no doubled slash)                                                                                  | ✅ the same                                                     |
| `SecureString` without `WithDecryption` | ciphertext                                                                                                                                                     | `kms:<key id>:<plaintext>`. **Diverges**; never used            |
| IAM, KMS key permissions                | `ssm:GetParameter`; `kms:Decrypt` by the key's policy (the AWS managed `aws/ssm` key allows the account's principals through SSM and takes no access policies) | **Not checked**; unverifiable here, confirm on the first deploy |

**Production code.**

- `packages/aws`: `Parameters.secureString(name)` calls `GetParameter` with `WithDecryption`, decodes the response with `Parameters.GetParameterResult` (which also decodes the documented sample, `fixtures/ssm-get-parameter-response.json`) and returns `{ value: Redacted, version }`. It fails with `MissingParameter` or `ParameterUnavailable`; a `String`/`StringList` parameter is refused, so a secret stored in plain text by mistake fails loudly. No error carries the value: decode failures get a fixed reason.
- `apps/inbound`: `ReverseKeys.fromParameter(name)` reads and parses the keys, and logs the parameter version and the minting key's version. `ReverseKeys.config` reads `ALIAS_REVERSE_TOKEN_KEYS_PARAMETER` (and `AWS_ENDPOINT_URL_SSM` in emulated runs). A bad value fails with `InvalidReverseKeys`, naming the parameter, its version and the entry, never a secret. The env-var path is gone, in dev too.
- **Cold start.** `handler.ts` builds its `ManagedRuntime` with `await runtime.context()` at module top level, so the keys are read in Lambda's init phase and cached for the life of the container. Top-level await matters: a `ManagedRuntime` caches a failed build for good, so a transient SSM error inside a handler call would poison the warm container; failing the init instead makes Lambda start a fresh one for the next event (and SES's async invoke retries the event).

**Rotation.** Put a new value with `--overwrite`. New containers pick it up; warm ones keep the set they loaded until Lambda recycles them, so containers on the old and the new set answer side by side for a while. Hence two puts: first append the new key (`1:<old>,2:<new>`: it verifies but doesn't mint), then, once every container has that set (hours, or at once after any function configuration update, which starts new environments), move it first (`2:<new>,1:<old>`). Each step's containers then verify what the other's mint; a test proves it. Keep the old key as long as replies to older mail should work. A leaked key is removed the same way, followed by a configuration update so no warm container keeps accepting it.

**Infra.** The stack names the parameter `/alias/<stage>/reverse-token-keys` and passes only the name; it never creates the value (that would put it in the state again). The inbound role gets `ssm:GetParameter` on exactly that ARN and no `kms:Decrypt` (default `aws/ssm` key, above; a customer managed key would need one, conditioned on `kms:EncryptionContext:PARAMETER_ARN`). The plan no longer throws without `ALIAS_REVERSE_TOKEN_KEYS`. Once per stage, before its first deploy:

```sh
aws ssm put-parameter --region eu-west-1 --type SecureString \
  --name /alias/<stage>/reverse-token-keys \
  --value "1:$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
```

**Dev.** `apps/inbound/bin/dev.ts` puts the fixed dev key into fakecloud as `/alias/dev/reverse-token-keys` unless it exists, then reads it back through `ReverseKeys.fromParameter`, like the Lambda.

**Tests.** Contract (`packages/aws`: the documented response decodes, a redacted value is accepted, a `String` is refused), emulator (`tools/aws-emulators/test/ssm.test.ts`: fakecloud's fields match the documented response, the ARN form, versions count up, `ParameterNotFound`, a `String` parameter refused without its value in the error), handler tier on fakecloud (`apps/inbound/test/reverseKeys.test.ts`: the parameter named by the env-style config is read through the endpoint override; containers on either step of a rotation verify each other's tokens; missing, malformed and plain-text parameters fail without echoing a secret) and stack (`e2e` reads its keys from fakecloud's SSM).

**Not verified** (needs an AWS account): a recorded `GetParameter` response, the IAM/KMS behaviour above, and init-failure retries on Lambda.

### 20.15 Data lifecycle: deactivate, delete, erase (2026-10-22)

Three actions, from everyday to final. Contacts are other people's personal data, so anything stronger than deactivating minimizes (GDPR Art. 5(1)(c) and (e)), and leaves only what keeps addresses from being taken over.

| Action                                                                   | Effect                                                                                                                | Reversible                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Deactivate** (`PATCH /v1/aliases/:domain/:local { isActive }`)         | Mail is dropped as `inactive-alias` and counted as blocked. Everything is kept.                                       | Yes. The everyday action; the web UI's Delete asks first and points to Deactivate |
| **Delete an alias** (`DELETE /v1/aliases/:domain/:local`)                | The alias item becomes a tombstone; its contacts (both items each), counters and hourly `FORWARDS#` items are purged. | No. Its owner may create the address again, as a new alias                        |
| **Erase the account** (`POST /v1/me/erase/options`, `POST /v1/me/erase`) | Everything about the user is deleted, except tombstones for the username and for shared-domain addresses.             | No                                                                                |

**Tombstones** (`Table.ts`). An address that once received someone's mail is on file at third parties (account recovery, password resets). Whoever claims it next receives that mail, so a deleted address is never given to anyone else, as addy.io does. The alias item is replaced by `{ deletedAt, userId }`, listed on gsi1 under `DELETED-ALIASES#<userId>`. It isn't restorable (the contacts are gone), but its owner may create the address again, on a shared domain or their subdomain: that is a new alias with a new id, zero counters and no contacts, so the old contact-id reverse aliases stay dead. Mail to a tombstone is dropped as `unknown-alias`, exactly like mail to an unknown address. On-the-fly creation (§20.8) checks `AliasRepo.isDeleted` first, so a deleted alias never comes back by mail and spends no daily quota. Updates, counters and a second delete see no alias.

**Delete, resumably.** `AliasRepo.delete` runs three idempotent steps: one conditional `UpdateItem` turns the owner's alias into its tombstone but keeps the alias `id`; the purge deletes the `CONTACTS#<id>` partition and the `FORWARDS#` items (strongly consistent Queries, then `DeleteItem`s); a last `UpdateItem` removes the `id`. A retry finds the pending `id` and finishes; until then not even the owner can recreate the address (409), and a stranger's delete answers 404. TTL items aren't left to expire: AWS deletes expired items only within days, and ForwardQuotas name the address.

**Contacts can't outlive their alias.** `ContactRepo.create` adds a `ConditionCheck` on the alias item (`id = :aliasId AND attribute_not_exists(deletedAt)`) to its transaction. Mail being processed while its alias is deleted fails the check and is dropped as `unknown-alias`, instead of writing a contact after the purge has run. The inbound role gains `dynamodb:ConditionCheckItem`.

**Erase the account** (GDPR Art. 17).

- _Confirmation._ A fresh passkey assertion, as for login, on an `Erasure` challenge bound to the signed-in user. A login challenge, another user's erasure challenge or another user's passkey is refused (`PasskeyRejected`). A stolen session cookie therefore can't erase an account. A confirmation field alone would have been weaker, and this fits the passkey-first design.
- _SES._ The user's recipient addresses come off the account-level suppression list first (`Transport.unsuppress`; personal data too). That's harmless for anyone else forwarding to the same address: the pipeline refuses recipients marked `bouncedAt` itself (§20.11), and adding a recipient unsuppresses it anyway.
- _Sweep_ (`AccountRepo.erase`). DynamoDB transactions take 100 items, so it's a resumable sweep of idempotent steps: (1) every other session (gsi1 `SESSIONS#<userId>`), so no other device acts meanwhile; (2) the Username item becomes a tombstone (`deletedAt`, no owner): no more on-the-fly aliases, and `isUsernameTaken` stays true for the name and its lookalikes; (3) every alias is deleted as above, and with the tombstones of earlier deletions (pending purges finished) it then loses `userId` and its index keys on a shared domain or goes entirely on the user's subdomain, which the username's tombstone already covers; (4) the rest of the `USER#<userId>` partition (recipients, settings, quotas); (5) one transaction deletes the User item, the passkeys (gsi1 `PASSKEYS#<userId>`) and the asking session. Until (5) the account can still sign in and retry; after it nothing is left to retry. (6) A second alias pass catches an alias created on the fly an instant before (2) that the eventually consistent index showed late.
- _Sessions._ Authentication now also requires the User item (one more GetItem per request). A session that escapes the sweep, from a login racing the erasure or index lag, authenticates nothing and expires within its 30 days.
- _Lambda._ The API's timeout goes from Lambda's 3 s default to 30 s for large accounts.

**What is retained, and why.**

| Data                                                                | Where      | For how long                                                      | Why                                                                                                     |
| ------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Username tombstone (skeleton key, `deletedAt`)                      | DynamoDB   | Forever                                                           | Nobody registers the name, or a lookalike, and with it the subdomain whose addresses third parties know |
| Shared-domain alias tombstones (address, `deletedAt`)               | DynamoDB   | Forever                                                           | The same, for shared-domain addresses                                                                   |
| Delivery claims (SES message ID, alias address)                     | DynamoDB   | TTL one week, plus AWS's TTL lag                                  | Idempotency (§20.6); keyed by message, not findable per user                                            |
| Open registration challenges                                        | DynamoDB   | TTL 5 minutes                                                     | WebAuthn ceremony                                                                                       |
| Point-in-time recovery                                              | DynamoDB   | Rolling 7 days (addendum below)                                   | Backups (§15); open in §20.3                                                                            |
| Lambda logs (message IDs, drop reasons; never addresses or content) | CloudWatch | 14 days (`logging.retention` in infra; Lambda's default is never) | Operations                                                                                              |
| Webhook events still queued (metadata only, §20.20)                 | SQS        | Up to 4 days in the queue, 14 in its dead-letter queue            | Delivery retries. Never delivered after erasure: delivery re-reads the endpoint, which is gone          |
| Raw mail                                                            | S3 spool   | Deleted once processed; 1-day lifecycle rule as a backstop        | SES receiving (§3.2)                                                                                    |

**Tests.** Repository on fakecloud and DynamoDB Local: deletion purges contacts, pointers and counters and leaves exactly `{ pk, sk, deletedAt, userId, gsi1pk, gsi1sk }`; nobody else claims the address in any case, its owner does with a new id; updates and counters don't touch a tombstone; a deletion stopped after its first step blocks reclaiming until a retry finishes it; contacts are refused for a deleted alias and for the old id after recreation; erasure leaves exactly four bare tombstones for a user with one of everything (sessions, settings, recipient, quotas, live and deleted aliases on both kinds of domain, contacts, counters, a half-finished deletion), and another user untouched, in a full table scan; erased addresses stay taken, the erased user included; a half-done erasure finishes and a second run changes nothing. API handler: delete then recreate (new id, no contacts); erasure with a second device signed in (both sessions dead, passkey logs nobody in, username 409, address unsuppressed on fakecloud, other user fine); every wrong challenge or passkey refused, each challenge single use, 401 without a session. Pipeline: mail and replies to a deleted alias dropped; on the fly never recreates it nor spends the cap. Stack (`e2e`): delete over the API, then the table holds nothing naming the contact, mail and the old reverse alias are dropped, and recreating doesn't revive it; erase over the API with the authenticator, then 401, username 409, mail and replies dropped, and a table scan finds no item naming the user ID, the mailbox or the contact, only the username's tombstone and the one delivery claim.

**Not verified.** Nothing here needs AWS behaviour the emulators haven't shown: conditional updates, `ConditionCheck` in transactions, Queries with projections and GSIs agree on both engines. AWS's real index lag and TTL timing, and the IAM grants, are only typechecked until the first deploy.

**Addendum (2026-10-22): backups and reverse-alias tokens.**

- _Point-in-time recovery: 7 days._ `infra/alchemy.run.ts` sets `recoveryPeriod` (Alchemy sends it as `RecoveryPeriodInDays`) instead of DynamoDB's 35-day default, so an erased account is restorable from backups for a week at most.
- _Erasure journal._ A restore brings back every account erased since the restore point, so their erasures must be applied again. `AccountRepo.erase` therefore writes `ERASURE#<sha256(userId)>` with `expiresAt` 8 days ahead (one day past the recovery window) inside its final transaction, so the entry exists exactly when the erasure is complete. It holds no personal data: no name, address or username, and the user ID is a random ULID (80 random bits), so its hash can be matched against a restored User item but not reversed or guessed. Kept rather than skipped because without it a restore would silently undo erasures; a journal of user IDs or usernames was rejected because it would itself be personal data. **Restore runbook:** DynamoDB restores into a new table, so before switching over, read every `ERASURE#` item from the live table, hash the `id` of each `USER` item in the restored table, and run `AccountRepo.erase` (username from the User item, the shared domains' subdomains, any session ID) for every match. Not automated yet: it belongs with the staging runbook (phase 10). Tested: the repository suite expects exactly one journal item, `{ pk, sk, expiresAt }`, keyed by an independently computed SHA-256 of the user ID, on both engines.
- _Sender-only reverse-alias tokens removed._ Tokens minted before contacts (§20.9) named the sender's address and kept verifying; after an owner deleted an address and created it again, they would have worked again. They were never deployed, so the token format drops them: version 2 is header, key version, contact id (running to the MAC) and MAC, 45 characters for a 16-character contact id. Version 1 tokens, with or without a sender, are rejected as malformed. `ReverseToken.mint` takes a contact id, `verify` returns `{ contactId, keyVersion }`, and `Pipeline.replyTarget` only looks the contact up by id. The legacy pipeline test is gone; core tests cover version 1 and reserved bits being rejected.
- _The on-the-fly race_ stays as documented in §20.3.
- _Later features (checked on rebase, 2026-10-22)._ API tokens (`TOKEN#<hash>`, listed on gsi1 `TOKENS#<userId>`) are deleted in the sweep's first step with the other sessions (§20.20); webhook endpoints (`WEBHOOK#<id>`) and the image-protection setting (in `SETTINGS`, §20.19) live in the user's partition and go in step 4; `AUTHFAIL#<sha256(ip)>` counters name no user. The journal entry is written once per erased account, whatever it stored, so a restore re-applies the whole sweep, these included. Webhook messages already queued are the one new trace (table above).

### 20.16 Design system in the web app (2026-10-22)

The web app now follows the user's Claude Design project "alias web (shadcn Base UI)": dark-first, layered near-black surfaces, 1px borders, 6px radius, one phosphor-green accent, green/amber/red only for status, Geist for text and Geist Mono (`data` utility) for addresses, domains and counts.

**What came over.** The project's tokens (light and dark, incl. `success`, `warning`, `chart-6/7`, 13px `text-sm`) are copied verbatim into `apps/web/src/styles.css`. Its components are shadcn's **base-nova** style on **Base UI**: matching the class names of the shadcn registry styles against the project's compiled CSS found every base-nova `Button` class in it, while each other Base UI style uses classes the compiled CSS lacks, so `components/ui/*` comes from the shadcn CLI with `style: "base-nova"`, plus the project's two extra `Badge` variants (`success`, `warning`). Radix (`radix-ui`) is gone. Only components a screen uses are kept, trimmed to the exports in use (knip). The fonts come from `@fontsource-variable/geist` and `geist-mono` (the same files the project ships) and are bundled by Vite, so no font CDN sees visitors.

**No React hooks.** The Effect lint bans every React hook, so the vendored components stay hook-free: the sidebar is cut down to its static form (no provider, no open state); below `md` the same navigation opens in a `Sheet`; `FieldError` lost its `useMemo`. Open dialogs and sheets live in the URL like the rest of the screen state (`/aliases?dialog=create`, `?contacts=<address>`, `?delete=<address>`, `?q=&status=&domain=`; `/destinations?dialog=add`), so each one can be linked and survives a reload.

**Screens** (`routes/_app/*`, behind one session gate that shows the passkey login in place when signed out, so a confirmation link still works after logging in):

| Screen       | Shows (real data only)                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview     | totals forwarded/blocked since creation, busiest aliases as a stacked bar, forwarded vs blocked, destinations with status, domains with alias counts, alerts for a bounced or missing verified destination, quick actions. No daily chart or date range: the API has no time series yet.                                                                                                         |
| Aliases      | search and domain/status filters, create (shared domain: random; subdomain: pick the address), active switch, Deactivate/Activate and Delete in the row menu (Delete asks first, says what is erased and offers "Deactivate instead", §20.15), contacts sheet with Block/Unblock/Remove, the on-the-fly switch, empty state. The alias mode select is gone: inbox mode drops mail until phase 7. |
| Destinations | the forwarding addresses (recipients), with Verified/Pending/Bounced, Default, complaint notes, Resend link, Make default, Remove, the "Add destination" dialog and its "Check your inbox" step, and confirming from the mailed link (which now points at `/destinations`).                                                                                                                      |
| Domains      | the shared domains, the user's subdomain and their verified custom domains, with alias counts; below, the custom domains with their DNS records (§20.18.3).                                                                                                                                                                                                                                      |
| Settings     | username, subdomain, account ID, passkey sign-in, and a danger zone: "Delete account" opens a dialog (`?dialog=delete-account`) listing what is erased and what stays (the username and shared-domain address tombstones, §20.15), then erases after a fresh passkey prompt. No passkey list: the API has none.                                                                                  |

**Accessible names** that tests can rely on: buttons "New alias", "Create alias" (dialog submit), "Cancel", "Contacts", "Alias actions" (row menu) with menu items "Deactivate"/"Activate" and "Delete", the confirm dialog's "Delete" and "Deactivate instead", switches "Active" (per alias row) and "Create aliases on the fly", "Copy address", searchbox "Search aliases", comboboxes "Filter by domain", "Filter by status" and "Domain" (create dialog), textbox "Address"; contacts "Block"/"Unblock"/"Remove"; destinations "Add destination", "Send confirmation", "Done", "Resend link", "Make default", "Destination actions" with "Remove", "Confirm this address"; navigation links "Overview", "Aliases", "Destinations", "Domains", "Settings", "Log out", "Menu" (mobile); login "Log in with a passkey", sign-up "Create passkey"; settings "Delete account" and, in its dialog, "Confirm with passkey". Card titles are headings (`CardTitle` renders an `h2`), and the on-the-fly switch is `aria-busy` (and disabled) until the settings load or a change saves. Tables are labelled "Aliases", "Destinations", "Domains".

**Verified** by `pnpm check`, `vite build`, and by hand on `pnpm dev` (§20.3): every screen at 1440×900 and the aliases screen at 390×844; create, deactivate, delete, contacts block/unblock, the active and on-the-fly switches, search, and confirming a destination from its link, all driven by role and accessible name.

### 20.17 Browser tests for the web app (2026-10-22)

§20.12 left the web UI unseen by a browser: sign-in needs a WebAuthn authenticator, and the session cookie is `Secure`. The new `browser` tier drives the real UI in headless Chromium against the whole emulated stack.

**Package.** `browser/` (`@alias/browser`) runs on `@effect/vitest`, like `e2e`, and uses Playwright as a library (`playwright` 1.64.1, pinned in the catalog), not its test runner, so the stack is the same Effect layers. Those layers moved out of `e2e/test/stack.test.ts` into `e2e/test/support/stack.ts`, exported as `@alias/e2e/stack` (`apiHandler`, `layer`, `smtp`, `sentTo`, …); the stack test uses them unchanged. `@alias/browser` depends on `@alias/web`, so `pnpm test:affected` runs it when the web app changes.

**Per test file** (`browser/test/support/browser.ts`), every listener on port 0:

1. `vite build` of `apps/web` into a temp dir (~0.3 s): the production bundle, not the dev server.
2. The function URL emulator for the API, started before the handler exists.
3. `vite preview` on `127.0.0.1:0`, proxying `/v1` and `/health` to it, as the planned CloudFront distribution would (§15). Its address gives the origin `http://localhost:<port>`.
4. The real API handler with relying party `localhost` and that origin, handed to the waiting function URL server. This breaks the cycle (the web app needs the API's URL, the API needs the web app's origin) without picking a port by hand.
5. The rest of the stack (fakecloud, the DoH emulator, SES emulator, inbound pipeline, feedback, webhook delivery, image proxy), and one headless Chromium (`chromium-headless-shell`).

`openPage()` opens a fresh browser profile per test and attaches a virtual authenticator over CDP (`WebAuthn.enable`, `WebAuthn.addVirtualAuthenticator`: `ctap2`, `internal` transport, resident keys, user verification that succeeds without a prompt).

**The `Secure` cookie.** Browsers treat `http://localhost` as a secure context, so Chromium stores and sends `Secure` cookies there and allows WebAuthn without TLS. The production cookie flags are unchanged (`Secure; HttpOnly; SameSite=Strict`), and the auth test checks that Chromium's cookie jar holds exactly that and that the session survives a reload.

**Tests**, selecting only by ARIA role and accessible name (one `filter({ hasText })` picks the contact's row, whose list items have no names), and checking the stored state through the API with the page's own cookie:

- `auth`: sign up with a passkey (one discoverable credential for `localhost`), reload, log out (cookie gone), log in again with the same passkey; a taken username shows the error; **delete the account** in Settings, confirmed with the passkey (the virtual authenticator answers the re-authentication), which signs out (cookie gone, `/v1/me` 401), leaves the browser's passkey unknown to the server, and keeps the username taken.
- `aliases`: create a random alias ("New alias" → "Create alias"), deactivate it from its "Alias actions" menu (still inactive after a reload), activate it with its "Active" switch, delete it through the confirmation dialog; create `shop@<user>.alias.test`; the "Create aliases on the fly" switch on, kept across a reload, and off.
- `destinations`: add a destination ("Add destination" → "Send confirmation", pending), open the link from the confirmation mail fakecloud's SES sent (`/destinations?confirm=…`), confirm (verified and default, query dropped from the URL); create an alias, mail it over SMTP through the SES emulator and the inbound pipeline, block the sender in the alias's contacts sheet (the next mail is dropped as `blocked-contact`), reload with the sheet open, unblock (the next mail is forwarded).
- `domains`: add a custom domain ("Add domain" in the Domains screen); the API creates its SES identity on fakecloud, and the page lists every DNS record the API stored (the MX to SES, three Easy DKIM CNAMEs, SPF, DMARC), each a row of the "DNS records for …" table.

The four files take ~8 s together locally. They target the design-system UI (§20.16); one selector uses `.first()`, for "New alias", "Add destination" and "Add domain", which the empty states repeat.

**Found on the way.** `vp run`, which runs `pnpm test`, traces each task's file reads by injecting a library into every process it starts, whatever their environment. Under it, Chromium's GPU process never produces a frame, so every Playwright click waited for a stable page until it timed out (`pnpm --filter … test`, as CI runs it, was fine). Chromium now runs the GPU thread in its browser process (`--in-process-gpu`). The tests also caught a sign-out bug in the redesigned UI: logging out or erasing the account removed every cached query, `me` included, and the layout kept observing the removed `me` query, so the app still showed the signed-in screens (without data) until a reload. `forgetSession` (`apps/web/src/lib/session.ts`) now overwrites `me` with signed-out and removes only the other queries.

**Toolchain and CI.** Chromium isn't a mise tool: Playwright downloads the build its version pins (Chrome for Testing headless shell) into its own cache. `pnpm agent:setup` runs `pnpm --filter @alias/browser install-browser` (`playwright install --only-shell chromium`, a no-op once installed). CI adds `@alias/browser` to the test matrix, caches `~/.cache/ms-playwright` by the catalog's Playwright version and installs with `--with-deps` for the system libraries.

**Not verified.** Other browsers; real authenticators (platform, roaming, hybrid); the HTTPS production origin and CloudFront's routing and headers (`vite preview` only routes by path); Playwright's download is pinned by version, not by a checksum in `mise.lock`.

### 20.19 Tracker protection on forwarded mail (2026-10-22)

Phase 6, part 1. Senders track opens with remote images (a 1×1 "pixel" per recipient) and clicks with per-recipient link parameters. Forwarding now takes both out, the way addy.io and SimpleLogin do, before the mail reaches the owner's mailbox.

**Settings** (`/v1/settings`, `UserRepo` `SETTINGS` item, both engines):

| Setting                 | Values                                  | Default          | Why                                                                                                                                                                      |
| ----------------------- | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `imageProtection`       | `off`, `block-trackers`, `proxy-images` | `block-trackers` | Removing invisible images changes nothing a reader sees, so it is on for everyone. `proxy-images` (part 2, below) also loads every other remote image through our proxy. |
| `isLinkCleaningEnabled` | boolean                                 | `false`          | Some sites need their parameters (logins, coupon links), so it's opt-in                                                                                                  |

The web app shows a select (images) and a switch (links) under the on-the-fly switch on the aliases page (`TrackerSettings`). The pipeline reads the alias owner's settings once per forward (one more `GetItem`; the inbound role already had it).

**What changes** (`packages/core`, `internal/trackers.ts`, called by `Mail.forward`). It reuses the reply-scrubbing MIME walk (§20.10, `internal/mime.ts`), whose rewrite callback is now an `Effect` so a rewrite can report what it did. Only inline `text/html` and `text/plain` parts that change are re-encoded, in their own transfer encoding; attachments, `cid:` images, other parts and headers are copied byte for byte. UTF-16/32 parts pass unchanged.

- **Tracking images** (`block-trackers`): an `<img>` with a remote `src` (http, https, scheme-relative) is removed when it is a pixel (every given width and height ≤ 2 px, addy.io's rule; a 600×1 divider stays), hidden (`hidden`, `display:none`, `visibility:hidden`, `opacity:0`, a zero width, height or max size, in attributes or inline CSS), or matches the tracker list. CSS `url(…)` in `style` attributes and `<style>` elements (such as `@media print` open tracking) and legacy `background` attributes that match the list become `none` or are dropped. Visible images from senders' own CDNs stay.
- **Link cleaning** (opt-in): known click-tracking parameters are removed from `<a>`/`<area>` `href`s and from bare links in plain text, keeping the rest of the URL as written (separators such as `&amp;`, order, fragment). Click-tracking redirectors (`…/ls/click?upn=…`) can't be undone without visiting them, so they stay.
- **Header.** `X-Alias-Trackers-Removed: <n>` and `X-Alias-Links-Cleaned: <n>` are added when something changed; incoming copies of both are removed, so they describe this hop only. No HTML banner: mail clients render inserted HTML unpredictably, and a notice on every newsletter is noise. A per-alias banner (addy.io's "banner location") would be its own setting.

**Lists** (vendored as data in `packages/core/src/internal/lists/`, pinned to a commit, refreshed by `node scripts/refresh-tracker-lists.ts`, which fails on any rule the matcher doesn't understand):

| List                                                                                                                                                        | Licence                                                                                | Why this one                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| EasyPrivacy `easyprivacy_general_emailtrackers.txt` (321 Adblock Plus rules, host + path, e.g. `.list-manage.com/track/`, `/wf/open?upn=`, `.awstrack.me/`) | GPL-3.0-or-later or CC BY-SA 3.0+; we use the GPL option, which combines with AGPL-3.0 | Maintained (several commits a month), email-specific, precise paths, so visible images on the same host stay                |
| Brave `query-filter.json` (≈70 parameters, some per site)                                                                                                   | MPL-2.0, kept under the MPL in its own file (§3.3 allows the combination)              | Small, email-heavy (`mc_eid`, `_hsenc`, `et_rid`, `sfmc_id`, …), unlikely to break links                                    |
| Our own additions (`filters.ts`)                                                                                                                            | AGPL-3.0                                                                               | `utm_*` (Brave leaves it out on purpose), `mc_cid`, `mkt_tok`, `_hsmi`, `gclsrc`, `gbraid`, `li_fat_id`, `ck_subscriber_id` |

Rejected: Disconnect and DuckDuckGo Tracker Radar (CC BY-NC-SA, not compatible and not email-specific), HEY's list and ugly-email (no licence), MailTrackerBlocker (BSD, but partly sourced from the unlicensed HEY list; good as a cross-check), AdGuard's tracking-parameter filter (GPL-3.0, larger and more aggressive; the step up if Brave's proves too small).

**Not handled.** Remote stylesheets (`<link rel=stylesheet>`) and fonts, `<input type=image>`, video posters, Outlook VML (`<v:image>`, `<v:fill>`) and images behind a `<base href>`: rare in mail and mostly blocked by clients. An open pixel that is visible and not on the list (a 600×1 image from an unknown host) still loads in `block-trackers` mode; `proxy-images` (part 2) hides the reader behind the proxy for those. Matching works on tags with regular expressions, not an HTML parser: what it misses is a missed tracker, never a broken message, and every regex was checked for linear time on 2 MB adversarial input.

**Tests.** Golden corpus (`packages/core/test/corpus/forward-*`: Mailchimp QP, SendGrid base64 with a print tracker, multipart/related with `cid:` and attachments, ISO-8859-1 QP with a `background` tracker, one with nothing to protect), each byte for byte against a reviewed `.expected.eml` (read back with Python's `email` package), idempotent, and checked by the test-side MIME decoder; core unit tests (each pixel and hiding variant, visible images, `cid:`/`data:`/relative kept, CSS, link cleaning incl. Brave's per-site parameters, off means byte for byte, UTF-16, incoming header fields replaced, every vendored rule understood); repository (settings defaults and changes on both engines); API handler (defaults, changes, 400 on unknown modes); pipeline on fakecloud (default blocks, the owner's settings are followed); stack (`e2e`: an HTML newsletter over SMTP arrives without its pixel and with `X-Alias-Trackers-Removed: 1`, then, after `PATCH /v1/settings`, with its pixel and cleaned links; header names identical apart from the counting fields, no sender `DKIM-Signature`, MIME fields unchanged).

#### Part 2: the image proxy (2026-10-22)

With `proxy-images`, forwarding still removes trackers, and then points every other remote image (`<img src>` and `srcset`, `<input type=image>`, `<video poster>`, `background` attributes, CSS `url(…)` in `style` attributes and `<style>` elements) at a signed URL on our proxy. Opening the mail then shows the sender the proxy's address (an AWS IP), not the reader's IP, mail client, cookies or `Referer`, and CloudFront's cache means a re-opened mail fetches nothing again. A per-recipient image URL still tells the sender that someone opened it once; only blocking avoids that, which is why trackers go first. `X-Alias-Images-Proxied: <n>` counts the rewritten URLs. Proxy URLs are never proxied again, so forwarding a forwarded copy changes nothing.

**Signed URLs** (`ImageProxy` in `@alias/core`): `<base>/img/<key version>/<mac>/<base64url(URL)>`, the MAC HMAC-SHA-256 over a domain separator and the URL, truncated to 128 bits and checked in constant time. The proxy fetches only what verifies, so it is no open relay: a URL has to come out of our own forwarding. URLs don't expire (mail is kept for years); retiring a key breaks every image it signed. Keys use the `<version>:<base64url>` keyring format of the reverse-token keys, now one `Keyring` module in core (parse and validation moved there from `ReverseToken` and `ReverseKeys`) and one loader, `Parameters.keyring`/`keyringConfig` in `@alias/aws`, for both SSM `SecureString`s (`/alias/<stage>/image-proxy-keys`, read by the inbound Lambda to sign and by the proxy to verify). Signing happens in a second pass over each part, because it is an Effect: the first pass names the URLs, they're signed once each, the second pass puts them in.

**Where it runs: its own Lambda, `apps/image-proxy`, behind CloudFront.** Not a route on the API Lambda: the proxy fetches attacker-chosen URLs, so it gets a role that can read its keys and nothing else (no table, no spool, no SES, no session secrets), its own timeout and memory, and a reserved concurrency of 10 that caps what a flood of uncached URLs can cost and keeps it from starving the API. The function URL is `AWS_IAM` with CloudFront Origin Access Control (`lambda:InvokeFunctionUrl` + `lambda:InvokeFunction`, only for this distribution), so nothing reaches it but CloudFront's cache. The cache policy is AWS's managed CachingOptimized: the cache key is the path alone, no cookies, query or viewer headers reach the Lambda, and it honours the Lambda's `Cache-Control` (images a day, origin failures 5 minutes, bad signatures and refused hosts a day). Infra is typechecked only; the distribution answers on its `*.cloudfront.net` name until a certificate for `img.<app domain>` exists.

**What a request does** (`Proxy.ts`, `Egress.ts`):

1. `GET`/`HEAD` only (else 405); the path must verify (else 403, cached).
2. The URL must be http(s), without credentials, on port 80 or 443. Every address its host resolves to must be public: not private, loopback, link-local (incl. the metadata address 169.254.169.254 and the Lambda runtime API on 127.0.0.1:9001), CGNAT, documentation, benchmarking, multicast or reserved; IPv6 must be global unicast and not Teredo, 6to4 or documentation; IPv4-mapped and NAT64 forms are checked as IPv4. The address rule is the one webhook delivery uses (`WebhookUrl.isAllowedAddress`, §20.20), shared, not copied. The check runs inside the socket's own DNS lookup, so the connection goes to exactly the checked address (no DNS rebinding); IP literals, which Node never looks up, are checked first. `node:http` is used directly for that hook (one lint exemption, `vite.config.ts`), since Effect's HTTP client has none.
3. Redirects are followed by hand, at most three, every hop checked again.
4. The request carries a fixed `User-Agent` and `Accept` and nothing of the reader's. The response must be a 200 of at most 4 MiB (function URL responses are capped at 6 MB including base64), within 5 s in total.
5. The bytes decide the type: PNG, JPEG, GIF, WebP, AVIF, BMP or ICO by magic number, whatever the origin's `Content-Type` says; anything else (SVG, which can carry scripts; HTML) is 415. The answer has that type and our own headers only (`nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: cross-origin`); the origin's cookies and headers stay behind.

**Cost** (eu-west-1 / Europe list prices as published, not yet checked against a bill): Lambda arm64 at 256 MB and ~200 ms per uncached image is about $0.9 per million fetches (requests + GB-s), inside the always-free 1 M requests and 400 k GB-s for a long time. Data from the internet into Lambda and from the Lambda origin to CloudFront is free. CloudFront's always-free tier covers 1 TB out and 10 M requests a month; beyond it, about $0.085/GB and $0.012 per 10 k HTTPS requests in Europe (or the flat-rate plan, §14.1). Example: 3 M forwards a month, 20 % of users proxying, five 100 KB images per mail, each opened once, is 3 M images and 300 GB: free. Everyone proxying at that volume: ~15 M images, 1.5 TB, about $50 for CloudFront and $13 for Lambda a month, less with cache hits (images shared by all recipients of a newsletter are fetched once).

**Dev.** `pnpm dev` runs the proxy on `ALIAS_IMAGE_PROXY_PORT` (port block offset 8) with production's egress policy; inbound signs for `http://localhost:<port>` with a fixed dev key in fakecloud's SSM. Smoke-tested: a signed URL for a real PNG on the internet comes back as `image/png` with the cache and security headers; signed URLs for 169.254.169.254 and for fakecloud on localhost come back 403.

**Tests.** Core (`ImageProxy`: round trip, tampered URL or MAC, unknown and retired keys, malformed paths, a signed `file:` URL refused; proxy mode: every image position rewritten and verifiable, `cid:`/`data:`/links kept, trackers still removed, proxy URLs left alone, one signature per URL; a golden corpus case, `forward-mailchimp-proxied`, read back with Python's `email` package; `Keyring` parsing); egress (`apps/image-proxy/test/egress.test.ts`: address classification table, IP literals in every spelling, `localhost` refused after DNS, schemes, ports, credentials, redirect chains and redirects to the metadata address, `file:` or a loopback name, size limits declared and chunked, the deadline, non-200); handler (`proxy.test.ts`, keys from fakecloud SSM, requests through the function URL emulator, a local origin on 127.0.0.1 port 0: the image with only our headers, the origin's cookie not passed back and the reader's cookie and `Referer` not passed on, bytes over `Content-Type`, SVG and HTML refused, tampered/unsigned/foreign URLs refused without touching the origin, `HEAD`, 502 with a short cache; the production configuration refuses loopback and its result decodes with `FunctionUrlResult`); pipeline on fakecloud (proxy mode follows the owner's setting); stack (`e2e`: a newsletter over SMTP is forwarded with its image proxied and its pixel removed, and fetching the proxy URL through the proxy Lambda's function URL returns the origin's PNG while the origin sees no cookie or referrer). Tests that need the local origin allow exactly 127.0.0.1 (`@alias/image-proxy/testing`); everything production must refuse is tested with production's policy.

**Needs a real account.** The OAC + `AWS_IAM` function URL wiring and both Lambda permissions, CloudFront honouring the Lambda's `Cache-Control` under CachingOptimized, the 6 MB response cap with a 4 MiB base64 image, reserved concurrency on a new account (its unreserved minimum may not allow 10), real latency and cost per fetch, and a certificate plus `img.<app domain>` in Cloudflare DNS.

### 20.20 API tokens and webhooks (2026-10-22)

Phase 8, part 1: the foundation the CLI, SDK, browser extensions and MCP build on.

#### Personal API tokens

**Format.** `alias_pat_` + 32 random bytes in base64url (43 characters). The prefix lets secret scanners (GitHub push protection, gitleaks) recognise a leaked token; anything else in `Authorization: Bearer` is refused before any lookup.

**Storage.** Only the SHA-256 of the token is stored, as the key of a `TOKEN#<hash>` item (`TokenRepo`, `Table.spec`, suite on fakecloud and DynamoDB Local), with the owner, name, scopes, the last four characters (`hint`, for the list), `createdAt`, optional `expiresAt` (also the TTL attribute) and `lastUsedAt`. A plain hash and not argon2/scrypt: slow hashes protect low-entropy passwords from offline guessing, and a 256-bit random secret can't be guessed offline at any hash speed. The plain hash is a lookup key, so authenticating costs one strongly consistent GetItem and no CPU; a salted slow hash would need a token id in the token and tens of milliseconds per request. Listing is a gsi1 Query on `TOKENS#<userId>`; revoking deletes the item. `lastUsedAt` is written at most every 5 minutes per token (a conditional UpdateItem that never re-creates a revoked token), and a failed write only logs.

**API** (`TokensGroup` in `@alias/contracts`): `GET /v1/tokens`, `POST /v1/tokens { name, scopes, expiresInDays? }` (1 to 366 days, none = until revoked; the response carries the secret, shown once), `DELETE /v1/tokens/:tokenId`. The web app has an "API tokens" section on the Settings screen (§20.16's design system).

**Scopes** (`Scopes.ts`): `aliases`, `contacts` (third parties' addresses, so separate), `recipients` and `settings`, each `:read` (GET) and `:write` (everything else). An endpoint opens itself to tokens with `requires("aliases:read")(endpoint)`, an annotation the `Authentication` middleware reads; `GET /v1/me` takes any token (`anyToken`). **An endpoint without the annotation is session-only**, so a new endpoint is closed to tokens until it names a scope: tokens, passkey sign-up/login and account erasure (§20.15) stay out of reach, and so do webhooks. MCP (phase 9) adds `inboxes:read`/`inboxes:write` with the temp-mail endpoints, so an assistant can hold a temp-only token, and a send scope whose sends wait for the owner's confirmation; scopes arrive with their endpoints because knip forbids unused ones.

**Authentication** (`apps/api/src/Authentication.ts`). `Authentication` now declares two security schemes, the `__Host-` session cookie and `Authorization: Bearer`; Effect's `HttpApiBuilder` tries them in order and the first success wins. A token on an endpoint that doesn't accept it gets `Forbidden` (403, naming the missing scope); a missing, unknown, revoked or expired token gets `Unauthenticated` (401). Like a session (§20.15), a token authenticates only while its User item exists, and erasing an account deletes its tokens in the sweep's first step, next to the other sessions.

**Failure rate limit.** Each failed token attempt counts against the client address (`AUTHFAIL#<sha256(ip)>` / `FAILURES#<hour>`, the `Quota` helper); after 20 in a UTC hour, every token request from that address gets `TooManyAttempts` (429) before any lookup, valid tokens included. Guessing a 256-bit token is hopeless anyway; the limit protects the table and the bill. The address comes from the function URL event (`requestContext.http.sourceIp`), which `FunctionUrl.toRequest` passes in `x-alias-source-ip`, replacing anything a client sent under that name. **Behind CloudFront (§15) that address is CloudFront's**: the infra step that adds CloudFront must switch to `CloudFront-Viewer-Address` (set by CloudFront, not the client).

**CSRF.** Unchanged for cookies: `SameSite=Strict` keeps the session off cross-site requests. Bearer requests can't be forged cross-site: browsers never attach an `Authorization` header on their own, and setting one cross-origin needs a CORS preflight the API doesn't answer (no CORS headers; the web app is same-origin).

**Tests.** Repository on both engines (lookup by hash, per-user listing, expiry before TTL, owner-only revoke, the touch interval under a concurrent stale read, no revival after revoke, failure counting per source and hour under concurrency), contract (`FunctionUrl` overrides a client-sent `x-alias-source-ip`), API handler (`apps/api/test/tokens.test.ts`: shown once and listed without the secret, acts for its user, scopes enforced per endpoint, session-only endpoints refuse every token, revoke by owner only, expiry, malformed/unknown/truncated tokens, a valid cookie wins over a junk bearer, 429 per address and its reset, payload validation) and stack (`e2e`: mint in the session → create an alias over the function URL with the token → out-of-scope and token-minting attempts get 403 → revoked token gets 401), erasure (`apps/api/test/erasure.test.ts`: a token can't start an erasure, and stops working after one; `AccountRepo` on both engines leaves no token behind).

#### Webhooks

Users register HTTPS endpoints; the Lambdas report events to them, signed per [Standard Webhooks](https://www.standardwebhooks.com) (spec read 2026-10-22).

**Events** (`WebhookEvent` in `@alias/contracts`, the body of each POST: `{ type, timestamp, data }`): `alias.created` (`origin`: `api` or `on-the-fly`), `alias.deleted`, `mail.forwarded` (with the sender's `contactId`), `mail.blocked` (with the reason: spam, virus, loop, blocked contact, rate limit…), `recipient.bounced` (the owner's own forwarding address). **Metadata only**: never content, subject or a third party's address; the contact id lets the owner look the sender up through the contacts API (`contacts:read`).

**API** (`WebhooksGroup`, session-only: an endpoint is a standing data sink, so it takes a passkey sign-in, not a token): `GET/POST /v1/webhooks` (the `whsec_` secret is in the create response only), `PATCH /v1/webhooks/:id { eventTypes?, isEnabled? }`, `POST /v1/webhooks/:id/secret` (rotate), `DELETE`. Ten endpoints per user (a soft cap: the count check isn't atomic). The web app has a "Webhooks" card under Settings. Endpoints live in the user's partition (`WEBHOOK#<id>`, `WebhookRepo`, suite on both engines); every published event costs one strongly consistent Query. Erasing the account (§20.15) deletes them with the rest of the partition (`AccountRepo` suite).

**Signing** (`Webhook` in `@alias/core`, checked against Svix's published example signature): secrets are `whsec_` + base64 of 32 random bytes; `webhook-signature` is `v1,<base64 HMAC-SHA256 of "<webhook-id>.<webhook-timestamp>.<body>">`. Rotating keeps the old secret signing for 24 hours, so the header carries both signatures (space-separated, as the spec allows) and receivers switch without losing deliveries. `webhook-id` is `msg_` + 128 bits of SHA-256 over the event type and a natural key (SES message ID + recipient, alias id, bounce + address), so a retried producer Lambda repeats the id and receivers can deduplicate. `Webhook.verify` is the receiver side (5-minute timestamp tolerance, constant-time compare), used by the tests. Secrets are stored as is in the table (HMAC needs them); DynamoDB encrypts at rest, but anyone who can read the table can forge deliveries; see the open questions.

**Delivery** (§14.2: "Lambda async retries + SQS DLQ"):

1. Producers (`Publisher` in `@alias/webhooks`: API alias handlers, the inbound pipeline after a forward or a counted block or an on-the-fly creation, the feedback Lambda after marking a bounced recipient) list the user's enabled, subscribed endpoints and send one SQS message per endpoint (`MessageQueue.send`, `SendMessageBatch`). Best effort: a failure logs a warning and never fails the mail, API call or bounce handling. Users without webhooks cost one Query and nothing else.
2. The delivery Lambda (`apps/webhooks`, `Delivery.handle`) gets batches of 10 through an SQS event source mapping with `ReportBatchItemFailures`. Per record: re-read the endpoint (deleted, paused, unsubscribed or now-refused URLs drop the message), sign at send time, POST with a 15 s timeout, read only the status.
3. `2xx` is done. `410 Gone` disables the endpoint (the spec's advice). Anything else, a timeout or a refused connection pushes the message out with `ChangeMessageVisibility` by 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h (±20 % jitter; the schedule Svix publishes) and reports it as a batch item failure. After 8 receives SQS moves it to the dead-letter queue (14 days).

**SSRF.** `WebhookUrl.check` (core, pure) runs at registration and again at delivery: `https:` only, no credentials, at most 2048 characters, no single-label or `localhost` names, and IP literals must be globally reachable (IANA special-purpose ranges, IPv4-mapped/NAT64/6to4/Teredo forms, link-local and the metadata address 169.254.169.254 refused; the WHATWG parser normalises `0x7f.1`-style hosts first). At connect time, `Egress` gives Undici a `lookup` that resolves the name and fails unless **every** address is allowed, and the socket connects to exactly those addresses, so DNS rebinding between check and connect gets nowhere. Redirects are never followed (counted as a failure, as the spec says). This matters even outside a VPC: a Lambda reaches its own runtime API on 127.0.0.1. Tests and `pnpm dev` set `ALIAS_WEBHOOK_ALLOW_LOOPBACK=true` (`UrlPolicy`), which admits `http://` to loopback only; infra never sets it.

**Emulation (new AWS dependency: SQS).** Research in fakecloud v0.51.0 (`crates/fakecloud-sqs/src/service/messages.rs`, read 2026-10-22): JSON protocol, `SendMessageBatch` with per-entry failures, `ReceiveMessage` with `MessageSystemAttributeNames` (`ApproximateReceiveCount`, `SentTimestamp`, `ApproximateFirstReceiveTimestamp`, `SenderId`), `MD5OfBody`, `ChangeMessageVisibility` (0–43200 s, `ReceiptHandleIsInvalid`), redrive to the dead-letter queue on the receive that exceeds `maxReceiveCount` (as AWS documents). fakecloud's Lambda event source mappings need Docker, so `tools/lambda-emulator` gains `SqsEventSource`: it polls with `ReceiveMessage`, builds the documented Lambda SQS event (`toEvent`, written apart from the production schema), invokes the handler and deletes what the documented partial-batch rules say succeeded (`failedIds`: no/empty/null `batchItemFailures` is success; a thrown error, invalid JSON, or an empty, null, missing or unknown `itemIdentifier` fails the whole batch). Contract tests: the documented Lambda event and batch response (`packages/aws/fixtures/sqs-*.json`) decode with production's `SqsEvent`; the documented `ReceiveMessage` response maps to exactly the documented event fields; on fakecloud the documented body's `md5OfBody` matches the documentation, reported failures come back after their pushed-out visibility with `ApproximateReceiveCount` 2, a failed invocation deletes nothing, the third receive with `maxReceiveCount` 2 lands in the DLQ, and backoff is capped at SQS's 12 hours.

**Infra** (typecheck only): queue `alias-webhooks-<stage>` (visibility 180 s = 6 × the delivery Lambda's 30 s timeout, 4-day retention, SSE-SQS, redrive after 8 receives) and its DLQ; the delivery Lambda with an event source mapping (`batchSize` 10, `ReportBatchItemFailures`), `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes/ChangeMessageVisibility` on the queue and `dynamodb:GetItem/UpdateItem`; `sqs:SendMessage` for the API, inbound and feedback Lambdas (feedback also gets `dynamodb:Query`); `ALIAS_WEBHOOK_QUEUE_URL` in all four.

**Dev.** All dev bins use the queue `alias-webhooks` on fakecloud (`WebhookQueue.dev`); `apps/webhooks/bin/dev.ts` polls it (new `webhooks` process in `pnpm dev`). Smoke-tested: an endpoint for the demo user on a local receiver → SMTP to `shop@alias.test` → `inbound forwarded` → `webhook event queued` → `webhook delivered` → the receiver verified the signature.

**Tests.** Core (the published example signature, verification edge cases, URL and address rules incl. encoded loopback/metadata forms), repository (`WebhookRepo` on both engines: per-user isolation, partial updates, atomic secret rotation, owner-only delete), contract and emulator (above), webhooks package on fakecloud (`packages/webhooks/test/delivery.test.ts`: signed POST to every subscribed endpoint once, nothing queued for paused/unsubscribed, retry with the same `webhook-id` after backoff, redirects not followed and exhaustion to the DLQ, 410 disables, unreachable retries, both signatures after rotation, stored URLs refused under the production policy, `Egress` refuses `localhost` unless loopback is allowed), API handler (`apps/api/test/webhooks.test.ts`: secret once, URL refusals, the cap, isolation, tokens get 403, `alias.created`/`alias.deleted` queued), pipeline and feedback on fakecloud (forwarded/blocked/on-the-fly events with no sender address or subject; one id for a redelivered bounce), the delivery Lambda built from its environment on the documented event, and stack (`e2e`: register over the API → SMTP → inbound → SQS → emulated mapping → delivery → a port-0 receiver verifies the signature and finds only metadata).

**Not verified (needs AWS):** recorded SQS Lambda events and the mapping's real behaviour on partial failures plus `ChangeMessageVisibility` from inside the function (documented, emulated here); the IAM statements; Undici's `lookup` on Lambda's network; TLS to receivers (tests use loopback http).

### 20.18 Custom domains (2026-10-22)

Phase 5: users bring their own domain (`anything@mydomain.com`), received and sent through SES like the shared domains (§19.1, §18: records only, no nameserver change). Built as a stack; each step below has its own subsection.

#### 20.18.1 Domain model, SES identity, DNS checks, verification cron

**Records** (`DomainSetup.records` in the new `packages/dns`; the API lists them with what the last check found):

| Purpose   | Type  | Name                          | Value                                               | Needed      |
| --------- | ----- | ----------------------------- | --------------------------------------------------- | ----------- |
| ownership | TXT   | `<domain>`                    | `alias-verification=<random token per claim>`       | yes         |
| receiving | MX    | `<domain>`                    | `10 inbound-smtp.eu-west-1.amazonaws.com`           | yes         |
| DKIM (×3) | CNAME | `<token>._domainkey.<domain>` | `<token>.<SigningHostedZone or dkim.amazonses.com>` | yes         |
| MAIL FROM | MX    | `bounce.<domain>`             | `10 feedback-smtp.eu-west-1.amazonses.com`          | recommended |
| MAIL FROM | TXT   | `bounce.<domain>`             | `v=spf1 include:amazonses.com ~all`                 | recommended |
| DMARC     | TXT   | `_dmarc.<domain>`             | `v=DMARC1; p=none` (any policy passes; §19.3)       | recommended |

**Why an ownership token as well as DKIM.** The DKIM CNAMEs prove control to SES, but their tokens belong to the account's SES identity, not to the user who claimed the domain (and whether SES issues new ones after an identity is deleted is undocumented), and the MX is the same for every SES customer in the region. So neither proves to _us_ that this user controls the domain. The TXT token is random per claim (128 bits). Checks are exact: the token among the domain's TXT records, every most-preferred MX is SES's inbound endpoint, each CNAME points at its own token, exactly one MAIL FROM MX (SES requires it), exactly one SPF policy that includes `amazonses.com` (two are a permanent error, RFC 7208 §4.5).

**Statuses** (`DomainRepo`, `DomainVerification.decide`, pure and unit-tested on the documented SES responses):

- `pending` → `verified` when every required record is `ok` **and** SES reports DKIM `SUCCESS` and verified for sending. A pending domain not verified within 72 hours (SES stops looking then too) is released: identity and claim deleted, so nobody can squat a domain they can't verify.
- `verified` → `failed` when a required record is missing or wrong, or SES no longer verifies DKIM; `failed` → `verified` again by itself once fixed (`verifiedAt` kept).
- A lookup that fails (DoH network/HTTP error, SERVFAIL, truncation, SES unreachable or `TEMPORARY_FAILURE`) is `unknown` and changes nothing: a flaky resolver never takes a working domain down. NXDOMAIN and "no such record" are definite answers.

**DoH client** (`Doh` in `packages/dns`). Cloudflare's JSON API (`cloudflare-dns.com/dns-query`, `ALIAS_DOH_URL` overrides), parsed at the boundary with `Doh.Response`. Fixtures: the Cloudflare and Google documentation examples plus answers recorded from both resolvers on 2026-10-22 (MX, null MX, TXT through a CNAME with a 255-character split, NXDOMAIN, no data, the 400 errors). The recordings showed what the docs don't: Cloudflare drops the trailing dot on owner names but not on targets, and Google prints TXT unquoted while Cloudflare quotes and splits it.

**DoH emulator** (`tools/doh-emulator`, the "DoH stub" of phase 2). Answers Cloudflare's JSON from in-memory zones: CNAME chasing, NXDOMAIN vs. no data with the zone's SOA, empty non-terminals (RFC 8020), TXT quoting and splitting, Cloudflare's 400s and its empty 400 without the JSON `accept` header. Its contract test sets up a zone with the recorded records, asks the recorded question and compares the answer field by field (TTLs, the DNSSEC flag and SOA contents aside); it shares no code with the client. Tests set zones in-process; `pnpm dev` runs it on the worktree's new `+9` port with `PUT /_emulator/zones/<apex>`.

**SES identities** (`Identities` in `packages/aws`): `CreateEmailIdentity` (Easy DKIM), then `PutEmailIdentityMailFromAttributes` (`bounce.<domain>`, `USE_DEFAULT_VALUE`, so sending works before the MAIL FROM records exist) and `PutEmailIdentityFeedbackAttributes` (forwarding off, as for the shared domains: bounces arrive as events, §20.11); `GetEmailIdentity`; `DeleteEmailIdentity` (idempotent). Fixtures follow the API reference's Response Syntax; fakecloud's responses decode with the same schema (`tools/aws-emulators/test/ses-identities.test.ts`, which also pins the divergences listed in §20.3).

**Data** (`DomainRepo`, `Table.spec`, suite on fakecloud and DynamoDB Local): `DOMAIN#<domain>` is the claim (one user per domain across the service, one GetItem for the inbound Lambda), written in one transaction with the owner's `USER#…/DOMAIN#<domain>` pointer and `USER#…/DOMAINS` counter (at most 3 per user, §17, atomic). All domains share the gsi1 partition `DOMAIN-CHECKS`, sorted by the next check, so the cron finds due domains with one Query.

**API** (`DomainsGroup`, signed in or with a personal API token holding `domains:read` (list, get) or `domains:write` (add, check, update, delete), scopes this adds to §20.20's; other users' domains answer 404): `GET/POST /v1/domains`, `GET/PATCH/DELETE /v1/domains/:domain` (`isCatchAllEnabled`, used by §20.18.2), `POST /v1/domains/:domain/check` (at most one real check per 10 seconds). Adding normalizes (`Example.COM.` → `example.com`) and refuses non-domains, the shared domains, their subdomains and their parents (an SES identity covers its subdomains). The claim is written before the SES identity is created, so two users adding one domain never both reach SES; SES failing releases the claim (503), and an identity left by an interrupted attempt is adopted (and recreated by the cron if missing). Deleting deletes the identity, then the caller's aliases on the domain, then the claim, so a later owner of the domain inherits nothing.

**Deletion and erasure** (with §20.15's tombstones; decided: erasure _frees_ the domain rather than tombstoning it). Tombstones keep a deleted address from the next claimant because third parties still mail it; on a custom domain the next claimant must control the domain, and with it all of its mail, so a tombstone protects nobody and would only keep the domain's next owner from those addresses. So removing a domain deletes the owner's aliases on it **and their tombstones** (`AliasRepo.releaseDomain`, resumable), and erasing an account (GDPR Art. 17) first deletes the SES identities of the user's domains, then `AccountRepo.erase` treats custom-domain aliases like the user's own subdomain (no tombstone) and deletes the domain claims (pointers and counter go with the user's partition). After a point-in-time restore (§20.15 addendum), the restored domain claims of an erased user come back while their SES identities don't, and the cron would create the identities again; re-applying the erasure from the journal must therefore delete those identities too, as the API's erase does (until that is automated, part of the restore runbook). Deleting one alias on a custom domain still leaves a tombstone that only its owner can reclaim, as on shared domains, until the domain itself is removed. Tested on both engines (account sweep with a custom domain; release keeps other domains' aliases and shared-domain tombstones) and over the API (erasure frees the domain for another user).

**Cron** (`apps/api/src/verifyHandler.ts`, a third Lambda in the API app): EventBridge Scheduler every 10 minutes (`AWS.Scheduler.every(…).toLambda`, whose role may only invoke this function); each run checks up to 50 due domains, two at a time: pending ones every 10 minutes, verified daily, failed every 6 hours, inconclusive ones again after 10 minutes. `pnpm dev` runs the same `runDue` every minute inside `apps/api/bin/dev.ts`.

**IAM** (typecheck only). The API and the cron get `ses:CreateEmailIdentity`, `GetEmailIdentity`, `DeleteEmailIdentity`, `PutEmailIdentityMailFromAttributes` and `PutEmailIdentityFeedbackAttributes` on `identity/*` **of this account** (custom identities are created at run time, so they can't be named), plus an explicit `Deny` of the mutating actions on the shared domains' identities and their subdomains, so a bug can't delete or reconfigure the service's own domains. The cron's table access is GetItem/UpdateItem/DeleteItem and Query on gsi1 only.

**Tests.** Unit (`packages/dns`: every fixture decodes, answer/TXT/MX parsing, each record judge, the verdict; `decide` on the documented SES responses), contract (DoH emulator against the recorded answers and with the production client end to end; SES identities on fakecloud), repository (`DomainRepo` on both engines: one owner under concurrent claims, the per-user cap under concurrency, owner-only changes, removal frees domain and allowance, due order), handler (`apps/api/test/domains.test.ts` on fakecloud + the DoH emulator: add with identity, MAIL FROM and feedback settings; refusals; pending → verified only with the ownership token; failed and recovered; cooldown; release after 72 hours; isolation; deletion with aliases; the cron).

**Not verified** (needs a real account, phase 2): everything in the §20.3 custom-domains bullet, that the IAM `Deny` with `identity/*.<shared>` patterns behaves as intended, and that Scheduler's synthesized role is accepted on the first deploy.

#### 20.18.2 Receiving and sending on custom domains

**Receiving.** `Route` now routes every domain that isn't shared as a custom domain (`isCustomDomain`) instead of dropping it. The pipeline looks the domain up (`DomainRepo.find`, one GetItem) before the alias: no claim drops as `unknown-domain`, `pending`/`failed` as `unverified-domain` (both directions: an unverified domain neither receives nor sends). Only aliases owned by the domain's current owner count, so an alias a previous owner left behind never receives the new owner's mail (deleting a domain also deletes its aliases, §20.18.1; this is the second line). An unknown address on a verified domain whose owner turned **catch-all** on (`PATCH /v1/domains/:domain`, off by default, §19.2) is created like an on-the-fly alias (§20.8): never for spam or viruses, counted against the same daily per-user allowance.

**Receipt rule.** Production needs nothing new: the rule has no recipient condition, which SES applies to every verified domain of the account, custom ones included (§3, `infra/alchemy.run.ts`). The ses-emulator now does the same: `verifiedDomains: "identities"` asks SES (`ListEmailIdentities`, verified `DOMAIN` identities) at every `RCPT TO`, so a custom domain is received from the moment the API creates its identity, and a deleted one is refused again (contract test on fakecloud; an e-mail-address identity doesn't make its domain receivable). Dev and the stack test use it; mail that arrives before verification is dropped by the pipeline. fakecloud verifies identities at once, so in the emulators a pending domain is receivable earlier than on AWS (where SES receives only once DKIM is verified); the pipeline's own check makes the outcome the same.

**Sending.** Forwards go out from `alias+r.<token>@<custom domain>` and replies from the alias itself, with a fresh `Message-ID` on that domain (§20.6), so DKIM (Easy DKIM on the identity) aligns with the custom domain. The inbound role's `SendEmail` grant now covers every identity **of this account** (`identity/*`) plus the configuration set. That is acceptable because every identity in the account is the service's own (shared domains and claimed custom domains), SES refuses unverified identities, and the pipeline sends only from aliases on a domain that is verified and owned by the alias's owner. Narrower IAM would need the domain names at deploy time, or identity tags with an `aws:ResourceTag` condition on `SendEmail`, which is unverified.

**Tombstones and webhooks.** Deleting one alias on a custom domain leaves a tombstone like anywhere else (§20.15): its owner may create the address again, nobody else can, and catch-all never brings it back; removing the whole domain releases them (§20.18.1). An alias created by catch-all publishes `alias.created` with `origin: "on-the-fly"` (§20.20), the same event as on a subdomain. Domain status changes (`domain.verified`/`domain.failed`) are **not** webhook events yet: it would need the publisher, the queue URL and `sqs:SendMessage` in the verification cron, so it is left for a follow-up.

**API.** `POST /v1/aliases` with an `Address` on one of the caller's custom domains creates it while the domain is verified (`domain-not-verified` otherwise; someone else's domain answers `unknown-domain`). `GET /v1/aliases/domains` lists the caller's verified domains as `custom`.

**Tests.** Unit (`route` sends any other domain down both paths), handler (`pipeline.test.ts`: forward and reply as the custom domain, `unverified-domain` for pending/failed both ways, `unknown-domain`, a previous owner's alias, catch-all on/off, spam never creates, the shared daily cap; `domains.test.ts`: aliases only on the caller's verified domains), emulator contract (receiving follows SES identities) and stack (`e2e`: a user adds a domain, mail is dropped as `unverified-domain`, the wizard's records go into the DoH emulator, the check verifies, an alias is created, mail to it is forwarded from a reverse alias on the domain, and the owner's reply leaves as `shop@<domain>` without their address).

#### 20.18.3 Domain wizard in the web app

Built on the design system (§20.16). The Domains screen lists verified custom domains in the "Domains you can use" table (kind "Custom") and, below, one card per custom domain: the status badge (Pending, Verified, Records missing), what that means for its aliases, when it was last checked and, while pending, when it is released; the records to publish as DNS providers' forms ask for them (what each is for, required or recommended, type, name, value with the MX priority apart, each copyable) with what the last check found (a missing _recommended_ record shows as a warning, not an error); **Check now**; the catch-all switch; and removal. "Add domain" (`?dialog=add-domain`) says up front that only the MX moves, so a domain that already receives other mail is the wrong one; removal (`?remove=<domain>`) asks first and says the domain's aliases go with it. The list refetches every minute so the cron's checks show up; every change also refreshes the alias form, whose domain picker gains a "Your custom domains, any address" group.

Verified by `pnpm check` (lint, types, knip), `vite build`, and by eye: a throwaway user registered with the software authenticator on `pnpm dev`, one domain verified through the DoH emulator and one pending, the built app served behind a throwaway proxy that adds the session cookie (the preview browser can't keep the `Secure` cookie over http, and its automation timed out), screenshots from Playwright's headless Chromium at 1440 px and 390 px (with the add dialog open). No automated browser test yet (§20.17's harness would add one).

### 20.22 Temp mail, inbox mode and OTP extraction (2026-10-22)

Roadmap phase 7, in steps.

#### 20.22.1 Verification-code and magic-link extractor

`Verification.extract` in `@alias/core` (PLAN.md §3.6, step 1) reads a message's subject, text body and HTML body as text and returns the one-time code and the verification ("magic") link, or none. It is deterministic, does no I/O, and never visits a link. `Message.read` (also new in core) decodes a raw message for display: header fields with encoded-words and 8-bit UTF-8, the first inline `text/plain` and `text/html` parts through their transfer encoding and charset (unknown charsets and broken UTF-8 fall back to windows-1252), and the other parts listed as attachments. It shares the MIME walk with `Mail` (`internal/mime.ts`); `internal/html.ts` turns HTML into the text a reader sees (table cells become spaces, so a code written one digit per cell reads `4 8 2 9 1 3`).

**Codes.** Candidates are digit runs of 4 to 8 (also grouped `482 913` / `482-913`, spaced one digit per cell, Google's `G-482913`) and upper-case letter-digit mixes (`K7Q2M9`, `Q8W-3ZK`), never inside URLs, addresses, prices, dates, times, versions or IP addresses. A candidate counts only when words that announce a code (en, de, fr, es, it, pt, nl, pl, sv, ja) stand right before it, right after it, or on the line above or below a code that stands alone. Words that make a number something else (order, invoice, booking, PNR, customer, postal code, discount, phone, meeting…) right before it, or on that neighbouring line, cancel it. In mail whose subject is about meetings, bookings, orders, invoices, receipts or sales, only strong names count (`verification`, `one-time`, `security code`, `Bestätigungscode`, `確認コード`…); a bare "code", "PIN" or "passcode" there is a meeting passcode or a booking code. Letter-digit codes always need a strong name or a label right before them. The best-scored code wins; **two different codes with equal evidence give none**: a wrong code is worse than none.

**Links.** Only in mail about signing in, confirming or resetting. Each `<a href>` (and each URL in the text body, labelled by its own line or the two lines above it) scores by what it says (`Confirm email`, `Sign in`, `Reimposta la password`…) and what its path says (`verify`, `token=`, `reset`, `activate`…). Unsubscribe, privacy, help, settings, tracking, "review activity" and "not you?" links are never chosen. A click-tracking redirect is returned as written when the button says what it does; it is what the user would open.

**Corpus** (`packages/core/test/verification-corpus`, README there): 69 synthetic mails written for this repo (no real personal data, reserved example domains), shaped like real senders' templates: 34 with a code, 10 with a link, 3 with both, 22 hard negatives (meeting passcodes, PNRs, hotel confirmation numbers, customer numbers, sort codes, promo codes, card last-4, tracking links, new-sign-in alerts). Plain, HTML-only, alternative, related and mixed; QP, base64, 8bit, ISO-8859-1; ten languages. The corpus was written by a separate agent that never saw the extractor. **First blind run:** codes 36 of 37 found, but 7 negatives produced a code (precision 84%); links 11 of 13 right and 2 wrong. The rules above (strong names in other-context mail, the neighbouring-line checks, text-link labels, more link words) were added after reading those failures, so today's **100% precision and recall on the corpus is a training score, not a held-out one**. The test (`Verification.test.ts`) demands no wrong answer at all and at least 95% recall for codes and links; new real-world misses should be added as corpus samples first.

**Not done here.** The AI fallback (§3.6 step 2, `Classifier` with Ollama locally) is a follow-up: the deterministic extractor answers every corpus sample, and the fallback must stay optional (PLAN.md §9).

#### 20.22.2 Inbox mode, temporary inboxes and long-poll

Mail to an alias in mode `inbox` is stored instead of forwarded; `both` stores it and forwards it when it can (a forward that can't go, say no verified recipient, still stores; a blocked contact or a loop refuses both). A **temporary inbox** is an inbox alias on a temp-mail domain that stops taking mail at `inboxExpiresAt`.

**Domains.** `ALIAS_TEMP_DOMAINS` (`TempDomains` in core, next to `SharedDomains`): separate registrable domains (PLAN.md §10), refused at cold start if one equals, contains or lies under a shared domain; unset turns temp mail off. `Route` sends every temp-domain address down the forward path without a username (no on-the-fly creation) and a reverse-alias shape there to `unroutable`: temp inboxes are receive-only. Infra verifies each as an SES identity (the receipt rule covers every verified domain) and grants no sending from it. Names are still open (§10); dev and tests use `tmp.test`.

**Encryption at rest: envelope, with the key-encryption key in SSM, not KMS.** The KMS docs say AWS managed keys "cannot [be used] in cryptographic operations directly; the service that creates them uses them on your behalf" (Developer Guide, "AWS KMS keys", read 2026-10-22). App-level envelope encryption with KMS therefore needs a customer managed key: $1/month plus requests, the trap §14.1 lists, and a new AWS dependency whose emulator (fakecloud's KMS) would need verifying first. Instead the key-encryption keys are a `Keyring` in an SSM `SecureString` (`/alias/<stage>/inbox-keys`, read at cold start with `Parameters.keyring`, encrypted by `aws/ssm`), exactly like the reverse-token and image-proxy keys (§20.14), so no new AWS dependency and nothing new to emulate. `Envelope` (`@alias/inbox`):

- per message a fresh random 256-bit data key; body and summary sealed with AES-256-GCM, random 96-bit IVs;
- the data key sealed with the current keyring entry's key-encryption key, derived with HKDF-SHA-256 (`info = alias/inbox/kek/v1`);
- every seal binds alias id, message id and part (`key`/`body`/`summary`) as additional data, so a blob moved to another message or part fails to open;
- WebCrypto (`crypto.subtle`, Node 24/Lambda) does the AES and HKDF; random bytes come from the `Crypto` service.

**Rotation.** The two-step put of §20.14: append the new key (`1:<old>,2:<new>`; it opens, doesn't wrap), then once every container has it, move it first (`2:<new>,1:<old>`). Messages keep the version that wrapped them; nothing is re-encrypted, and a retired key may be removed 30 days (the longest retention) after it stopped wrapping. A leaked key: rotate, and anyone holding it still needs the table and the bucket. Tested: either step's containers open each other's messages, and a removed key can't open its old messages.

**Storage** (`Inbox` in `@alias/inbox`):

| What                                                                                                                              | Where                                                                           | Expiry                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Sealed body (the raw message)                                                                                                     | S3 bucket `alias-inbox-<stage>`, key `inbox/<days>d/<aliasId>/<messageId>`      | lifecycle rule per class: 1, 7 or 30 days                              |
| Wrapped data key, key version, sealed summary (from, subject, preview, code, link, attachment count), size, received/expiry times | DynamoDB `INBOX#<aliasId>` / `MESSAGE#<msg_ulid>` (`MessageRepo`, `Table.spec`) | TTL `expiresAt` = received + retention; readers ignore it from then on |

Nothing in plaintext at rest beyond ids, sizes and times: the subject and the extracted code are in the sealed summary, which is why a list needs no S3 read. Deleting the metadata item destroys the only wrapped data key, so a body S3 hasn't deleted yet can't be read. Retention: one day for temporary inboxes, else the owner's `retentionDays` (1, 7 or 30, `PATCH /v1/aliases/…`, default 7), one S3 class each. Bodies are capped at 10 MiB (`too-large`) and each user may store 500 messages per UTC day (`storage-limited`, `STORED#<day>` quota); both count as blocked and announce `mail.blocked`. The metadata is written in one transaction with a `ConditionCheck` that the alias still exists with this id, like contacts (§20.15), and a refused write deletes the body again: a purge can't miss a message stored meanwhile. The pipeline claims the delivery first (§20.6), so a redelivered event stores nothing twice; a temporary storage failure releases the claim and defers (in `both` mode the store comes first, so a deferred forward may store a second copy, which beats forwarding twice). The OTP extractor (§20.22.1) runs once, at ingest.

**API** (`InboxesGroup` in `@alias/contracts`; session, or a token with the new scopes `inboxes:read`/`inboxes:write`, which reach nothing else: a "temp-only" token for the CLI, CI and assistants, as §20.20 planned):

- `GET /v1/inboxes`: the caller's inbox-mode aliases and live temporary inboxes. Expired temporary inboxes are deleted on the way (tombstone + purge).
- `POST /v1/inboxes { domain?, lifetimeHours? }` (1 to 168 h, default 24): a random 10-character address on a temp domain; 50 per user and UTC day (`TemporaryInboxLimit`, 429). Webhook `alias.created`.
- `DELETE /v1/inboxes/:domain/:local`: temporary inboxes; inbox aliases are deleted through the aliases API, which now purges stored mail too.
- `GET /v1/inboxes/:domain/:local/messages?after=&wait=`: decrypted summaries, newest first, 50 at most. **Long poll:** with `wait` (≤ 25 s, inside the API Lambda's 30 s and CloudFront's 30 s origin timeout) and nothing after `after`, it polls the partition again after 250 ms, doubling to at most every 2 s: about 15 strongly consistent Queries (0.5 RCU each) and 25 s of a 256 MB Lambda per empty wait. A WebSocket (API Gateway) stays the upgrade when that cost matters (§14.2). Message ids are ULIDs generated by the inbound Lambda, so two messages stored in the same millisecond by concurrent invocations may sort either way; a poller that saw one may miss the other until it lists without `after`.
- `GET …/messages/:id`: the whole message, decrypted server-side: headers, text, **sanitized HTML** (sanitize-html allowlist: no scripts, frames, forms, event handlers, `<style>`, `background`, `srcset`, CSS `url()`; links get `target=_blank rel="noopener noreferrer nofollow"`; images only `data:`/`cid:`, remote ones dropped and counted in `blockedImageCount`), attachments listed (not served). Proxied remote images (§20.19) for inbox mail are a follow-up: the API would need the image proxy's keys.
- `DELETE …/messages/:id`: metadata and body.

Stored mail is not counted; refusals (size, daily cap, spam, inactive) count as blocked, as for forwarding. `/v1/aliases` lists no temporary inboxes, and `AliasView` gains `retentionDays`.

**Erasure** (§20.15). Deleting an alias purges `INBOX#<aliasId>` with its contacts (`AliasRepo.purge`), then the API deletes its bodies under every class prefix (`Inbox.purge`, `ListObjectsV2` + `DeleteObject`). Erasing an account collects the user's aliases first, lets `AccountRepo.erase` purge their metadata (and the quotas in the user's partition), then deletes the bodies; a temporary inbox leaves a bare tombstone like any non-subdomain alias, so its address is never handed out again. The erasure journal (§20.15 addendum) needs nothing new: after a point-in-time restore, re-applying the erasure purges the restored metadata again, and S3 isn't restored, so the bodies stay gone (S3 versioning is off; turning it on would need a lifecycle rule for noncurrent versions).

**Emulation.** No new AWS service. New S3 operations from app code (`Objects` in `@alias/aws`: put, get, delete, `ListObjectsV2` across pages) are checked on fakecloud through the production helpers in `tools/aws-emulators`: pages of `MaxKeys` with `IsTruncated` and `NextContinuationToken`, prefix filtering in key order, idempotent delete, `NoSuchKey`, as the S3 API reference documents. The spool helpers (`Inbound`) now use the same functions.

**Infra** (typecheck only): the bucket with three lifecycle rules and a TLS-only policy (S3 encrypts with SSE-S3 by default as well); the inbox keys parameter (put once per stage, the command is in `alchemy.run.ts`); inbound gets `s3:PutObject`/`s3:DeleteObject` on the bucket's objects and `ssm:GetParameter` on the keys; the API gets `s3:GetObject`/`s3:DeleteObject`, `s3:ListBucket` and the keys; `ALIAS_TEMP_DOMAINS`, `ALIAS_INBOX_BUCKET`, `ALIAS_INBOX_KEYS_PARAMETER` in both. The API now builds its services in Lambda's init phase (top-level await), like inbound, so a failed key read fails the init instead of poisoning the container.

**Tests.** Core (`TempDomains`), repository on fakecloud and DynamoDB Local (`MessageRepo`: order, paging after an id, expired ignored, refused for a deleted or recreated alias, delete returns the item, alias deletion purges the partition and leaves a bare tombstone, the daily quota under concurrency; `AliasRepo` temp fields and quota; `AccountRepo` erasure with a temporary inbox and a stored message leaves one more bare tombstone and nothing else), emulator (S3 listing), `@alias/inbox` (envelope round trip, tamper/move/swap refused, rotation; sanitizer; the store on fakecloud: the S3 object is not plaintext, summary, sanitized read, delete, purge, nothing left after a refused write or unreadable bytes), pipeline (inbox, temporary, expired, receive-only, `both`, size and daily caps, spam, redelivery), API (create, list apart from aliases, read sanitized, delete, long poll with the test clock, expiry cleanup, isolation, forward-only aliases aren't inboxes, quota, token scopes, alias deletion and erasure purge S3) and stack (`e2e`: a temp-only token creates a temporary inbox, a long poll waits, SMTP → SES emulator → inbound stores it, the poll returns it with the code in **under 5 s**; the S3 object and the table hold no plaintext; the spool copy is gone; the message reads back decrypted; the token gets 403 on aliases).

**Not verified** (needs AWS): lifecycle expiry timing, the IAM statements, WebCrypto cost on Lambda arm64, long-poll behaviour behind CloudFront (origin timeout and keep-alive), and `ListObjectsV2` paging beyond fakecloud.

### 20.23 OpenAPI, SDK and CLI (2026-10-22)

Phase 8, part 2: the API described, a client for it, and (below, as it lands) a CLI on top.

#### OpenAPI

`openApiDocument` (`packages/contracts/src/OpenApiDocument.ts`) is Effect's `OpenApi.fromApi(Api)` (OpenAPI 3.1) with three additions kept in that one file, so documenting the API never conflicts with changing it: a summary per operation, a description per group (tag), and **token scopes as security requirements**. Effect lists both schemes of the `Authentication` middleware (`session` cookie, `token` bearer) on every authenticated operation; the document narrows `token` to what the `requires`/`anyToken` annotation says: `[{ session: [] }, { token: ["aliases:read"] }]`, `{ token: [] }` for any token, and no `token` alternative at all for session-only operations (tokens, webhooks, erasure). OpenAPI 3.1 allows roles in requirements of non-OAuth schemes; each operation's description repeats the scope for tools that don't show them. `AliasView`'s counters became `Schema.Int` so they document as integers instead of `number | "Infinity" | …`.

The API serves it at `GET /v1/openapi.json` (no credentials: the same document is in the repo). `pnpm openapi` (`scripts/openapi.ts`) writes `packages/contracts/openapi.json`; `pnpm check` regenerates it in memory and fails on any difference, so CI catches a contract change without a regenerated document. A test validates the document against the official OpenAPI 3.1 JSON Schema (`@seriousme/openapi-schema-validator`; it rejects a deliberately broken copy), pins the security requirements of representative operations and checks the served copy equals it.

#### SDK

`@alias/sdk` (`packages/sdk`) is `AliasClient.make({ baseUrl, token })`: `HttpApiClient.make(Api)` with `Authorization: Bearer` added to every request, so methods, payloads and typed errors (`AliasNotFound`, `Forbidden { scope }`…) come from the contract with no generated code. It re-exports the contract (errors, `Scope`, `openApiDocument`). `AliasClient.layer` provides it as a service.

**Publishable, not published.** `pnpm --filter @alias/sdk build` (`vp pack`, run in CI) bundles the contracts and the one core module they import (`@alias/core/Username`, a new subpath export, so the bundle doesn't drag in the mail code) into `dist/index.js` + `dist/index.d.ts`; only `effect` stays external. `publishConfig.exports` points the published package at `dist`, while the workspace keeps importing `src`. The declaration build needs `packages/tsconfig.sdk.json`: tsdown's tsgo runs with `rootDir` = the config's directory, and the inlined sources live next to `sdk/`. Checked by hand: `pnpm pack`, install the tarball into an empty project with TypeScript 7, and typecheck a program using `AliasClient`, `catchTag("Forbidden")` and `instanceof AliasNotFound` with `skipLibCheck: false`.

**No promise facade.** A generic one (map every method to `Effect.runPromise`) can't be typed without an unchecked `as unknown as` (the client's methods are generic over a response mode), which the Effect lint rejects for good reason. Callers without Effect run each call with `Effect.runPromise(client.aliases.list())`; it rejects with the typed error (`packages/sdk/src/index.ts` shows it, a test does it). Everyone else can generate a client from `openapi.json`.

**Tests** (`packages/sdk/test`): the real API behind the function URL emulator on fakecloud (`TestApi.served`, new in `@alias/api/testing`), a token minted in a session, then the SDK over HTTP: create/list/delete, `AliasNotFound` and `Forbidden { scope }` as typed failures, and the same through plain promises.

#### Device login (OAuth 2.0 device authorization grant, RFC 8628)

How `alias login` (and later other clients without a browser) gets a token without the person pasting one.

**Device side** (`OAuthGroup`, `/v1/oauth/*`, form-encoded like every OAuth endpoint, no credentials, `Cache-Control: no-store` on every answer as RFC 6749 §5.1 requires):

1. `POST /device_authorization { client_id, scope }` → `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in: 600, interval: 5 }`. Clients are a fixed list (`DeviceClients`: `alias-cli` → "Alias CLI", public clients, the id names the program); `scope` is space-separated and every entry must be a known `Scope`, else `invalid_client`/`invalid_scope`. The verification URI is the web app's `/device` (the relying party's origin). At most 20 requests per client address and hour (`TooManyAttempts`, 429).
2. `POST /token { grant_type: urn:ietf:params:oauth:grant-type:device_code, device_code, client_id }` answers the RFC's errors (400 with `error`): `authorization_pending`, `slow_down` (polled before the interval was up; the interval grows by 5 s each time, stored on the grant, as §3.5 asks), `access_denied`, `expired_token`, `invalid_grant` (unknown or spent code, or another client's), `unsupported_grant_type`, `invalid_client`. Once approved it answers `{ access_token: "alias_pat_…", token_type: "Bearer", expires_in, scope }`: a personal API token (§20.20) named "Alias CLI (device login)" with exactly the requested scopes, expiring after 90 days (`alias login` again renews it). Unknown device codes count as failed credential attempts against the address, like bad tokens (`AUTHFAIL`, 20 an hour).
3. `POST /revoke { token }` (RFC 7009): the holder revokes its own token; always 200, also for unknown or malformed tokens. This is how `alias logout` works without a session.

The error body is `OAuthError` (`{ _tag: "OAuthError", error, error_description? }`): the `error` member standard OAuth clients read, plus Effect's tag so the typed client decodes it.

**Person side** (`DeviceGroup`, `/v1/device/{lookup,approve,deny}`, session-only: a token can't approve a device login, so tokens can't mint tokens). The code travels in the JSON body, not the URL. The web app's `/device` page (behind the passkey session gate; `?code=` from `verification_uri_complete`) shows the client, the code to compare with the terminal, the requested access in plain words and the 90-day lifetime, a warning to approve only a sign-in you started yourself (the RFC's §5.4 remote-phishing concern), and Approve/Deny. Unknown codes count against the signed-in user, 10 an hour, then every lookup gets 429 (§5.1: with 20⁸ codes and 10-minute lifetimes, guessing a live one is hopeless anyway).

**Codes.** The device code is 256 random bits (base64url), stored only as its SHA-256. The user code is 8 characters from the RFC's 20 consonants (`BCDFGHJKLMNPQRSTVWXZ`, shown `BCDF-GHJK`, case and dashes ignored; `UserCode` in `@alias/core`), drawn by rejection sampling so no letter is likelier than another, redrawn on a collision.

**Storage** (`DeviceRepo`, `Table.spec`): a DeviceGrant item under `DEVICE#<sha256(deviceCode)>` (client, scopes, interval, `nextPollAt`, decision `Pending`/`Approved{userId, username}`/`Denied`, TTL `expiresAt`) and a UserCode item `USERCODE#<code>` pointing at it, written in one transaction (a live code fails it; an expired one TTL hasn't removed is free). A poll is one strongly consistent GetItem plus one conditional UpdateItem on `nextPollAt`, so of two concurrent polls one gets `slow_down`. Redeeming deletes both items (the grant only if still approved) and puts the token in **one** transaction, so a code yields one token however often the device polls. DeviceRequests (`DEVICEAUTH#<sha256(ip)>`) and DeviceMisses (in the user's partition, so erasure removes it) use the `Quota` counters.

**Tests.** Repository on both engines (`deviceRepoSuite`: user-code claims and expiry, decide once and never late, `slow_down` arithmetic, concurrent polls, one token per grant, no redeeming a pending grant, per-source/per-user counters), core (`UserCode`: unbiased mapping, normalising typed input), API handler (`apps/api/test/device.test.ts`: the full flow with lowercase undashed typing, `no-store`, token scopes enforced, spent codes; `slow_down` growth then `access_denied`; expiry; OAuth error codes; both rate limits; wrong-code limit and session-only approval; RFC 7009 revocation), stack (`e2e`: start → approve with a session → poll → token works → revoke over HTTP through the function URL emulator).

#### CLI

`apps/cli` is the `alias` command (`effect/cli`, `bin/alias.ts`), a thin projection of the SDK: every command is one or two typed calls. `--json` prints the same rows as JSON; tables otherwise; failures print one plain sentence (`Errors.ts`: "Your token lacks the recipients:read scope. Run `alias login` again.") and exit 1.

| Command                                                                                       | Calls                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alias login [--api-url URL]`                                                                 | `DeviceLogin.login` (new in the SDK, reusable by other clients): device code → prints `verification_uri_complete` and the code → polls at the server's interval, +5 s per `slow_down` → `GET /v1/me` → saves; revokes the login it replaces |
| `alias logout`                                                                                | `POST /v1/oauth/revoke` (RFC 7009) with the saved token, then forgets it                                                                                                                                                                    |
| `alias whoami`                                                                                | `GET /v1/me`                                                                                                                                                                                                                                |
| `alias aliases list\|create [--domain D \| --address A]\|enable A\|disable A\|delete A --yes` | the aliases endpoints; `create` defaults to a random address on the first shared domain; `delete` refuses without `--yes`                                                                                                                   |
| `alias contacts list A\|block A C\|unblock A C`                                               | contacts by id or address                                                                                                                                                                                                                   |
| `alias recipients list`                                                                       | `GET /v1/recipients`                                                                                                                                                                                                                        |

The token asks for `aliases:read/write`, `contacts:read/write`, `recipients:read`: what the commands need, nothing more (no settings, no recipient changes). `ALIAS_TOKEN` (+ `ALIAS_API_URL`) overrides the saved login, for CI.

**`alias temp` is not there yet.** The temp-mail API (§20.22) wasn't on `main` when this landed; `alias temp --wait --otp` arrives with it, plus its `inboxes:*` scopes in `CLI_SCOPES`.

**Where the token lives: a `0600` file, not the OS keychain.** `$ALIAS_CONFIG_DIR`, else `$XDG_CONFIG_HOME/alias`, else `~/.config/alias` (`credentials.json`, directory `0700`, written to a temporary file and renamed). The keychain options were weighed: `keytar` is archived; `@napi-rs/keyring` is maintained but a native addon, which `bun build --compile` must embed per target (cross-building needs each platform's prebuilt `.node`), and headless Linux (servers, CI) often has no Secret Service at all, so a file fallback is needed anyway; shelling out to `security`/`secret-tool` adds two code paths that tests can't run hermetically. The file is what the AWS CLI does, and what the GitHub CLI falls back to. The risk it leaves (any process of the same user can read it) is bounded by the token: scoped, 90 days, revocable from the web app and by `alias logout`. Revisit if users ask for it.

**Binaries.** Bun comes from mise like every tool (`bun = "1.4.3"`, checksums in `mise.lock`, checked against Bun's published `SHASUMS256.txt`). `pnpm cli:compile [target…]` (`scripts/compile-cli.ts`) runs `bun build --compile --minify` into `apps/cli/dist/alias-<target>` (~70 MB, Bun's runtime included) and, for the machine's own target, starts it: `--version` must match `package.json`, and `whoami` without a login must fail with its message. CI's `cli-binary` job builds both `linux-x64` and `darwin-arm64` on Linux (Bun cross-compiles), smoke-runs the Linux one and uploads both as artifacts; a macOS runner would smoke-run the other, but macOS minutes are billed (the account's spending limit stopped that job), so the darwin binary was checked by hand. Nothing is released.

**Tests** (`apps/cli/test/cli.test.ts`, the commands run in-process against the API Lambda behind the function URL emulator on fakecloud, each with a fresh config directory and a captured console): the full device login (the CLI prints the code, Ada approves it with her passkey session, the test clock passes the 5-second interval) with the token's exact scopes and the file's `0600`/`0700` modes; whoami, logout revoking the token server-side; aliases create/list (table and JSON)/disable/enable/delete with and without `--yes`, errors for unknown aliases and someone else's subdomain; contacts list/block/unblock by address and id; recipients; `ALIAS_TOKEN` and a missing scope; a denied login. Checked by hand once, not in CI: the compiled darwin-arm64 binary, spawned against the same emulated API, logged in through the device flow, created and listed aliases, logged out (token revoked), and then refused `whoami`.

### 20.21 OpenPGP encryption of forwarded mail (2026-10-22)

Phase 6, part 2. A destination (forwarding address) may have an OpenPGP public key; mail forwarded to it is then encrypted as PGP/MIME, so the owner's mail provider stores only ciphertext. Replies from the owner are not touched: they come from the owner's own client. No AWS service is involved, so no emulator was needed.

**Library.** [OpenPGP.js](https://github.com/openpgpjs/openpgpjs) 6.3.2 (Proton; LGPL-3.0-or-later, compatible with AGPL-3.0 when used as an unmodified dependency; no runtime dependencies; RFC 9580 and RFC 4880 keys; the project reports two complete Cure53 audits of earlier versions, none of 6.x yet; CVE-2025-47934, a signature-verification bypass fixed before 6.3.2, doesn't touch encrypt-only use). Alternatives: Sequoia (Rust) and GopenPGP (Go) would need a native or WASM build in the Lambda; `pgpy` and `kbpgp` are unmaintained. **Cost:** the inbound Lambda bundle grows from 1.25 MB to 1.60 MB minified (rolldown, Alchemy's bundler); importing it takes ~5 ms more (45 → 50 ms locally on Apple silicon; expect two to three times that on a Lambda arm64 cold start). Encrypting 1 MiB takes ~7 ms (Curve25519 or RSA-3072). The web app does **not** bundle it: `@alias/core` is now `"sideEffects": false`, and the contracts import only `PgpKey` (the reasons and the size limit), not `Pgp`; without that the web bundle grew by 370 KB.

**Keys** (`Pgp.readKey(armored, now)` in `@alias/core`). At most 64 KiB armored (`PgpKey.MAX_KEY_BYTES`; real keys are 1–15 KB). Refused, with a reason the API returns as `InvalidPublicKey` (400): not a key or garbled armor (`malformed`), more than one key (`multiple-keys`), a private key (`private-key`: never stored, not even its public half; the web app says not to share it), `revoked`, `expired`, and no usable encryption subkey at `now` (`no-encryption-key`, which also covers OpenPGP.js's minimums: RSA under 2047 bits, deprecated curves). Text around the armor is ignored; the key is stored re-armored by OpenPGP.js, with its fingerprint (uppercase hex), user IDs and the earliest of the primary key's and the encryption subkey's expiry.

**Storage.** One map attribute `encryption` on the recipient item (`USER#<id>` / `RECIPIENT#<address>`, `RecipientRepo.setEncryption`/`removeEncryption`, conditional on the recipient's id so a deleted or re-added address isn't touched; suite on fakecloud and DynamoDB Local). No new key or index in `Table.spec`. Account erasure (§20.15) deletes recipient items in its sweep, so the keys go with them; the `AccountRepo` suite seeds a key on both users and checks in a full table scan that only the other user's remains.

**API** (`RecipientsGroup`, scope `recipients:write`): `PUT /v1/recipients/:id/encryption { publicKey, isSubjectHidden }` validates and stores (or replaces) the key; `DELETE /v1/recipients/:id/encryption` removes it. `Recipient.encryption` shows `publicKey` (public, so the web app can prefill it), `fingerprint`, `userIds`, `expiresAt`, `isSubjectHidden` and `isUsable` (false once `expiresAt` has passed). Pending recipients may have a key; mail only goes to verified ones anyway.

**Message format** (`Pgp.encrypt`, RFC 3156 §4). It runs **last** in the forward path, after `Mail.forward` (header rewrite, tracker protection and image proxy, §20.19), so what is encrypted is exactly what the owner would otherwise have received.

- Outside: every header field the rewrite produced stays as it was (`From`/`Reply-To` with the reverse alias, `To`, `Date`, `Message-ID`, `List-*`, `Received`, our `X-Alias-Forwarded` loop marker), so routing, threading, unsubscribe and loop detection keep working. `Content-*` and `MIME-Version` are replaced by `MIME-Version: 1.0` and `multipart/encrypted; protocol="application/pgp-encrypted"`, with the `Version: 1` part and the armored message (`application/octet-stream`, `encrypted.asc`). Line endings follow the message's own.
- Inside: the message's MIME entity, i.e. its `Content-*` fields and its body **byte for byte** (8-bit and binary parts too), so a `multipart/signed` message still verifies after decryption. A message without `Content-Type` stays without it (RFC 2045's `text/plain; charset=us-ascii`). No compression (OpenPGP.js 6's default: compressing attacker-influenced content next to other content is a CRIME-style length oracle), no signature (we can't sign as the sender, and a service signature would mean nothing to the owner).
- Already encrypted mail passes unchanged: `multipart/encrypted`, and S/MIME `application/(x-)pkcs7-mime` with no `smime-type` or an enveloped one. S/MIME signed-data and inline PGP (`-----BEGIN PGP MESSAGE-----` in a text body) are encrypted like other mail: double encryption costs nothing but size, and detecting inline PGP reliably isn't cheap. An inline-PGP output mode for clients without PGP/MIME was skipped: every maintained OpenPGP client reads PGP/MIME.
- Size: armor adds a third. A 25 MiB message (`Limits.maxMessageBytes`) with base64 attachments becomes ~34 MB, under SES's 40 MB.

**Hiding the subject** (`isSubjectHidden`, addy.io's "hide subject"). Researched: RFC 9788 (Header Protection for Cryptographically Protected Email, August 2025, supersedes draft-autocrypt-lamps-protected-headers) and what clients read. Chosen: RFC 9788's `hcp_baseline` — outside, `Subject` becomes `[...]`, `Keywords` and `Comments` are removed; inside, the user-facing fields (`From`, `To`, `Cc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `Keywords`, `Comments`) are copied in front of the entity with one `HP-Outer` field for each that stays outside, and the root `Content-Type` gets both `hp="cipher"` (RFC 9788) and `protected-headers="v1"` (the earlier draft, which Thunderbird, Enigmail, Mailvelope and K-9/Thunderbird for Android read). No Legacy Display Element: RFC 9788 makes it optional and transitional, and it would rewrite the body. Trade-off: RFC 9788 scopes header protection to signed messages, and these aren't signed, so the inner subject is confidential but not authenticated (no worse than the rest of a forwarded mail, which we rewrite anyway). Clients that read neither marker show `[...]`; the owner opted into that.

**Fail closed.** When the stored key no longer encrypts (it expired, or OpenPGP.js refuses it), the pipeline drops the mail as `key-unusable` and counts it as blocked (a `mail.blocked` webhook event fires), and never sends it in the clear. The destinations screen shows "Key expired" before that happens (`isUsable`) and the expiry date in advance. A key revoked after the upload is only noticed if the owner uploads the revocation: nothing fetches keyservers or WKD.

**Web** (§20.16 components, new shadcn `Textarea`): the destination row's menu has "Set up encryption" / "Change encryption" and "Remove key"; the dialog (`/destinations?encryption=<recipient id>`, title "Encrypt mail to this destination") takes a pasted key ("Public key") or a key file ("Key file"), the switch "Encrypt the subject too", and "Save key"; refusals are worded per reason (e.g. the `gpg --export-options export-minimal` hint for large keys). The row shows "Encrypted" or "Key expired", the fingerprint in groups of four, "Subject encrypted too" and the expiry.

**Tests.** Core (`packages/core/test/Pgp.test.ts`): accepted keys and their fingerprint, user IDs and expiry; every refusal reason; judged at the time asked; the forwarded newsletter fixture (after tracker protection) encrypted with CRLF and LF, decrypted with the test private key, equal byte for byte to its MIME entity, with every routing field outside unchanged and nothing of the content readable; hidden subject (`[...]` outside, fields, `HP-Outer` and markers inside, body unchanged); RSA-3072; an expired key fails instead of sending in the clear. Golden corpus (`packages/core/test/corpus/pgp`): `multipart/signed` (the signed part survives byte for byte), no `Content-Type`, S/MIME signed-data, hidden subject (each against a reviewed outer message with the armor masked and a reviewed decrypted payload), and PGP/MIME and S/MIME enveloped mail passing unchanged. Repository on both engines (set, replace, remove, kept across confirm and default, refused for a deleted or re-added recipient; erasure removes it). API handler (stored and listed, only the key kept, replaced, `isUsable` after expiry, removed; every refusal; other users 404, no session 401, a `recipients:read` token 403). Pipeline on fakecloud (PGP/MIME to a recipient with a key and plain again after removal, hidden subject, PGP/MIME passing unchanged, an expired key blocked as `key-unusable` with nothing sent, replies unaffected). Stack (`e2e`): key set over the API → SMTP → SES emulator → inbound Lambda → fakecloud SES holds PGP/MIME with `[...]` outside that decrypts to the subject and body; the owner's reply goes out unencrypted; removing the key forwards in the clear again.

**Cross-checked outside OpenPGP.js** (by hand, not in CI): [Sequoia-PGP](https://sequoia-pgp.org) (`pysequoia`, Rust) generated a key; `Pgp.readKey` accepted it, `Pgp.encrypt` encrypted each corpus case to it, Sequoia decrypted every one to exactly the reviewed payload, and Python's `email` package parsed the outer `multipart/encrypted` structure and the inner messages (including the protected subject).

**Not verified.** Rendering in real clients (Thunderbird, Apple Mail with GPG Suite, Proton Bridge, K-9, Mailvelope): the formats follow RFC 3156 and RFC 9788 and decrypt with two independent implementations, but no client was driven. Cold-start timing on a real Lambda (measured locally only). The web dialog was checked by `vite build` and the type checker, not in a browser (§20.16: the preview browser can't sign in).

### 20.24 MCP authorization server (2026-10-22)

Phase 9: the OAuth 2.1 authorization server MCP clients get their tokens from (part 1), the MCP endpoint with its tools (part 2), and confirm-gated sending (part 3).

**Spec.** MCP revision **2026-07-28**, the current one ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), read 2026-10-22), authorization chapter: OAuth 2.1 (draft-ietf-oauth-v2-1-13), PKCE `S256` required and advertised (`code_challenge_methods_supported`, or clients must refuse), RFC 8414 metadata, RFC 8707 resource indicators, RFC 9207 `iss` in the authorization response, Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00) as the recommended registration (SHOULD), RFC 7591 dynamic registration kept for older clients (deprecated in this revision, MAY), refresh-token rotation required for public clients, redirect URIs `https:` or loopback only.

**Where it lives.** In the API Lambda (`apps/api/src/oauth`), on the web app's origin, which is the issuer. A separate Lambda would need its own copy of sessions, users and the table grants; the authorization server is a handful of DynamoDB calls and shares all of them.

| Endpoint                                                                            | What                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-authorization-server`                                       | RFC 8414 metadata: endpoints, `S256`, `none` client authentication, `authorization_response_iss_parameter_supported`, `client_id_metadata_document_supported`, the scopes              |
| `/oauth/authorize` (web app page)                                                   | The authorization endpoint. Signed out, the passkey login shows in place; then the consent card (§20.16 components) with the client, where the code goes, and a checkbox per scope     |
| `POST /v1/oauth/authorization`, `…/decision` (`ConsentGroup` in `@alias/contracts`) | What the page calls: validate the request for display, then validate again and answer with the redirect (code, `state`, `iss`) or `access_denied`. Session-only, like token management |
| `POST /v1/oauth/register`                                                           | RFC 7591. Public clients only (`token_endpoint_auth_method: none`, whatever was asked), at most 10 redirect URIs, 10 registrations per client address and hour                         |
| `POST /v1/oauth/token` (`OAuthGroup`, shared with §20.23)                           | `authorization_code` (+ `code_verifier`, `Grants.ts`) and `refresh_token`, next to the device code; `Cache-Control: no-store`                                                          |
| `POST /v1/oauth/revoke` (`OAuthGroup`, shared)                                      | RFC 7009; a refresh token revokes its grant, an access token itself, an API token as §20.23 says; always 200                                                                           |
| `GET`/`DELETE /v1/oauth/grants` (session-only)                                      | "Connected apps" in Settings: list and disconnect                                                                                                                                      |

**Clients.** A `client_id` that is an `https:` URL with a path is a metadata document: fetched through the webhooks' `Egress` SSRF guard (`WebhookUrl.check`, public addresses only at connect time, no redirects, 5 s, 5 KiB), its `client_id` must equal the URL, `token_endpoint_auth_method` must be absent or `none`, and every redirect URI allowed. Anything else must be a registered `mcp_<ulid>`. Redirect URIs match exactly, except that a loopback one may name any port (RFC 8252 §7.3). The consent card shows the redirect host, warns for loopback-only clients ("any program here could ask in its name", as the spec's CIMD security section asks) and marks registered clients' names as unverified.

**Request validation** (`Authorize.ts`). Unknown client or redirect URI: an error page, never a redirect (RFC 6749 §4.1.2.1). Otherwise errors go back to the client with `state` and `iss`: `unsupported_response_type`, `invalid_request` without an `S256` challenge (`plain` is refused), `invalid_scope` for a scope that doesn't exist, `invalid_target` for a `resource` other than `<origin>/mcp`. No `scope`: every scope is offered and the user ticks what to grant; the granted set may only shrink.

**Scopes.** The personal-token scopes of §20.20 and §20.18.1 (`aliases`, `contacts`, `domains`, `recipients`, `settings`, each `:read`/`:write`), plus `mail:send` from part 3.

**Tokens and storage** (`OAuthRepo`, `Table.spec`, suite on fakecloud and DynamoDB Local). Codes (`alias_oac_`, 5 minutes), access tokens (`alias_oat_`, 1 hour) and refresh tokens (`alias_ort_`, 30 days, renewed by each refresh) are 256 random bits stored as SHA-256 only, like API tokens, with a prefix secret scanners can match. A **grant** is one client's access to one account. Redeeming a code writes the grant and its first tokens in one transaction that marks the code redeemed; a second redemption revokes that grant (OAuth 2.1 §4.1.3). A refresh writes the next pair in one transaction that marks the old refresh token used; presenting a used one, or two concurrent refreshes, revokes the grant, so a stolen refresh token and its rightful holder can't both go on. An access token authenticates only while its grant exists (one extra GetItem), so disconnecting an app ends it at once. Codes, grants and tokens sit in the user's gsi1 partition `OAUTH#<userId>`, which the account erasure sweep (§20.15) empties in its first step. Failed code and refresh exchanges count against the client address with the API-token failure counter (20 an hour, then `TooManyAttempts`, 429).

**Shared with the device login (§20.23).** One authorization server: the metadata names the device authorization endpoint and all three grant types, and `/v1/oauth/token` and `/v1/oauth/revoke` are §20.23's `OAuthGroup` endpoints (in the OpenAPI document), whose handlers pass `authorization_code`/`refresh_token` and `alias_oat_`/`alias_ort_` tokens to `oauth/Grants.ts`. Their `OAuthError` gained `invalid_target`; the token request lists every grant's fields as optional and each grant checks its own (`invalid_request` when one is missing). The rate limit is the one counter both use. Differences kept on purpose: a device login yields a 90-day personal API token for the API, an MCP grant an hour's access token bound to `<origin>/mcp` and a rotating refresh token, because MCP servers must accept only tokens issued for them.

**Tests.** Core (`OAuth`: the RFC 7636 example verifier, redirect-URI rules and loopback port matching, scope parsing), repository (`OAuthRepo` on both engines: expiry before TTL, single redemption including two concurrent ones, rotation, reuse and concurrent refresh revoke the grant, revocation takes every token, a revoked grant can't rotate; `AccountRepo`: erasure leaves no OAuth item), API handler (`apps/api/test/oauth.test.ts`: metadata, the full code flow with PKCE and rotation, narrower refresh scopes, code reuse, wrong verifier/client/redirect/resource, expiry, RFC 6749 error codes, the failure limit per address, consent details, refusals with and without redirect, user-picked scopes and `access_denied`, session-only endpoints refuse API tokens, disconnecting, RFC 7009, registration rules and its rate limit, metadata documents served from a port-0 host: accepted, impostor, confidential, foreign redirect, missing, and unfetchable URLs).

#### MCP endpoint (part 2)

**Transport choice.** Revision 2026-07-28 made MCP stateless: no `initialize` handshake (each request carries its version and client capabilities in `_meta`), no `Mcp-Session-Id`, no GET stream, no SSE resumption, `server/discover` mandatory, unknown methods `404`, mirrored `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` headers checked against the body (`HeaderMismatch`, `-32020`). That fits a Lambda function URL exactly: any container serves any request. Clients still on 2025-03-26 to 2025-11-25 open with `initialize`; those revisions let a server issue no session ID, so the endpoint is **dual-era and sessionless**: `initialize` answers with the client's version (or 2025-11-25) and no session, later requests are plain JSON-RPC. Every answer is one `application/json` response (allowed by both eras); GET and DELETE get 405, as 2026-07-28 says for older clients' stream and session requests. Server-to-client requests on an SSE stream (2025 elicitation) can't work statelessly and aren't offered; 2026-07-28 replaces them with multi round-trip results, which part 3 uses.

**Why not a library.** Effect 4.0.5 ships `effect/ai/McpServer` with a request-scoped 2026-07-28 transport, but only for sessionless revisions: its 2025 runtimes keep sessions in memory, which breaks across Lambda containers. The official TypeScript SDK (2.3.1) is promise- and zod-based, so every tool would be an `Effect.runPromise` edge inside the Lambda, against "Effect at the edges only". The surface needed is small (`initialize`, `ping`, `server/discover`, `tools/list`, `tools/call`), so `apps/api/src/mcp` implements it with Schema at the boundary, and the official SDK client is the independent check in the stack test.

**Authorization.** A resource server for `<origin>/mcp`: a request needs a live `alias_oat_` access token bound to that resource (RFC 8707), of a grant that still exists and a user who still exists. Without one: 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="…"` (plus `error="invalid_token"` for a bad one), and RFC 9728 metadata at that URL and at the root (`authorization_servers` = the issuer, `scopes_supported` = what the tools need). Personal API tokens are refused: MCP servers must accept only tokens issued for them. A tool whose scope the token lacks gets 403 `error="insufficient_scope"` with the union of the granted scopes and the needed one, which the SDK turns into step-up authorization. Unknown tokens count against the client address like API tokens. Browsers' `Origin` must be the app's own (DNS rebinding, Streamable HTTP "Security").

**Tools** (`Tools.ts`): `list_aliases` (with the domains new aliases can go on), `create_alias` (random on a shared domain, or an address on the user's subdomain or verified custom domain), `set_alias_active`, `list_contacts`, `block_contact`. Each names one scope and describes input and output with Effect Schemas, sent as JSON Schema (`inputSchema`, `outputSchema`) and used to decode the arguments and encode `structuredContent`. They call the same functions as the HTTP handlers (`aliases.ts` and `contacts.ts` now export them), so validation, ownership and webhooks are shared. API errors and bad arguments come back as `isError` results for the model; an unknown tool is `-32602`. Lists are cacheable (`ttlMs`, `cacheScope: "private"`). Temp-mail tools (create a temp address, wait for its OTP) wait for §20.22's API.

**Prompt injection.** Text in results is attacker-controlled more often than it looks: contact names and addresses come from mail headers, and aliases created on the fly (§20.8) have local parts the sender chose. The text content of every tool result is the summary, then the data as JSON between `<untrusted-mail-data>` markers, with every `<` escaped as `\u003c` inside, so no value can close the block; the server instructions and every tool description say to treat that block as data. No tool reads mail content today; the send tool (part 3) is confirm-gated so an injected instruction can't send mail by itself.

**Tests.** API handler (`apps/api/test/mcp.test.ts`): the 401 challenge and resource metadata, invalid and personal tokens, `server/discover` and `tools/list` with their envelopes, every tool as its user, failures as tool errors, the injection fence on a hostile contact name, insufficient scope, header and version validation (`-32020`, `-32022` with the supported list, Base64 `Mcp-Name`), the legacy era (`initialize`, `notifications/initialized` → 202, `ping`, no session ID), 405s, batches and responses refused, a foreign `Origin`, and a disconnected app stopped at once. Stack (`e2e`): the official MCP TypeScript SDK client (`@modelcontextprotocol/client` 2.3.1) gets the 401, discovers both metadata documents, registers, sends the browser to `/oauth/authorize` with PKCE, the signed-in user consents to two scopes, the client checks `iss` and redeems the code, then connects as a 2026-07-28 client (negotiated through `server/discover`) and as a 2025-11-25 one, and creates and lists an alias the web API then shows.

**Connecting clients locally** is in the `alias-dev-stack` skill (Claude Code over HTTP; Claude Desktop through a local stdio bridge, since its remote connectors run in Anthropic's cloud). Neither was driven by hand here: completing the consent needs a passkey in a real browser.

#### Confirm-gated send (part 3)

**What the spec offers** (2026-07-28). Server-to-client requests are gone; a tool that needs the user returns an `InputRequiredResult` (`resultType: "input_required"`) with `inputRequests` (here one `elicitation/create`) and an opaque `requestState`, and the client retries the call with `inputResponses` and the same `requestState` (multi round-trip requests, MRTR). Elicitation has a **form** mode (the client collects an answer) and a **URL** mode (the client shows its user a link and its host, gets consent, opens it; the outcome is learned on the retry). A form "yes" is answered by the client, which a prompt-injected or careless client could fake; a URL opens our own page, where only the signed-in user can act. Servers must not request modes a client didn't declare, and must treat `requestState` as attacker-controlled.

**Design: drafts only the user sends.** The MCP side can only draft; nothing a token does sends mail.

1. `send_mail` (`mail:send`) takes an alias of the user, a contact of that alias (by id), a subject (≤ 128) and a plain-text body (≤ 20,000). Only contacts: the people the user can already reply to through reverse aliases, so a hijacked assistant can't mail strangers. The alias must be active, the contact not blocked. It stores a **draft** (`OutboxRepo`, `USER#<userId>` / `DRAFT#<id>`, pending for an hour, kept a day) and sends nothing.
2. A 2026-07-28 client that declared `elicitation.url` gets `input_required` with a URL elicitation to `<origin>/outbox/<draftId>` and `requestState` = the draft id. Any other client (legacy, or modern without URL mode) gets the draft with `approveAt`, the same link, to hand the user, and `get_send_status` tells the outcome later.
3. The web page (`/outbox/$draftId`, signed in, §20.16 components) shows from, to, subject and the exact text, and names the connected app that drafted it. **Send** and **Discard** are session-only endpoints (`OutboxGroup`: `GET /v1/outbox/:id`, `POST …/send`, `POST …/discard`); no token reaches them, `mail:send` included.
4. On the retry, the server reads the draft named by `requestState` only if it is the caller's and holds exactly the retried arguments (tampering can only fail the call); `sent`, `discarded` or `expired` finish the call; a client-side decline discards the draft; still pending asks again.

**Sending.** Send re-checks the alias (active, same alias) and contact (still there, not blocked), counts one against 50 sends per user and UTC day (`SENDS#<date>`, the `Quota` helper), moves the draft out of `pending` with a conditional update (so two clicks or two tabs send once), then sends through `Transport` from the alias to the contact's address, tagged `reply` (a message to a contact: bounces suppress, complaints mark nothing, as for replies, §20.11). If SES refuses or is unavailable the draft goes back to pending. The message is `Mail.compose` (core): `From` the alias, a fresh `Message-ID` on the alias's domain, the subject one sanitized header line (encoded-words when not ASCII), the body UTF-8 in base64, so neither can inject header lines. The API Lambda gets the same `SendFromAliasDomains` statement as the inbound one.

**Tests.** Core (`Compose.test.ts`: headers, a hostile subject and body, encoded-word subjects, line lengths), repository (`OutboxRepo` on both engines: per-user drafts and TTL, one send under a three-way race, lapse after the hour, reopen only after a send, the daily count; `AccountRepo`: erasure takes drafts and counts), API handler (`apps/api/test/outbox.test.ts`: drafted but unsent, sent from the web once with the message checked on fakecloud, tokens with `mail:send` and the OAuth token refused at the send endpoint, MRTR ask → accept while pending asks again → sent, decline discards, `requestState` with other arguments, of nobody's draft and of another user's draft refused, blocked contact and deactivated alias, lapse, the daily cap, discard, the scope), stack (`e2e`: Grace mails the alias over SMTP and becomes a contact; the official SDK client, connected with `contacts:read mail:send`, lists contacts and calls `send_mail`; its URL-elicitation handler, standing in for the user, sends the draft through the web API and accepts; the SDK retries with `requestState` and gets `sent`; Grace's mail comes from the alias and doesn't name the owner's mailbox).

**Not done.** Mail to new addresses (not contacts) and attachments. HTML bodies. A temp-mail tool that waits for an OTP waits for §20.22.

## Sources

- Cloudflare: [Email Routing subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/) · [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) · [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) · [Local dev: routing](https://developers.cloudflare.com/email-service/local-development/routing/) · [Local dev: sending](https://developers.cloudflare.com/email-service/local-development/sending/) · [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [Email for agents (beta)](https://blog.cloudflare.com/email-for-agents/) · [Community: subdomain wildcard](https://community.cloudflare.com/t/email-routing-subdomain-wildcard/705061)
- MCP (read 2026-10-22): [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) · [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) · [Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration) · [Authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) · [OAuth 2.1 draft 13](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13) · [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636) · [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) · [RFC 7591](https://www.rfc-editor.org/rfc/rfc7591) · [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) · [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) · [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707) · [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207) · [Client ID Metadata Documents draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)
- AWS reputation: [SES sending review FAQ (thresholds)](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html) · [SES reputation alarms](https://docs.aws.amazon.com/ses/latest/dg/reputationdashboard-cloudwatch-alarm.html) · [Per-configuration-set reputation metrics](https://docs.aws.amazon.com/ses/latest/dg/monitoring-sender-reputation-pausing-configuration-set.html) · [CloudWatch alarm → SNS, confused deputy](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Notify_Users_Alarm_Changes.html) · [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)
- AWS: [Receipt rules & recipient matching](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-receipt-rules-console-walkthrough.html) · [SES endpoints & receiving regions](https://docs.aws.amazon.com/general/latest/gr/ses.html) · [SES quotas](https://docs.aws.amazon.com/ses/latest/DeveloperGuide/quotas.html) · [Identities (subdomain inheritance)](https://docs.aws.eu/ses/latest/dg/creating-identities.html) · [SES pricing](https://aws.amazon.com/ses/pricing/)
- Emulators: [LocalStack SES (receipt rules mocked)](https://docs.localstack.cloud/aws/services/ses/) · [LocalStack forum on SES→S3](https://discuss.localstack.cloud/t/is-it-possible-to-forward-ses-emails-into-an-s3-bucket/147) · [LocalStack single image / auth token](https://blog.localstack.cloud/localstack-single-image-next-steps/) · [moto SES](https://docs.getmoto.org/en/latest/docs/services/ses.html) · [moto SESv2](https://docs.getmoto.org/en/latest/docs/services/sesv2.html) · [Floci](https://github.com/askrella/floci)
- Plan B MX: [Fly.io inbound SMTP](https://community.fly.io/t/inbound-smtp-server-ports-25-465-587-on-a-fly-app/28000) · [Fly.io outbound port 25](https://community.fly.io/t/outbound-port-25-direct-to-mx-smtp-blocked-by-default-on-new-accounts/28537)
- Future/tips: [oxlint-plugin-effect](https://github.com/mpsuesser/oxlint-plugin-effect) · [Bitwarden generator](https://bitwarden.com/help/generator/) · [Passkey PRF](https://www.corbado.com/blog/passkeys-prf-webauthn) · [SES Mail Manager Apr 2026](https://aws.amazon.com/about-aws/whats-new/2026/04/ses-mail-manager-introduces-new-features) · [SES deliverability May 2026](https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-ses-global-deliverability/) · [DMARCbis](https://dmarc.org/2026/05/ietf-publishes-updated-dmarc-specification/) · [Lambda durable functions](https://aws.amazon.com/about-aws/whats-new/2025/12/lambda-durable-multi-step-applications-ai-workflows/) · [Agent email APIs](https://mastra.ai/blog/best-ai-agent-email-providers) · [JMAP/Stalwart](https://stalw.art/blog/roadmap/)
- DNS over HTTPS: [Cloudflare DoH JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/) · [Google DoH JSON API](https://developers.google.com/speed/public-dns/docs/doh/json) · [RFC 8484](https://www.rfc-editor.org/rfc/rfc8484) · SES: [CreateEmailIdentity](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_CreateEmailIdentity.html) · [GetEmailIdentity](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetEmailIdentity.html) · [DkimAttributes](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_DkimAttributes.html) · [Custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html) · [Receiving MX](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-mx-record.html)
- Custom-domain UX: [Full setup steps](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/) · [DNS quick scan](https://developers.cloudflare.com/dns/zone-setups/reference/dns-quick-scan/) · [Import/export records](https://developers.cloudflare.com/dns/manage-dns-records/how-to/import-and-export/) · [Registrar FAQ](https://developers.cloudflare.com/registrar/faq/) · [Cloudflare Domain Connect](https://developers.cloudflare.com/dns/reference/domain-connect/) · [Domain Connect providers](https://www.domainconnect.org/dns-providers/)
- Cloudflare zones: [DNS setups](https://developers.cloudflare.com/dns/zone-setups/) · [Partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/) · [Subdomain setup](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/) · [Add multiple sites (limits)](https://developers.cloudflare.com/fundamentals/manage-domains/add-multiple-sites-automation/) · [Zone status](https://developers.cloudflare.com/dns/zone-setups/reference/domain-status/) · [Email Service domains](https://developers.cloudflare.com/email-service/configuration/domains/) · [Account-level DNS quota](https://developers.cloudflare.com/changelog/post/2026-06-10-account-level-record-quota/)
- Cloudflare email limits: [Email Service subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/) · [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) · [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) · [Cloudflare SaaS use cases](https://developers.cloudflare.com/use-cases/saas/)
- Hyperdrive & DynamoDB: [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) · [Hyperdrive supported databases](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) · [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/) · [DynamoDB Local](https://docs.amazonaws.cn/en_us/amazondynamodb/latest/developerguide/DynamoDBLocal.html) · [Floci](https://github.com/floci-io/floci) · [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- AWS pricing: [AWS Price List API (eu-west-1 offers)](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json) · [AWS Free Tier 2026 changes](https://builder.aws.com/content/3IQ2c19Fk9N0wQdSXz5zvpp4QwK/what-aws-actually-gives-you-for-free-in-2026-and-how-to-set-it-up-right) · [CloudFront flat-rate plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html) · [DSQL endpoints & regions](https://docs.aws.amazon.com/general/latest/gr/dsql.html) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- Database: [Aurora DSQL pricing](https://aws.amazon.com/rds/aurora/dsql/pricing/) · [DSQL unsupported features](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-unsupported-features.html) · [DSQL auth tokens](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/authentication-authorization.html) · [LocalStack DSQL](https://docs.localstack.cloud/aws/services/dsql/) · [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- Toolchain: [Vite+ 1.0](https://voidzero.dev/posts/announcing-vite-plus-1-0) · [vp check](https://viteplus.dev/guide/check) · [vp run](https://viteplus.dev/guide/run) · [vp env](https://viteplus.dev/guide/env) · [vp test](https://viteplus.dev/guide/test) · [workers-sdk: Vitest 5 support #15618](https://github.com/cloudflare/workers-sdk/issues/15618) · [#16331](https://github.com/cloudflare/workers-sdk/issues/16331) · [pstack deep dive](https://flaviocopes.com/pstack)
- Stack & workflow: [Effect v4 RC/stable recap](https://effect.website/blog/effect-v4-rc-september-recap) · [This Week in Effect](https://effect.website/blog) · [@effect/tsgo](https://github.com/Effect-TS/tsgo) · [AtomHttpApi](https://effect.website/docs/v4/api/effect/unstable/reactivity/AtomHttpApi) · [@effect/sql-d1 D1Client](https://effect.website/docs/v4/api/sql-d1/D1Client) · [TypeScript 7.0 RC](https://visualstudiomagazine.com/articles/2026/06/22/typescript-7-0-rc-moves-microsofts-go-rewrite-into-the-mainline-compiler.aspx) · [Oxlint type-aware stable](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable) · [TanStack Form v1](https://tanstack.com/blog/announcing-tanstack-form-v1) · [Alchemy v2](https://alchemy.run/llms.txt) · [Rat Stack](https://ratstack.sh/) · [rat-stack repo](https://github.com/joelhooks/rat-stack) · [pstack](https://github.com/backnotprop/pstack) · [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/get-started.md) · [Worktrees don't isolate runtime](https://noqta.tn/en/blog/git-worktrees-parallel-ai-coding-agents-guide-2026)
