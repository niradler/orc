---
name: orc-dev
description: Use when developing or contributing to the ORC codebase itself — adding MCP tools, CLI commands, API routes, gateway features, database schema changes, or hook scripts. Trigger when working inside C:\Projects\orc, when adding new ORC features, debugging ORC internals, running ORC tests, or understanding the ORC package architecture.
---

# ORC Development Guide

ORC is a Bun monorepo with 10 packages. Data flow: `Agent → MCP → API → DB`. CLI: `CLI → SDK → API → DB`.

## Packages

```
core/     — Config (Zod), types, logger, ULID IDs
db/       — Drizzle ORM + bun:sqlite (~/.orc/orc.db)
api/      — Hono REST API + OpenAPI (:7700)
sdk/      — Typed HTTP client (auto-gen from OpenAPI)
cli/      — Commander CLI (`orc`)
mcp/      — MCP server (stdio), 20 tools
runner/   — Job executor + cron/watch scheduler
gateway/  — Telegram + Slack + agent runtime
tui/      — Terminal UI (React + OpenTUI, in-progress)
```

Dependency direction: `core ← db ← api ← sdk ← cli/mcp/runner/gateway`

## Key Commands

```bash
bun install && bun dev          # Install + start dev
bun test                        # All tests
bun typecheck                   # Type check
bun check                       # Biome lint + format
bun db:push                     # Push schema to SQLite
bun sdk:generate                # Regen SDK (API must be running)
```

## Adding MCP Tools

1. Add definition (name, description, inputSchema) to `packages/mcp/src/tools.ts`
2. Add matching `case` in `executeTool`
3. Add API route in `packages/api/src/routes/` if persistence needed
4. `bun sdk:generate`

## Adding CLI Commands

1. Create `packages/cli/src/commands/mycommand.ts`
2. Register in `packages/cli/src/index.ts`
3. `bun sdk:generate` if new API routes

## Adding API Routes

Hono + Zod in `packages/api/src/routes/`. Register in `server.ts`. Then `bun sdk:generate`.

## Database Schema

`packages/db/src/schema.ts` (Drizzle). All IDs are ULIDs (`generateId` from `@orc/core/ids`). Timestamps: `integer` with `mode: "timestamp_ms"`. After changes: `bun db:generate && bun db:push`.

## Conventions

- No barrel re-exports — import directly
- Zod schemas define the contract
- Types in `@orc/core/types`
- IDs are ULIDs
- No comments unless non-obvious
- Biome for lint/format — `bun check`

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting `sdk:generate` | Always after API changes |
| UUID instead of ULID | `import { generateId } from "@orc/core/ids"` |
| Direct DB from CLI | CLI → SDK → API → DB; never skip layers |
| Large hooks | Keep under 100 lines, fast |
