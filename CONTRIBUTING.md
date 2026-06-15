# Contributing to ORC

Thanks for your interest in improving ORC! This guide covers the essentials. For the full
architecture and development reference, see [AGENTS.md](AGENTS.md).

## Prerequisites

- [Bun](https://bun.sh) >= 1.1 (the project uses Bun workspaces, native SQLite, and the Bun test runner — not npm/pnpm/node)

## Setup

```bash
git clone https://github.com/niradler/orc
cd orc
bun install
```

Create a `.env` at the repo root (see [.env.example](.env.example)):

```env
ORC_API_PORT=7701
ORC_WEB_PORT=3077
```

## Development

```bash
bun dev          # API + CLI + web in dev mode
bun typecheck    # typecheck all packages
bun check        # biome lint + format (auto-fix)
bun test         # run all tests
bun build        # build all packages
```

## Before opening a PR

1. `bun check` — lint and format must be clean
2. `bun typecheck` — no type errors
3. `bun test` — all tests pass
4. Add or update tests for behavior changes
5. Keep all `package.json` versions aligned — every package (root + workspaces) shares the same version; patch-bump them together

## Conventions

- TypeScript strict, ESM only
- No barrel re-exports — import directly from the package entry or specific module
- Zod schemas define the contract (API routes, config, CLI args all derive from Zod)
- Shared types live in `@orc/core/types`
- IDs are ULIDs (`ulid()` from `@orc/core/ids`)
- No comments unless explaining non-obvious intent
- Biome for all linting/formatting

## Reporting bugs / requesting features

Open an issue at https://github.com/niradler/orc/issues. For security issues, see [SECURITY.md](SECURITY.md).
