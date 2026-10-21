# Alias

Open-source, privacy-first email aliases: forward, reply, temp inboxes, and OTP extraction. It's built to run almost free on AWS (SES, Lambda, DynamoDB, S3) in eu-west-1.

> Alias is in early development (phase 1, foundations). See [PLAN.md](PLAN.md).

## Quick start

```sh
mise install       # Node, pnpm, Java 17, fakecloud (pinned in mise.toml and mise.lock)
pnpm agent:setup   # install deps, claim this worktree's ports, write .dev/env
pnpm dev           # runs web, api, and the DynamoDB and SES emulators locally, with no cloud account or Docker
pnpm test          # all suites
```

Tools come from [mise](https://mise.jdx.dev), and mise is required. `mise install` provides Node 24, pnpm, Java 17 (for Amazon DynamoDB Local), and fakecloud (an S3 and DynamoDB emulator).

## License

[AGPL-3.0](LICENSE). Vendored agent skills in `.agents/skills` come from [pstack](https://github.com/backnotprop/pstack) (MIT).
