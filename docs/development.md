# Development guide

This guide contains task-specific development and troubleshooting details. See [README](../README.md) for the product and architecture and [AGENTS.md](../AGENTS.md) for session-wide agent rules. Check the current source and configuration when details may have changed.

## Dev Environment

For releases or installation upgrades, read [docs/releases.md](releases.md),
including its operator protocol, and the latest `.claude/docs/releases.md`
handoff before running publication or deployment commands.

### Git worktrees

Create worktrees under `.orc/worktrees/<name>` at the repo root (gitignored): `git worktree add .orc/worktrees/<name> ...`. A coding agent's native worktree folder is also fine: `.claude/worktrees/<name>` (Claude Code) or `~/.codex/worktrees/` (Codex). Never place one beside the repo (`../orc-*`), in a temp directory, or in `.worktrees/` or `.claude/checkouts/`. The workspace ORC script rule `worktree-location` enforces this for every coding agent: it runs `.orc/rules/worktree-location.ts`, which resolves the `git worktree add` target path and denies anything outside these folders. Remove a worktree you created once its work is merged.

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

The web dev server proxies `/api/*` → `http://localhost:$ORC_API_PORT` (the `/api` prefix is kept; the API serves its routes under `/api`, and WebSockets are proxied too). The API auth secret defaults to `""` (open). Set `ORC_API_SECRET` or `api.secret` in `~/.orc/config.json` to require a Bearer token.

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

Read [`DESIGN.md`](../DESIGN.md) before UI work. It records ORC's intended visual direction and review criteria; proposed tokens are not permission to apply a theme change. Keep the current implementation and the proposed design clearly distinguished.

React SPA replacing the removed TUI. Same feature surface - Tasks, Kanban, Jobs, Memories, Projects, Sessions, Knowledge, Skills, Flows - plus Dashboard, Settings, and a streaming chat panel that spawns `acpx` via `POST /chat/stream`.

- **Stack**: React 19 + Vite 6 + TypeScript + Tailwind + shadcn/ui + React Query (shared SSE change notifications) + `@dnd-kit` (kanban DnD) + Playwright (e2e)
- **API client**: `packages/web/src/api/client.ts` - calls `${getApiUrl()}/<route>`, default `getApiUrl()` is `/api`. Override via `localStorage.orc_api_url` / `orc_api_secret`.
- **Hooks**: `packages/web/src/hooks/` - one React Query wrapper per resource (`useTasks`, `useJobs`, `useMemories`, `useProjects`, `useSessions`, `useKnowledge`, `useSkills`, `useFlows`, `useBackends`, `useChat`, `useHealth`)
- **Flows**: the flow run panel in the task sheet and the `/flows` browser read `GET /tasks/{id}/flow` and `GET /flows`. The graph is drawn by hand (`src/lib/flow-graph.ts` - a pure, unit-tested layered layout, no graph library) so loopbacks are visible as edges that go backwards. See [docs/task-flows.md](task-flows.md#in-the-web-dashboard).
- **API limit**: task list max is 100 per request (API enforces `max: 100` via Zod)

Resource-list standard: provide row selection and bulk actions using shared
`useListSelection`, `BulkActionBar`, and `applyBulkAction` (see DESIGN.md).
Jobs and Projects implement the pattern. Select only displayed rows, reset on
project/filter changes, retain failed entries for retry, and report partial success.
Do not make users open individual editors for routine status changes. New jobs
are disabled unless the creator explicitly enables them; preserve this API/CLI/UI
contract and allow webhook setup while disabled.

### Two ways to run the web UI

| Mode                           | When                                                   | How                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Production (single server)** | After `bun build` or from a published `orc-ai` install | `orc daemon start` (or `orc api`). The API serves the built dashboard at `/`. API endpoints are under `/api`. |
| **Vite dev server**            | Local frontend development with hot reload             | `bun run --filter @orc/web dev` (port `ORC_WEB_PORT`, default 3077). Vite proxies `/api/*` → `http://localhost:$ORC_API_PORT/*`.         |

The CLI build (`packages/cli`) runs `bun run --filter @orc/web build` first and copies `packages/web/dist/` into `packages/cli/dist/web/`. The API resolves the dist via `ORC_WEB_DIST` env, then a candidate path list (`packages/web/dist`, `dist/web` next to the bundle, etc.). If no dist is found, the server runs pure-API.

### API and static routes

`mountRouters()` (`packages/api/src/server.ts`) mounts the application routers at `/api`; the MCP and public webhook routers also have root mounts. That keeps the root path free for the SPA shell, so the dashboard and the API share one origin without colliding. Clients add the prefix themselves: the SDK appends `/api` to its base URL (`packages/sdk/src/client.ts`), so `ORC_API_BASE=http://127.0.0.1:7700` still works for the CLI, MCP and hooks. A browser hitting `/tasks` gets `index.html`, not JSON.

### Static file serving

`packages/api/src/static.ts` serves `index.html` at `/`, hashed bundles at `/assets/*` (with `Cache-Control: public, max-age=31536000, immutable`), and root-level files (favicon, robots) by name. It is mounted last so any conflicting API route wins. The web app routes with React Router, so any navigation request (`Accept: text/html`) that matches no static file falls back to `index.html` - that is what makes deep links like `/tasks/<id>` work.

## Web UI e2e tests (Playwright)

Playwright specs live in `packages/web/tests/e2e/`. Selectors are `data-testid` only - never rely on text or class names, which churn every design pass.

```bash
cd packages/web
bun x playwright install chromium # one-time browser install
bun run test:e2e                   # auto-starts API + web via webServer
bun run test:e2e:ui                # headed, picker UI
```

Specs cover chat round-trip, dashboard counts, jobs CRUD, kanban DnD, memories CRUD, projects CRUD, project scope filtering, tasks CRUD, the flows browser (`flows.e2e.ts`), the task flow run panel including human gates and halts (`task-flow.e2e.ts`), and agent-backend probing and picking (`backends.e2e.ts`). Pure logic that needs no browser lives in `packages/web/tests/unit` and runs with `bun run --filter @orc/web test:unit`. An SSE contract test (empty messages → 400) lives at `packages/api/src/__tests__/chat-stream.test.ts` and runs as part of `bun test`.

## Testing the Web UI with agent-browser

Use `agent-browser` (installed via `agent-browser install`) to drive a real browser for UI sanity checks:

```bash
agent-browser open http://localhost:3077   # open the web app
agent-browser snapshot                     # get accessibility tree with refs
agent-browser click @e5                    # click by ref from snapshot
agent-browser fill @e3 "value"             # fill input by ref
agent-browser get text @e1                 # read text by ref
agent-browser screenshot path/to/out.png   # capture screenshot
agent-browser close                        # close browser
```

Refs (`@e1`, `@e2`, …) are assigned per snapshot - always take a fresh snapshot after navigation before using refs. Check for `[OBJECT OBJECT]` or `RETRY` buttons in snapshots as signals of error states.

## Agent backends

`packages/agent-runtime` registers one backend per way of reaching an agent, and `probeBackends()` reports whether each is usable *right now*. That probe is the single source for `GET /api/backends`, `orc doctor`, the dashboard's backend picker, and the gateway's startup log - they cannot disagree.

| Backend      | Kind         | Needs                                                                  |
| ------------ | ------------ | ---------------------------------------------------------------------- |
| `claude`     | `in-process` | `@anthropic-ai/claude-agent-sdk` (a real dependency) + claude CLI credentials or `ANTHROPIC_API_KEY`. The default, and the only one that needs no external tool. |
| `acpx`       | `cli`        | The acpx CLI. An `optionalDependency` of `orc-ai`, so `resolveAcpxCli()` finds it in the package's own `node_modules` when it is not on `PATH`; `ORC_ACPX_PATH` overrides. Not available inside a `bun build --compile` binary unless installed separately. |
| `agentapi`   | `http`       | An agentapi server (`AGENTAPI_URL`).                                    |
| `a2a`        | `http`       | An endpoint per session — nothing local.                                |
| `claude-cli` | `cli`        | The `claude` binary. The pre-SDK implementation.                        |
| `codex-cli`  | `cli`        | The `codex` binary, driven natively.                                    |

Two rules that are easy to get wrong:

- **`createBackend(name)` throws for an unknown name.** It used to substitute acpx, which meant a typo silently ran acpx's *default* agent. Routing an unknown name to acpx-as-agent still happens, but in `resolveBackend()` (session-factory), which sets `acpxAgent` so the right agent actually runs.
- **`pickUsableBackend(names)` preflights**; there is no registered-only "pick" any more. The old `pickAvailableBackend` only checked registration while claiming availability, so it returned backends whose service was down.

A backend may implement the optional `describe()` to report its kind, what it requires, and what it resolved to. Anything without it is still probed, just with less detail.

**Job trigger types**: `one-shot | cron | watch | webhook | manual | bridge-msg`

**Job actions**: `command | agent | task` in `jobs.action`. Legacy jobs with no
action use their existing command. Only command actions require a shell command.
Agent runs link `job_runs.session_id` to their tracked session; task runs link
`job_runs.task_id`. Task action auto-start defaults off (`tasks.auto_start=false`),
which excludes the generated backlog task from automatic pickup while allowing a
manual flow start. Existing tasks retain automatic eligibility.

**Reusable webhooks**: sources are independent of jobs, project-scoped or global.
`webhook_subscriptions` connects sources to jobs with per-job events/actions.
Signed deliveries reserve all matching enabled-job runs atomically and deduplicate
per source; `webhook_delivery_runs` records each result. Create/select sources
inside Jobs; manage all sources from Activity → Webhooks. Keep source secrets
one-time and encrypted; validate subscription project membership on job writes.

> `repeat` was removed - use `cron` with a 6-field expression for sub-minute intervals (e.g. `*/30 * * * * *` = every 30 s).

