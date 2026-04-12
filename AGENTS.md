# orc — Agent Guide

Human + AI orchestration hub. Persistent memory · Task management (HITL) · Generic job runner · Telegram bridge · MCP server.

## Repo Layout

```
packages/
  core/           @orc/core           — config (Zod), types, logger, ULID IDs
  db/             @orc/db             — Drizzle ORM schema + SQLite client (~/.orc/orc.db)
  api/            @orc/api            — Hono REST API + auto-generated OpenAPI spec (:7701)
  sdk/            @orc/sdk            — typed HTTP client generated from OpenAPI spec
  cli/            @orc/cli            — commander CLI (`orc` binary) using the SDK
  mcp/            @orc/mcp            — MCP server (stdio) for Claude/Cursor/Codex/Gemini
  runner/         @orc/runner         — job executor + cron/watch/one-shot scheduler + task loop
  gateway/        @orc/gateway        — multi-channel gateway (Telegram, Slack) + agent sessions
  agent-runtime/  @orc/agent-runtime  — shared agent backend registry (claude, acpx, a2a)
  task-service/   @orc/task-service   — task status transitions, side-effects, comments
  tui/            @orc/tui            — terminal UI (in-progress)
  web/            @orc/web            — React dashboard (Vite + Tailwind + shadcn + React Query)
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
bun dev              # API + CLI + web in dev mode (reads .env)
bun typecheck        # typecheck all packages
bun check            # biome lint + format (auto-fix)
bun test             # run all tests (91 passing)
bun db:push          # push Drizzle schema to SQLite (dev)
bun db:generate      # generate migration files
bun sdk:generate     # regenerate SDK types (API must be running)
bun build            # build all packages
```

## Dev Environment

All packages load `../../.env` via `bun --env-file ../../.env` in their `dev` scripts. Create `.env` at the repo root:

```env
ORC_API_PORT=7701
ORC_WEB_PORT=3000
```

Default ports when `.env` is absent: API → 7700, web → 9742.

The web dev server proxies `/api/*` → `http://localhost:$ORC_API_PORT` (strips the `/api` prefix). The API auth secret defaults to `""` (open). Set `ORC_API_SECRET` or `api.secret` in `~/.orc/config.json` to require a Bearer token.

## Web Dashboard (packages/web)

React SPA served by Vite at `ORC_WEB_PORT` (default 3000 from `.env`).

- **API client**: `packages/web/src/api/client.ts` — all requests go through Vite proxy at `/api`
- **Hooks**: `packages/web/src/hooks/` — React Query wrappers (30s refetch interval)
- **Views**: Tasks, Dashboard, Jobs, Memories, Projects, Sessions, Knowledge, Settings
- **API limit**: task list max is 100 per request (API enforces `max: 100` via Zod)

## Testing the Web UI with agent-browser

Use `agent-browser` (installed via `agent-browser install`) to drive a real browser for UI sanity checks:

```bash
agent-browser open http://localhost:3000   # open the web app
agent-browser snapshot                     # get accessibility tree with refs
agent-browser click @e5                    # click by ref from snapshot
agent-browser fill @e3 "value"             # fill input by ref
agent-browser get text @e1                 # read text by ref
agent-browser screenshot path/to/out.png   # capture screenshot
agent-browser close                        # close browser
```

Refs (`@e1`, `@e2`, …) are assigned per snapshot — always take a fresh snapshot after navigation before using refs. Check for `[OBJECT OBJECT]` or `RETRY` buttons in snapshots as signals of error states.

## Core Data Model (packages/db/src/schema.ts)

| Table | Purpose |
|---|---|
| `tasks` | Work items with HITL review flow |
| `comments` | Polymorphic comments (`resource_type` + `resource_id`) for tasks, projects, etc. |
| `memories` | FTS5-indexed key/value knowledge store |
| `jobs` / `job_runs` | Scheduled/triggered command execution |
| `sessions` | Agent session logs + snapshots (`agent_version`, `job_run_id`) |
| `projects` | Optional grouping for tasks/memories |
| `skills` | Workflow skill templates (filesystem-based, `skills/*/SKILL.md` + `~/.orc/skills/`) |
| `bridge_chats/messages/permissions` | Gateway HITL (Telegram/Slack) |

**Task status flow**: `todo → queued → doing → blocked → review → done/changes_requested → doing → …`

Additional statuses: `queued` (claimed by task loop, waiting to start), `paused` (exceeded review rounds or manually paused)

**Task priorities**: `low | normal | high | critical`

**Job trigger types**: `one-shot | cron | watch | webhook | manual | bridge-msg`

> `repeat` was removed — use `cron` with a 6-field expression for sub-minute intervals (e.g. `*/30 * * * * *` = every 30 s).

## MCP Tools (20 tools in packages/mcp/src/tools.ts)

**Call `context` first in every session** — returns active tasks + key memories in ~200 tokens.

All tools that accept `project` take a **readable project name** (e.g. `"orc"`), not a ULID. Omit to use `activeProject` from config.

For CRUD operations not in MCP (delete, project management, job creation), use the `orc` CLI.

| Tool | When to use |
|---|---|
| `context` | Session start — compact overview. Pass `project: "name"` to scope. |
| `memory_search` | Find facts/decisions — 3-layer BM25. Pass `project` to scope. |
| `memory_get` | Fetch full content for specific IDs. Batch multiple IDs. Token-expensive — filter first. |
| `memory_store` | Store a fact/decision/rule/event/discovery. Pass `project` to associate. Source auto-detected from agent env. |
| `memory_update` | Update an existing memory by ID (partial). Preserves created_at and access_count. Prefer over delete+recreate. |
| `search` | Unified search across tasks and memories. Use instead of separate calls. |
| `task_list` | List active tasks (compact, no body). Pass `project` to filter. |
| `task_get` | Fetch full task details by ID |
| `task_create` | Create a task. Pass `project` to scope. Set `agent_backend` to route to a specific agent runtime. |
| `task_update` | Update status/priority/body |
| `task_batch_create` | Create multiple tasks with dependency links atomically. |
| `job_list` | List all jobs + last run status. Pass `project` to filter. |
| `job_run` | Trigger a job by name |
| `job_status` | Get run status/exit code/error for a run ID |
| `project_list` | Discover all projects (name, status, description) |
| `skill_list` | Discover available skills. Filter by tags. |
| `skill_read` | Load full skill content by name. Shows skill directory path + reference file paths — use Read to load them. |
| `session_event` | Record significant action (file, task, decision, error, git, env, rule, plan). Deduped automatically. |
| `session_snapshot` | Build ≤2KB XML snapshot — priority-tiered (P1: files/tasks, P2: decisions/git, P3: intent) |
| `session_restore` | Restore session after compaction or agent restart |
| `session_log` | Log session summary at end of work unit. Pass `project` to associate. |

### Memory types

Use the `type` field in `memory_store` — it affects scoring in `context`:

| Type | Score weight | Use for |
|---|---|---|
| `rule` | HIGH | Conventions: "all IDs are ULIDs", "never use `any`" |
| `decision` | HIGH | Choices: "use PostgreSQL because of concurrent writes" |
| `discovery` | MEDIUM | Findings: "token refresh has a race condition" |
| `event` | LOW | Things that happened: "deployed to staging" |
| `fact` | LOW (default) | General knowledge |

## Config

Priority order (later wins): `~/.orc/config.json` → `./.orc/config.json` → env vars.

Key env vars: `ORC_DB_PATH`, `ORC_API_PORT` (default 7700), `ORC_API_SECRET`, `ORC_TELEGRAM_TOKEN`, `ORC_LOG_LEVEL`, `ORC_LOG_DIR`, `ORC_LOG_FILE`.

### Logs

All log output goes to **stderr** (human-readable, colored) and **`~/.orc/logs/orc.log`** (JSON lines, machine-readable).

- **Rotation**: 10 MB max per file, keeps 3 rotated files (`orc.log.1`, `orc.log.2`, `orc.log.3`) — 30 MB total cap.
- **Format**: One JSON object per line: `{"ts":"...","level":"info","ns":"api:tasks","msg":"...","data":"..."}`.
- **Disable file logging**: `ORC_LOG_FILE=0`.
- **Custom log directory**: `ORC_LOG_DIR=/path/to/logs` (defaults to `~/.orc/logs`).
- **Agents**: read `~/.orc/logs/orc.log` to inspect recent errors — e.g. `grep '"level":"error"' ~/.orc/logs/orc.log | tail -20`.

### Agent Loop Config

```json
{
  "agent_loop": {
    "enabled": false,
    "poll_interval_minutes": 5,
    "max_workers": 1,
    "default_backend": "claude",
    "session_idle_timeout_minutes": 20,
    "worker_auto_approve": true
  }
}
```

Env vars: `ORC_AGENT_LOOP_ENABLED`, `ORC_AGENT_LOOP_POLL_INTERVAL`, `ORC_AGENT_LOOP_MAX_WORKERS`, `ORC_AGENT_LOOP_DEFAULT_BACKEND`, `ORC_AGENT_LOOP_IDLE_TIMEOUT`, `ORC_AGENT_LOOP_AUTO_APPROVE`.

### Agent Backends

Three built-in backends route tasks to different agent runtimes:

| Backend | Description | Config |
| ------- | ----------- | ------ |
| `claude` | Native Claude Code CLI adapter. Falls back to ACPX on error. | Default. Requires `claude` on PATH. |
| `acpx` | Wraps 14+ coding agents via Agent Communication Protocol (ACP) CLI. Supports codex, gemini, copilot, kiro, cursor, etc. | Requires `acpx` CLI on PATH. |
| `a2a` | Connects to remote agents via Google Agent2Agent protocol (JSON-RPC over HTTP). | Requires `a2a_url` per task/session. |

**Custom backends**: `agent_backend` accepts any string. Unknown names route through ACPX with the name as the `--agent` flag.

**Fallback routing** (gateway):

1. `a2a` — direct A2A HTTP call
2. `claude` — native CLI, falls back to ACPX on error
3. Everything else — ACPX with backend name as agent

Set default backend via `agent_loop.default_backend` in config. Per-task override: set `agent_backend` field when creating a task via API, MCP, or CLI.

### Built-in Skills

Skills live in `skills/*/SKILL.md` (built-in, shipped with ORC) and `~/.orc/skills/` (user-defined). No database seeding — skills are loaded directly from the filesystem. Use `skill_list` to discover available skills, `skill_read` to load content. Skills can have reference files (e.g. `reference.md`, `examples.md`) alongside `SKILL.md` — `skill_read` shows their full paths so agents can Read them on demand. Assign to tasks via `skill_name`.

## Coding Conventions

- **No barrel re-exports** — import directly from the package entry or specific module
- **Zod schemas define the contract** — API routes, config, and CLI args all derive from Zod
- **Types live in `@orc/core/types`** — shared enums/types are defined once there
- **IDs are ULIDs** — use `ulid()` from `@orc/core/ids`
- **No comments** unless explaining non-obvious intent
- **Biome** for all linting/formatting — run `bun check` before committing
- **Aligned versions** — all `package.json` files (root + every package) must share the same version. Always patch bump all together.
- **Publishing** — only `orc-ai` (packages/cli) is published to npm. It bundles all workspace packages into a single JS file via `bun build`. Other packages are internal workspace deps, never published separately.
- **Releases** — push a `v*` tag to trigger the GitHub release workflow, which builds platform binaries (linux-x64, linux-arm64, mac-arm64, mac-x64, windows-x64) and creates a GitHub release with checksums.

## Adding a New MCP Tool

1. Add the tool definition (name, description, `inputSchema`) to `toolDefinitions` in `packages/mcp/src/tools.ts`
2. Add the matching `case` in `executeTool`
3. Add the matching API route in `packages/api/src/server.ts` if persistence is needed
4. Regenerate SDK: `bun sdk:generate` (API must be running)

## Session Protocol for Agents

**Claude Code** (hooks handle steps 2–4 automatically via `hooks/claude-code/settings.json`):
1. `context({})` — at session start (injected by SessionStart hook, scoped to `ORC_PROJECT` if set)
2. *(PostToolUse hook)* — automatically records file edits, git ops, MCP tool calls, subagent launches, plan mode changes
3. *(PreCompact hook)* — automatically calls `session_snapshot`, stores to DB
4. *(SessionStart hook, source=compact)* — automatically calls `session_restore`, injects into context
5. `session_log({ agent: "claude-code", agent_version, summary })` — at end of work unit

**Cursor** (no hook system — all manual; config at `hooks/cursor/mcp.json`):
1. `context({})` — at session start
2. `session_event({ type: "file", data: { path } })` — after significant edits
3. `session_event({ type: "decision", data: { content } })` — after choices
4. `memory_store({ content, type: "decision"|"rule" })` — for durable cross-session knowledge
5. `session_log({ agent: "cursor", summary })` — at end of work unit

**Codex** (hooks available via `hooks/codex/settings.json`, same as Claude Code):
1. `context({})` — at session start
2. Hooks handle events and snapshot automatically
3. `session_log({ agent: "codex", agent_version, summary })` — at end of work unit

## Session Event Types

| Type | Priority | Record when |
|---|---|---|
| `file` | 1 (critical) | File written or edited |
| `task` | 1 (critical) | Task created or status changed |
| `rule` | 1 (critical) | Convention established (also store in memory) |
| `decision` | 2 (high) | Choice made about approach or architecture |
| `git` | 2 (high) | Git commit, push, branch |
| `env` | 2 (high) | Dependency installed, env variable set |
| `error` | 2 (high) | Tool error or failed command |
| `plan` | 2 (high) | Plan mode entered or exited |
| `intent` | 3 (normal) | Mode shift (investigate / implement / review) |
| `subagent` | 3 (normal) | Sub-agent launched or completed |
