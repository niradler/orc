# orc - Agent Guide

Human + AI orchestration hub. Persistent memory · Task management (HITL) · Generic job runner · Telegram bridge · MCP server.

## Repo Layout

```
packages/
  core/           @orc/core           - config (Zod), types, logger, ULID IDs, flow graph engine
  db/             @orc/db             - Drizzle ORM schema + SQLite client (~/.orc/orc.db)
  api/            @orc/api            - Hono REST API + auto-generated OpenAPI spec (:7701)
  sdk/            @orc/sdk            - typed HTTP client generated from OpenAPI spec
  cli/            @orc/cli            - commander CLI (`orc` binary) using the SDK
  mcp/            @orc/mcp            - MCP server (stdio) for Claude/Cursor/Codex/Gemini
  runner/         @orc/runner         - job executor + cron/watch/one-shot scheduler + task loop + flow runner
  gateway/        @orc/gateway        - multi-channel gateway (Telegram, Slack) + agent sessions
  agent-runtime/  @orc/agent-runtime  - shared agent backend registry (claude, acpx, a2a)
  task-service/   @orc/task-service   - task status transitions, side-effects, comments
  web/            @orc/web            - React dashboard (Vite + Tailwind + shadcn + React Query)
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
bun test             # run all tests
bun db:push          # push Drizzle schema to SQLite (dev)
bun db:generate      # generate migration files
bun sdk:generate     # regenerate SDK types (API must be running)
bun build            # build all packages
```

## Dev Environment

All packages load `../../.env` via `bun --env-file ../../.env` in their `dev` scripts. Create `.env` at the repo root:

```env
ORC_API_PORT=7701
ORC_WEB_PORT=3077
```

**Canonical ports** (use these, don't improvise):

| Service | Port | Env var        |
| ------- | ---- | -------------- |
| API     | 7701 | `ORC_API_PORT` |
| Web     | 3077 | `ORC_WEB_PORT` |

Default ports when `.env` is absent: API → 7700, web → 9742. If you need a temporary alternate (e.g. zombie socket on 7701), prefer **7711 / 3087** - don't pick arbitrary numbers, and always update both `.env` and any running dev server together so the web proxy points at the right API.

The web dev server proxies `/api/*` → `http://localhost:$ORC_API_PORT` (strips the `/api` prefix). The API auth secret defaults to `""` (open). Set `ORC_API_SECRET` or `api.secret` in `~/.orc/config.json` to require a Bearer token.

### Running dev servers

> **Do not use the global `orc daemon`** for development - it runs the published binary on port 7700. Always use `bun dev` which starts from source on the dev port configured in `.env`. For production daemon setup (auto-start on boot, background service), see the "Running as a background service" section in `README.md`.

```bash
bun dev                         # API + CLI + web in one shell (recommended)
bun run --filter @orc/api dev   # API only
bun run --filter @orc/web dev   # web only
```

Before starting, run the pre-flight check below - starting a second copy of the API on a port already held by an old one is the #1 source of "my changes aren't taking effect" on this repo.

### Pre-flight: is the port free?

```bash
# Windows / Git Bash
netstat -ano -p tcp | grep ':7701' | head
# or, with full process info:
powershell -Command "Get-NetTCPConnection -LocalPort 7701 -State Listen -EA SilentlyContinue | \
  ForEach-Object { \$p = Get-Process -Id \$_.OwningProcess -EA SilentlyContinue; \
  [PSCustomObject]@{ PID=\$_.OwningProcess; Name=\$p.ProcessName; Cmd=(Get-CimInstance Win32_Process -Filter \"ProcessId=\$(\$_.OwningProcess)\").CommandLine } }"

# macOS / Linux
lsof -iTCP:7701 -sTCP:LISTEN
```

- Port listed under a **live PID** → an API is running. Hit `curl -s http://localhost:7701/health` - if `uptime` is huge, it's stale; shut it down before you start a new one.
- Port listed under a **dead PID** (Windows `Get-Process` returns nothing for it) → zombie socket (see below).

### Shutdown procedure (Windows-specific pitfall)

On Windows, `bun run --filter @orc/api dev` spawns a chain: `bun` (filter wrapper) → `bun exec` → `bun run --hot src/index.ts`. **The grandchild holds the listening socket.** Killing only the top-level `bun` orphans the grandchild, which keeps the port in `LISTEN` under a PID `Get-Process` can no longer resolve. Windows won't release that port until TIME_WAIT expires (~2–4 min) or the orphan is killed.

**Always** kill the whole tree, not just the launcher:

```bash
# Windows - kill every orc API bun child, regardless of who spawned it
powershell -Command "Get-CimInstance Win32_Process -Filter 'Name=\"bun.exe\"' | \
  Where-Object { \$_.CommandLine -like '*run --hot src/index.ts*' -and \$_.CommandLine -notlike '*--port 9742*' } | \
  ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"

# The same pattern catches web dev children:
powershell -Command "Get-CimInstance Win32_Process -Filter 'Name=\"bun.exe\"' | \
  Where-Object { \$_.CommandLine -like '*packages/web*' -or \$_.CommandLine -like '*vite*' } | \
  ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"

# macOS / Linux - simpler, kill the whole process group
pkill -f 'packages/api/src/index.ts'
pkill -f 'packages/web'
```

**Don't blanket-kill `bun.exe`** - MCP servers and the `--port 9742` service also run under `bun` and you'll break unrelated sessions. Match on the command line.

### Zombie socket recovery

If `netstat` shows port `7701` LISTENING under a dead PID and no child process can be found:

1. First re-run the shutdown command above - there may be a grandchild whose `CommandLine` you missed.
2. If still stuck: either wait 2–4 min for TIME_WAIT, **or** start on `7711` and temporarily set `ORC_API_PORT=7711` in `.env` (restart the web dev server so its Vite proxy picks up the new target).
3. Don't `Get-Process -Id <pid> | Stop-Process` on the PID reported by `netstat` - that PID is already gone; the socket is held by the kernel.

### Restart procedure after code changes

- `src/routes/**` and most route handlers → Bun's `--hot` picks them up, **no restart needed**.
- `src/index.ts`, `Bun.serve({...})` config, top-level imports, env var changes → full restart required. Use the shutdown command above, then start.
- Chat streaming (`/chat/stream`) specifically - if it hangs with no output, check `tail -f /tmp/api-dev.log` for `[chat] acpx stderr:` lines; the route drains acpx's stderr into server logs on purpose.

### When launching in the background

Always redirect to a log file you can tail, and name it distinctly per run so you can tell instances apart:

```bash
bun run --filter @orc/api dev > /tmp/orc-api-$(date +%s).log 2>&1 &
```

`bun run --filter ...` without a redirect loses stderr to a background task's captured output, which makes it invisible when debugging startup errors.

## Web Dashboard (packages/web)

React SPA replacing the removed TUI. Same feature surface - Tasks, Kanban, Jobs, Memories, Projects, Sessions, Knowledge, Skills, Flows - plus Dashboard, Settings, and a streaming chat panel that spawns `acpx` via `POST /chat/stream`.

- **Stack**: React 19 + Vite 6 + TypeScript + Tailwind + shadcn/ui + React Query (30s refetch) + `@dnd-kit` (kanban DnD) + Playwright (e2e)
- **API client**: `packages/web/src/api/client.ts` - calls `${getApiUrl()}/<route>`, default `getApiUrl()` is `/api`. Override via `localStorage.orc_api_url` / `orc_api_secret`.
- **Hooks**: `packages/web/src/hooks/` - one React Query wrapper per resource (`useTasks`, `useJobs`, `useMemories`, `useProjects`, `useSessions`, `useKnowledge`, `useSkills`, `useFlows`, `useChat`, `useHealth`)
- **Flows**: the flow run panel in the task sheet and the `/flows` browser read `GET /tasks/{id}/flow` and `GET /flows`. The graph is drawn by hand (`src/lib/flow-graph.ts` - a pure, unit-tested layered layout, no graph library) so loopbacks are visible as edges that go backwards. See [docs/task-flows.md](docs/task-flows.md#in-the-web-dashboard).
- **API limit**: task list max is 100 per request (API enforces `max: 100` via Zod)

### Two ways to run the web UI

| Mode                           | When                                                   | How                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Production (single server)** | After `bun build` or from a published `orc-ai` install | `orc daemon start` (or `orc api`). The API serves the built dashboard at `/`. Endpoints reachable at both `/<route>` and `/api/<route>`. |
| **Vite dev server**            | Local frontend development with hot reload             | `bun run --filter @orc/web dev` (port `ORC_WEB_PORT`, default 3077). Vite proxies `/api/*` → `http://localhost:$ORC_API_PORT/*`.         |

The CLI build (`packages/cli`) runs `bun run --filter @orc/web build` first and copies `packages/web/dist/` into `packages/cli/dist/web/`. The API resolves the dist via `ORC_WEB_DIST` env, then a candidate path list (`packages/web/dist`, `dist/web` next to the bundle, etc.). If no dist is found, the server runs pure-API.

### Why every API route lives under `/api`

`mountRouters()` (`packages/api/src/server.ts`) mounts every router at `/api` - only the MCP router also sits at `/`. That keeps the root path free for the SPA shell, so the dashboard and the API share one origin without colliding. Clients add the prefix themselves: the SDK appends `/api` to its base URL (`packages/sdk/src/client.ts`), so `ORC_API_BASE=http://127.0.0.1:7700` still works for the CLI, MCP and hooks. A browser hitting `/tasks` gets `index.html`, not JSON.

### Static file serving

`packages/api/src/static.ts` serves `index.html` at `/`, hashed bundles at `/assets/*` (with `Cache-Control: public, max-age=31536000, immutable`), and root-level files (favicon, robots) by name. It is mounted last so any conflicting API route wins. The web app routes with React Router, so any navigation request (`Accept: text/html`) that matches no static file falls back to `index.html` - that is what makes deep links like `/flows/orc-default` and `/tasks/<id>` work.

## Web UI e2e tests (Playwright)

Playwright specs live in `packages/web/tests/e2e/`. Selectors are `data-testid` only - never rely on text or class names, which churn every design pass.

```bash
cd packages/web
bun add -D @playwright/test        # one-time: install + `bun x playwright install chromium`
bun run test:e2e                   # auto-starts API + web via webServer
bun run test:e2e:ui                # headed, picker UI
```

Specs cover chat round-trip, dashboard counts, jobs CRUD, kanban DnD, memories CRUD, projects CRUD, project scope filtering, tasks CRUD, the flows browser (`flows.e2e.ts`), and the task flow run panel including human gates and halts (`task-flow.e2e.ts`). Pure logic that needs no browser lives in `packages/web/tests/unit` and runs with `bun run --filter @orc/web test:unit`. An SSE contract test (empty messages → 400) lives at `packages/api/src/__tests__/chat-stream.test.ts` and runs as part of `bun test`.

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

Refs (`@e1`, `@e2`, …) are assigned per snapshot - always take a fresh snapshot after navigation before using refs. Check for `[OBJECT OBJECT]` or `RETRY` buttons in snapshots as signals of error states.

## Core Data Model (packages/db/src/schema.ts)

| Table                               | Purpose                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `tasks`                             | Work items with HITL review flow                                                    |
| `comments`                          | Polymorphic comments (`resource_type` + `resource_id`) for tasks, projects, etc.    |
| `memories`                          | FTS5-indexed key/value knowledge store                                              |
| `jobs` / `job_runs`                 | Scheduled/triggered command execution                                               |
| `sessions`                          | Agent session logs + snapshots (`agent_version`, `job_run_id`)                      |
| `projects`                          | Optional grouping for tasks/memories                                                |
| `skills`                            | Workflow skill templates (filesystem-based, `skills/*/SKILL.md` + `~/.orc/skills/`) |
| `bridge_chats/messages/permissions` | Gateway HITL (Telegram/Slack)                                                       |

**Task status flow**: `todo → doing → review → done`

On rejection: `review → changes_requested → doing → …`

On blocker: `doing → blocked` (needs human intervention before resuming)

Internal statuses (`queued`, `paused`, `cancelled`) are managed by the task loop - agents don't set these directly.

Task status is now a *consequence* of the flow graph a task runs, not the driver: nodes declare the status to set when they start, terminals declare the status the task ends in. A task whose next node is queued but has no session yet sits in `queued` — it only moves to the node's declared status once an agent is really running, so the board never shows more tasks in progress than there are workers. See "Task Flows" below.

**Task priorities**: `low | normal | high | critical`

**Job trigger types**: `one-shot | cron | watch | webhook | manual | bridge-msg`

> `repeat` was removed - use `cron` with a 6-field expression for sub-minute intervals (e.g. `*/30 * * * * *` = every 30 s).

## MCP Tools (34 tools in packages/mcp/src/tools.ts)

**Call `context` first in every session** - returns active tasks + key memories in ~200 tokens.

All tools that accept `project` take a **readable project name** (e.g. `"orc"`), not a ULID. Omit to use `activeProject` from config.

For CRUD operations not in MCP (delete, project management, job creation), use the `orc` CLI.

| Tool                | When to use                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `context`           | Session start - compact overview. Pass `project: "name"` to scope.                                             |
| `memory_search`     | Find facts/decisions - 3-layer BM25. Pass `project` to scope.                                                  |
| `memory_get`        | Fetch full content for specific IDs. Batch multiple IDs. Token-expensive - filter first.                       |
| `memory_store`      | Store a fact/decision/rule/event/discovery. Pass `project` to associate. Source auto-detected from agent env.  |
| `memory_update`     | Update an existing memory by ID (partial). Preserves created_at and access_count. Prefer over delete+recreate. |
| `search`            | Unified search across tasks and memories. Use instead of separate calls.                                       |
| `task_list`         | List active tasks (compact, no body). Pass `project` to filter.                                                |
| `task_get`          | Fetch full task details by ID                                                                                  |
| `task_create`       | Create a task. Pass `project` to scope. Set `agent_backend` to route to a specific agent runtime.              |
| `task_update`       | Update status/priority/body                                                                                    |
| `task_batch_create` | Create multiple tasks with dependency links atomically.                                                        |
| `job_list`          | List all jobs + last run status. Pass `project` to filter.                                                     |
| `job_run`           | Trigger a job by name                                                                                          |
| `job_status`        | Get run status/exit code/error for a run ID                                                                    |
| `project_list`      | Discover all projects (name, status, description)                                                              |
| `skill_list`        | Discover available skills. Filter by tags.                                                                     |
| `skill_read`        | Load full skill content by name. Shows skill directory path + reference file paths - use Read to load them.    |
| `session_event`     | Record significant action (file, task, decision, error, git, env, rule, plan). Deduped automatically.          |
| `session_snapshot`  | Build ≤2KB XML snapshot - priority-tiered (P1: files/tasks, P2: decisions/git, P3: intent)                     |
| `session_restore`   | Restore session after compaction or agent restart                                                              |
| `session_log`       | Log session summary at end of work unit. Pass `project` to associate.                                          |
| `flow_report`       | **Report your node's outcome.** This is what routes the flow. Only declared outcomes are accepted.              |
| `flow_status`       | Inspect a task's flow run: active nodes, ledger, visit counts, halt reason.                                     |
| `flow_list`         | Discover available flow graphs.                                                                                |
| `flow_read`         | Read a flow definition (nodes, edges, limits).                                                                 |
| `flow_create`       | Save a reusable user flow to `~/.orc/flows/<name>/flow.json`. Validated before writing.                        |
| `flow_attach`       | Attach a named flow, or an inline graph for one task only, then optionally start it.                            |

### Memory types

Use the `type` field in `memory_store` - it affects scoring in `context`:

| Type        | Score weight  | Use for                                                |
| ----------- | ------------- | ------------------------------------------------------ |
| `rule`      | HIGH          | Conventions: "all IDs are ULIDs", "never use `any`"    |
| `decision`  | HIGH          | Choices: "use PostgreSQL because of concurrent writes" |
| `discovery` | MEDIUM        | Findings: "token refresh has a race condition"         |
| `event`     | LOW           | Things that happened: "deployed to staging"            |
| `fact`      | LOW (default) | General knowledge                                      |

## Config

Priority order (later wins): `~/.orc/config.json` → `./.orc/config.json` → env vars.

Key env vars: `ORC_DB_PATH`, `ORC_API_PORT` (default 7700), `ORC_API_SECRET`, `ORC_TELEGRAM_TOKEN`, `ORC_LOG_LEVEL`, `ORC_LOG_DIR`, `ORC_LOG_FILE`.

### Logs

All log output goes to **stderr** (human-readable, colored) and **`~/.orc/logs/orc.log`** (JSON lines, machine-readable).

- **Rotation**: 10 MB max per file, keeps 3 rotated files (`orc.log.1`, `orc.log.2`, `orc.log.3`) - 30 MB total cap.
- **Format**: One JSON object per line: `{"ts":"...","level":"info","ns":"api:tasks","msg":"...","data":"..."}`.
- **Disable file logging**: `ORC_LOG_FILE=0`.
- **Custom log directory**: `ORC_LOG_DIR=/path/to/logs` (defaults to `~/.orc/logs`).
- **Agents**: read `~/.orc/logs/orc.log` to inspect recent errors - e.g. `grep '"level":"error"' ~/.orc/logs/orc.log | tail -20`.

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

Env vars: `ORC_AGENT_LOOP_ENABLED`, `ORC_AGENT_LOOP_POLL_INTERVAL`, `ORC_AGENT_LOOP_MAX_WORKERS`, `ORC_AGENT_LOOP_DEFAULT_BACKEND`, `ORC_AGENT_LOOP_IDLE_TIMEOUT`, `ORC_AGENT_LOOP_AUTO_APPROVE`, `ORC_AGENT_LOOP_DEFAULT_FLOW`, `ORC_AGENT_LOOP_REVIEW_FLOW`.

> `max_workers` now bounds **every** agent session the loop owns, reviewers included. It previously counted only `role = 'worker'`, so a `max_workers: 1` install could run one worker plus any number of reviewers. Since a flow can contain several reviewer nodes (and fan out to them), the cap has to mean "concurrent agents" to be a real limit. Bump `max_workers` if you were relying on the old behaviour for throughput.

Each cycle: reap stale sessions → halt flows past their wall clock → start flows for eligible tasks → drain queued flow nodes up to capacity. Starting a flow is cheap and happens even at capacity; its nodes queue as `pending` and spawn as slots free up.

### Agent Backends

Three built-in backends route tasks to different agent runtimes:

| Backend  | Description                                                                                                             | Config                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `claude` | Native Claude Code CLI adapter. Falls back to ACPX on error.                                                            | Default. Requires `claude` on PATH.  |
| `acpx`   | Wraps 14+ coding agents via Agent Communication Protocol (ACP) CLI. Supports codex, gemini, copilot, kiro, cursor, etc. | Requires `acpx` CLI on PATH.         |
| `a2a`    | Connects to remote agents via Google Agent2Agent protocol (JSON-RPC over HTTP).                                         | Requires `a2a_url` per task/session. |

**Custom backends**: `agent_backend` accepts any string. Unknown names route through ACPX with the name as the `--agent` flag.

**Fallback routing** (gateway):

1. `a2a` - direct A2A HTTP call
2. `claude` - native CLI, falls back to ACPX on error
3. Everything else - ACPX with backend name as agent

Set default backend via `agent_loop.default_backend` in config. Per-task override: set `agent_backend` field when creating a task via API, MCP, or CLI.

## Task Flows (graphs and loops)

Every task runs a **flow**: a graph of nodes joined by conditional edges, which may cycle. This replaced the hardcoded worker → reviewer pipeline - `orc-default` is the graph that reproduces it, so behaviour is unchanged unless a task names a different flow.

The split that makes this work: **the graph is deterministic, only the nodes are agents.** `packages/core/src/flow-engine.ts` is pure - given a state and a node result it returns the next state and a list of actions, touching no DB, clock, or agent. `packages/runner/src/flow-runner.ts` is the impure half that applies those actions: spawning sessions, writing the ledger, moving task status.

### Anatomy

```jsonc
{
  "name": "my-flow",
  "entry": "build",
  "limits": {
    "max_node_executions": 24,      // total node runs before the flow halts
    "execution_timeout_secs": 14400, // wall clock for the whole run
    "max_parallel": 4,               // concurrent nodes per task (fan-out width)
    "reset_on_revisit": true,        // re-entering a node starts a fresh session
    "halt_task_status": "paused"     // where the task lands if a rail trips
  },
  "nodes": {
    "build":  { "kind": "agent", "skill": "$task.skill_name", "task_status": "doing",
                "outcomes": ["submitted", "blocked"], "on_error": "blocked" },
    "gate":   { "kind": "gate", "routing": "all" },
    "verify": { "kind": "agent", "skill": "orc-reviewer", "role": "reviewer", "max_visits": 4 },
    "signoff":{ "kind": "human", "prompt": "Approve?", "task_status": "review" },
    "done":   { "kind": "terminal", "task_status": "done" }
  },
  "edges": [
    { "from": "build", "to": "verify", "when": { "outcome": "submitted" } },
    { "from": "verify", "to": "done", "when": { "outcome": "pass" } },
    { "from": "verify", "to": "build",
      "when": { "all": [{ "outcome": "fail" },
                        { "visits": { "node": "build", "lt": { "var": "max_review_rounds" } } }] } },
    { "from": "verify", "to": "escalated", "when": { "always": true } }
  ]
}
```

**Node kinds**

| Kind       | Runs                                | Notes                                                            |
| ---------- | ----------------------------------- | ---------------------------------------------------------------- |
| `agent`    | An agent session                    | `skill`, `prompt`, `backend`, `model`, `role` (worker\|reviewer)  |
| `gate`     | Nothing - routes immediately        | Deterministic branching, fan-out (`routing: "all"`), join points  |
| `human`    | Nothing - waits                     | `orc flow resume <task> --outcome <x>` to continue                |
| `terminal` | Nothing - ends the run              | `task_status` is where the task lands                            |

**Edges are ordered and first-match-wins**, so the bounded-loop idiom is a guarded loopback followed by a catch-all escalation. A node with `routing: "all"` activates *every* matching edge instead - that is fan-out.

**Conditions are data, never code** - no `eval`, no expressions. Available: `always`, `outcome`, `visits`, `executions`, `elapsed_secs`, `var`, and `all`/`any`/`not`. Numeric comparators (`lt`, `gte`, …) take a number or `{ "var": "name" }`.

Every condition object is strict, so a mistyped guard is rejected rather than silently stripped down to something that always matches: an unknown key, a predicate-less `var`, and a `visits.node` naming a node that does not exist are all validation errors. At runtime, a `{ var }` operand that is absent or non-numeric makes the comparison **false** — fail closed, so an unresolvable budget shortens a loop rather than unbounding it.

**Placeholders**: `$task.skill_name`, `$task.agent_backend`, `$task.agent_model` let a shipped flow defer to the task's own fields.

**Run vars** are injected at start (`task_id`, `task_title`, `project_id`, `skill_name`, `required_review`, `max_review_rounds`) and extended by nodes via `flow_report(vars: …)`. A node's `vars` are merged when it is *entered*, which is how a loopback clears last round's verdicts.

### Fan-out and joins

`routing: "all"` activates several branches at once. A node with a `join` parks each arriving branch until the join is satisfied:

```jsonc
"verdict": { "kind": "gate", "join": { "mode": "all", "from": ["review_a", "review_b"] } }
```

- `mode: "all"` waits for every listed source; `mode: "any"` fires on the first arrival and (by default) cancels its siblings.
- Arrivals reset once the join fires, so joins work inside loops.
- Fan-out never exceeds capacity: extra nodes sit as `pending` rows and drain as worker slots free up, so a `max_workers: 1` install runs the branches sequentially rather than failing.
- Reaching any terminal ends the whole run and cancels branches still in flight.

### Termination

A flow cannot loop forever. Five independent rails, each of which halts the run and (by default) pauses the task with an explanatory comment:

1. `max_visits` per node
2. `limits.max_node_executions` for the run
3. `limits.execution_timeout_secs` wall clock (also swept from outside, for hung nodes)
4. no matching edge → `no_matching_edge`
5. no active nodes left → `stalled`, or `join_deadlock` if branches are parked at an unsatisfiable join

Two more rails sit outside a single run, because a per-run rail cannot see a loop made of runs: `agent_loop.max_node_retries` (default 2) bounds re-queues of one node after an infrastructure failure, and `agent_loop.max_flow_runs_per_task` (default 6) bounds how many *self-ended* runs a task may go through before it is paused for a human (a human comment on the task forgives that budget).

Time spent `awaiting_human` is excluded from `execution_timeout_secs`, and the timeout sweep skips a run parked on a person — otherwise the wall clock is a fuse on every human gate.

A node that dies routes through `on_error` if it declares one, otherwise the run halts. A node that ends without reporting anything halts with `no_outcome` rather than the graph guessing a verdict. A node that reported an outcome and *then* failed routes on the outcome — a verdict the agent actually gave is not discarded because its session ended badly afterwards.

Infrastructure failures are not verdicts: a session reaped for idling or hitting its lifetime cap re-queues the same node as a fresh attempt (bounded by `max_node_retries`) instead of routing `on_error`, which is what keeps a network blip from parking the task.

### How a node reports its outcome

Call `flow_report`. The node's prompt lists exactly which outcomes its outgoing edges can route, and anything else is rejected:

```
flow_report(task: "<id>", node: "verify", outcome: "fail", summary: "...", vars: { tests_ok: false })
```

If a node's session ends without reporting, the outcome is **inferred** from the task status the agent left behind (`review → submitted`, `blocked → blocked`, `done → approved`, …) so skills written against the old status-driven protocol keep working. Inference only fires when the mapping is unambiguous; otherwise the flow halts for a human.

### Where flows live

| Source    | Location                        | Notes                                        |
| --------- | ------------------------------- | -------------------------------------------- |
| `builtin` | `packages/core/src/flows/builtin.ts` | Compiled in, so they exist in npm installs   |
| `user`    | `~/.orc/flows/<name>/flow.json` | Shadows a builtin of the same name           |
| `project` | `./.orc/flows/<name>/flow.json` | Shadows user and builtin                     |
| `task`    | `tasks.flow_override` (JSON)    | An inline graph for one task, beats them all  |

Definitions are validated on load - unknown edge targets, unreachable nodes, terminals with outgoing edges, a graph that can never finish, and shadowed (dead) edges are all rejected, and the offender is reported by `flow_list` rather than silently ignored. Creating a user flow named after a builtin needs an explicit opt-in, since shadowing `orc-default` re-pipelines every task. A run **freezes its definition** at start, so editing a flow never changes a run already in flight.

### Built-in flows

| Flow                    | Shape                                                                       |
| ----------------------- | --------------------------------------------------------------------------- |
| `orc-default`           | build → review → done, loops back while `max_review_rounds` allows          |
| `orc-review-only`       | A single review pass, for a task a human moved straight to `review`         |
| `orc-plan-build-verify` | planner → coder → reviewer, looping until acceptance criteria pass          |
| `orc-fix-verify`        | bugfix → independent confirmation the fix holds and a regression test exists |
| `orc-supervisor`        | Executor keeping its context + supervisor re-verifying from clean context   |
| `orc-parallel-review`   | Fan-out to correctness/security/tests reviewers, join on all three          |

### Custom per-task graphs

For work no named flow fits, attach an inline graph to the single task:

```bash
orc flow attach <taskId> --file ./my-graph.json --start   # bespoke, this task only
orc flow attach <taskId> --name orc-supervisor             # a named flow
orc flow validate --file ./my-graph.json                   # check before attaching
orc flow status <taskId>                                   # active nodes + ledger
orc flow resume <taskId> --outcome approved                # resolve a human node
orc flow halt <taskId>                                     # stop it and kill live nodes
```

Agents do the same with `flow_attach` (pass `definition` for inline) and `flow_create` for a reusable one. A planner deciding a task needs plan → build → three parallel reviews → sign-off can author that graph itself.

### In the web dashboard

The task detail sheet draws the run's frozen graph plus its ledger (active node, per-visit verdicts, visit counts, halt reason, session links), resolves human gates - offering only the outcomes the waiting node's edges can route - and can halt a run. `/flows` lists every flow with source and shadowing badges, shows a definition, and surfaces the `broken[]` validation errors from `GET /flows`. Details in [docs/task-flows.md](docs/task-flows.md#in-the-web-dashboard).

### Flow config

```json
{
  "agent_loop": {
    "default_flow": "orc-default",
    "review_flow": "orc-review-only",
    "max_node_retries": 2,
    "max_flow_runs_per_task": 6
  }
}
```

Env: `ORC_AGENT_LOOP_DEFAULT_FLOW`, `ORC_AGENT_LOOP_REVIEW_FLOW`, `ORC_AGENT_LOOP_MAX_NODE_RETRIES`, `ORC_AGENT_LOOP_MAX_FLOW_RUNS`.

### Built-in Skills

Skills live in `skills/*/SKILL.md` (built-in, shipped with ORC) and `~/.orc/skills/` (user-defined). No database seeding - skills are loaded directly from the filesystem. Use `skill_list` to discover available skills, `skill_read` to load content. Skills can have reference files (e.g. `reference.md`, `examples.md`) alongside `SKILL.md` - `skill_read` shows their full paths so agents can Read them on demand. Assign to tasks via `skill_name`.

## Coding Conventions

- **No barrel re-exports** - import directly from the package entry or specific module
- **Zod schemas define the contract** - API routes, config, and CLI args all derive from Zod
- **Types live in `@orc/core/types`** - shared enums/types are defined once there
- **IDs are ULIDs** - use `ulid()` from `@orc/core/ids`
- **No comments** unless explaining non-obvious intent
- **Biome** for all linting/formatting - run `bun check` before committing
- **Aligned versions** - all `package.json` files (root + every package) must share the same version. Always patch bump all together.
- **Publishing** - only `orc-ai` (packages/cli) is published to npm, **manually and locally**. It bundles all workspace packages into a single JS file via `bun build`. Other packages are internal workspace deps, never published separately.
  - Runtime deps that resolve files relative to their own package at runtime (e.g. `@anthropic-ai/claude-agent-sdk`, which locates its `cli.js` via `import.meta.url`) MUST be `--external` in the build script **and** declared in `dependencies` — never bundled, or the runtime path resolution breaks once inlined into `dist/index.js`.
- **Validate before publish** - `npm publish` runs `prepublishOnly` (`build` + `validate:package`), which packs the real tarball, clean-installs it into a temp project, and asserts the externalized deps resolve. To check manually without publishing: `cd packages/cli && bun run build && bun run validate:package`.
- **Releases** - done manually/locally; there is no auto-release workflow. Bump all `package.json` versions together, then `cd packages/cli && npm publish`.

## Adding a New MCP Tool

1. Add the tool definition (name, description, `inputSchema`) to `toolDefinitions` in `packages/mcp/src/tools.ts`
2. Add the matching `case` in `executeTool`
3. Add the matching API route in `packages/api/src/server.ts` if persistence is needed
4. Regenerate SDK: `bun sdk:generate` (API must be running)

## Session Protocol for Agents

**Claude Code** (hooks handle steps 2–4 automatically via `hooks/claude-code/settings.json`):

1. `context({})` - at session start (injected by SessionStart hook, scoped to `ORC_PROJECT` if set)
2. _(PostToolUse hook)_ - automatically records file edits, git ops, MCP tool calls, subagent launches, plan mode changes
3. _(PreCompact hook)_ - automatically calls `session_snapshot`, stores to DB
4. _(SessionStart hook, source=compact)_ - automatically calls `session_restore`, injects into context
5. `session_log({ agent: "claude-code", agent_version, summary })` - at end of work unit

**Cursor** (no hook system - all manual; config at `hooks/cursor/mcp.json`):

1. `context({})` - at session start
2. `session_event({ type: "file", data: { path } })` - after significant edits
3. `session_event({ type: "decision", data: { content } })` - after choices
4. `memory_store({ content, type: "decision"|"rule" })` - for durable cross-session knowledge
5. `session_log({ agent: "cursor", summary })` - at end of work unit

**Codex** (hooks available via `hooks/codex/settings.json`, same as Claude Code):

1. `context({})` - at session start
2. Hooks handle events and snapshot automatically
3. `session_log({ agent: "codex", agent_version, summary })` - at end of work unit

## Session Event Types

| Type       | Priority     | Record when                                   |
| ---------- | ------------ | --------------------------------------------- |
| `file`     | 1 (critical) | File written or edited                        |
| `task`     | 1 (critical) | Task created or status changed                |
| `rule`     | 1 (critical) | Convention established (also store in memory) |
| `decision` | 2 (high)     | Choice made about approach or architecture    |
| `git`      | 2 (high)     | Git commit, push, branch                      |
| `env`      | 2 (high)     | Dependency installed, env variable set        |
| `error`    | 2 (high)     | Tool error or failed command                  |
| `plan`     | 2 (high)     | Plan mode entered or exited                   |
| `intent`   | 3 (normal)   | Mode shift (investigate / implement / review) |
| `subagent` | 3 (normal)   | Sub-agent launched or completed               |
