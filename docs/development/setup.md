# Run locally

How to run ORC from source with hot reload.

## Prerequisites

| Tool | Version |
| --- | --- |
| [Bun](https://bun.sh) | >= 1.4.4 |
| Git | any recent |
| [GitHub CLI](https://cli.github.com) | for issues and PRs |

## Install

```bash
git clone https://github.com/niradler/orc
cd orc
bun install
cp .env.example .env
```

`bun install` also points Git at `.githooks/`, so every commit runs the local checks.

The dev ports in `.env` keep source servers away from an installed ORC on `7700`:

```env
ORC_API_PORT=7701
ORC_WEB_PORT=3077
```

## Start the dev servers

```bash
bun dev
```

| Service | URL | Notes |
| --- | --- | --- |
| API, MCP | http://127.0.0.1:7701 | Hot reload. OpenAPI at `/openapi.json`, Swagger at `/docs`, MCP at `/mcp` |
| Web dashboard | http://127.0.0.1:3077 | Vite with hot reload, proxies `/api` to the API |

Run one piece at a time:

```bash
bun run --filter @orc/api dev
bun run --filter @orc/web dev
bun run --filter @orc/desktop dev             # desktop app (Electron)
cd packages/cli && bun --env-file ../../.env src/index.ts task list   # CLI from source
```

::: warning Use source servers, not the installed daemon
`orc daemon start` runs the published binary on `7700`, not your changes. Check a port is free before starting: `lsof -iTCP:7701 -sTCP:LISTEN`.
:::

## Keep your data separate

Dev servers use the same `~/.orc/orc.db` as an installed ORC unless you point them elsewhere:

```bash
ORC_DB_PATH=/tmp/orc-dev.db bun dev
```

## Worktrees

Create Git worktrees under `.orc/worktrees/<name>`, `.claude/worktrees/<name>` (Claude Code) or `~/.codex/worktrees/` (Codex), never beside the repo.

```bash
git worktree add .orc/worktrees/session-resume -b fix/session-resume
```

## Troubleshooting

Stuck ports, Windows process trees, zombie sockets and web build internals are covered in the [development reference](https://github.com/niradler/orc/blob/master/docs/internal/development-reference.md).
