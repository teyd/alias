# Alias

Open-source, privacy-first email aliases: forward, reply, temp inboxes, and OTP extraction. It's built to run almost free on AWS (SES, Lambda, DynamoDB, S3) in eu-west-1.

> Status: early development (phase 1, foundations). See [PLAN.md](PLAN.md).

## Quick start

```sh
mise install       # Node, pnpm, Java 17, fakecloud (pinned in mise.toml / mise.lock)
pnpm agent:setup   # install deps, claim this worktree's ports, write .dev/env
pnpm dev           # web + api + DynamoDB + SES emulators, fully local: no cloud account, no Docker
pnpm test          # all suites
```

Tools come from [mise](https://mise.jdx.dev): `mise install` provides Node 24, pnpm, Java 17 (for Amazon DynamoDB Local) and fakecloud (S3 + DynamoDB emulator). mise is required.

## License

[AGPL-3.0](LICENSE). Vendored agent skills in `.agents/skills` come from [pstack](https://github.com/backnotprop/pstack) (MIT).
