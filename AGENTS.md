# orc — Agent Guide

Human + AI orchestration hub. Persistent memory · Task management (HITL) · Generic job runner · Telegram bridge · MCP server.

## Repo Layout

```
packages/
  core/     @orc/core    — config (Zod), types, logger, ULID IDs
  db/       @orc/db      — Drizzle ORM schema + SQLite client (~/.orc/orc.db)
  api/      @orc/api     — Hono REST API + auto-generated OpenAPI spec (:7700)
  sdk/      @orc/sdk     — typed HTTP client generated from OpenAPI spec
  cli/      @orc/cli     — commander CLI (`orc` binary) using the SDK
  mcp/      @orc/mcp     — MCP server (stdio) for Claude/Cursor/Codex/Gemini
  runner/   @orc/runner  — job executor + cron/repeat/watch scheduler
  bridge/   @orc/bridge  — Telegram HITL bridge (Grammy)
```

Data flow: `Agent → MCP → API → DB`. CLI goes via `CLI → SDK → API → DB`.

## Tech Stack

- **Runtime**: Bun (single binary, native SQLite)
- **Language**: TypeScript strict, ESM
- **API**: Hono + `@hono/zod-openapi`
- **DB**: `bun:sqlite` + Drizzle ORM
- **Linting/formatting**: Biome (`biome check --write`)
- **Package manager**: Bun workspaces (`bun install`, NOT pnpm/npm)

## Key Commands

```bash
bun install          # install all workspace deps
bun dev              # API + CLI in dev mode
bun typecheck        # typecheck all packages
bun check            # biome lint + format (auto-fix)
bun db:push          # push Drizzle schema to SQLite (dev)
bun db:generate      # generate migration files
bun sdk:generate     # regenerate SDK types (API must be running)
bun build            # build all packages
```

## Core Data Model (packages/db/src/schema.ts)

| Table | Purpose |
|---|---|
| `tasks` | Work items with HITL review flow |
| `memories` | FTS5-indexed key/value knowledge store |
| `jobs` / `job_runs` | Scheduled/triggered command execution |
| `sessions` | Agent session logs + snapshots |
| `projects` | Optional grouping for tasks/memories |
| `prompts` | Prompt/skill templates |
| `bridge_chats/messages/permissions` | Telegram bridge HITL |

**Task status flow**: `todo → doing → review → done/changes_requested → doing → …`

**Task priorities**: `low | normal | high | critical`

**Job trigger types**: `one-shot | cron | repeat | watch | webhook | manual | bridge-msg`

## MCP Tools (packages/mcp/src/tools.ts)

Call `context_layer1` first in every session — it returns active tasks + recent memory in ~200 tokens.

| Tool | When to use |
|---|---|
| `context_layer1` | Session start — compact overview |
| `memory_search` | Find facts/decisions (BM25 FTS5) |
| `memory_timeline` | Get chronological context around a memory ID |
| `memory_get` | Fetch full content for specific IDs (expensive — filter first) |
| `memory_store` | Persist a fact, decision, or context entry |
| `task_list` | List active tasks (compact, no body) |
| `task_get` | Fetch full task details by ID |
| `task_create` | Create a task |
| `task_update` | Update status/priority/body |
| `task_submit_review` | Trigger HITL checkpoint → sets status=review, pings Telegram |
| `task_check_review` | Poll review result: `pending | approved | changes_requested` |
| `job_list` | List all jobs + last run status |
| `job_run` | Trigger a job by name |
| `job_status` | Get run status/exit code/error for a run ID |
| `session_event` | Record file edit, decision, git op for continuity |
| `session_snapshot` | Build ≤2KB XML snapshot (call from PreCompact hook) |
| `session_restore` | Restore session after compaction or restart |
| `session_log` | Log session summary at end of work unit |

## Config

Priority order (later wins): `~/.orc/config.json` → `./.orc/config.json` → env vars.

Key env vars: `ORC_DB_PATH`, `ORC_API_PORT` (default 7700), `ORC_API_SECRET`, `ORC_TELEGRAM_TOKEN`, `ORC_LOG_LEVEL`.

## Coding Conventions

- **No barrel re-exports** — import directly from the package entry or specific module
- **Zod schemas define the contract** — API routes, config, and CLI args all derive from Zod
- **Types live in `@orc/core/types`** — shared enums/types are defined once there
- **IDs are ULIDs** — use `ulid()` from `@orc/core/ids`
- **No comments** unless explaining non-obvious intent
- **Biome** for all linting/formatting — run `bun check` before committing

## Adding a New MCP Tool

1. Add the tool definition (name, description, `inputSchema`) to `toolDefinitions` in `packages/mcp/src/tools.ts`
2. Add the matching `case` in `executeTool`
3. Add the matching API route in `packages/api/src/server.ts` if persistence is needed
4. Regenerate SDK: `bun sdk:generate` (API must be running)

## Session Protocol for Agents

1. Call `context_layer1` at session start
2. Use `session_event` to record significant actions (file edits, decisions, git ops)
3. Call `session_snapshot` before context window compacts (PreCompact hook)
4. Call `session_restore` after restart/compaction
5. Call `session_log` when a unit of work is complete
