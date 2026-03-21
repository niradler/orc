# orc

[![npm version](https://img.shields.io/npm/v/orc-ai)](https://www.npmjs.com/package/orc-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**The shared brain between you and your AI agents.**

One SQLite file. Shared across every session — same agent or different agents, serial or parallel. Projects, persistent memory, a task board with human-in-the-loop review, a job runner, and an MCP server — all in one CLI.

```
Session 1 (Claude Code)  ──┐
Session 2 (Claude Code)  ──┤
Session 3 (Cursor)       ──┤──→  ~/.orc/orc.db  ←──  orc cli (you)
Session 4 (Codex)        ──┘
```

## Features

- **Projects** — group tasks, memories, and jobs under a named project; set an active project and all commands auto-scope to it
- **Shared memory** — store decisions, rules, and discoveries; any session can search them via BM25 full-text search
- **Task board** — tasks flow through `todo → queued → doing → review → done`; agents submit for human review, you approve or request changes
- **Agent orchestration** — task loop automatically picks up queued tasks, spawns worker agents, manages concurrency and review cycles
- **Job runner** — schedule commands with cron, file-watch, webhook, or manual triggers; logs every run
- **MCP server** — one config line connects any AI agent (Claude Code, Cursor, Codex, Gemini CLI) to all of the above
- **Session continuity** — snapshots survive context compaction so agents pick up where they left off
- **Gateway** — approve tasks, search memory, and chat with agents from Telegram or Slack

## Install

```bash
npm install -g orc-ai
```

> [!NOTE]
> Requires [Bun](https://bun.sh) >= 1.1 as the runtime.

<details>
<summary>Other installation methods</summary>

### Binary

Download the latest release for your platform from [GitHub Releases](https://github.com/niradler/orc/releases):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-darwin-arm64 -o /usr/local/bin/orc
chmod +x /usr/local/bin/orc

# macOS (Intel)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-darwin-x64 -o /usr/local/bin/orc
chmod +x /usr/local/bin/orc

# Linux (x64)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-linux-x64 -o /usr/local/bin/orc
chmod +x /usr/local/bin/orc

# Windows — download orc.exe and add to PATH
```

### From source

```bash
git clone https://github.com/niradler/orc
cd orc
bun install
bun build
```

</details>

## Quick start

```bash
# 1. Start the daemon (API + scheduler + gateway)
orc daemon start

# 2. Create a project and set it as active
orc project add my-app -d "My application"
orc project use my-app

# 3. Everything auto-scopes to the active project
orc task add "Fix the auth bug" --priority high
orc mem add "Use RWMutex for token refresh" --type decision
orc job add nightly --command "bun run test" --trigger cron --cron "0 22 * * *"

# 4. See everything at a glance
orc project show
orc task list
```

The database is created automatically at `~/.orc/orc.db` on first run.

## Agent setup

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit|StrReplace|EditNotebook|Bash|Shell|Agent|EnterPlanMode|ExitPlanMode|mcp__orc__task_|mcp__orc__memory_store|mcp__orc__memory_delete|mcp__orc__job_run|mcp__orc__job_create|mcp__orc__job_update", "hooks": [{ "type": "command", "command": "bun /path/to/orc/hooks/post-tool-use.ts" }] }],
    "PreCompact":  [{ "matcher": "", "hooks": [{ "type": "command", "command": "bun /path/to/orc/hooks/pre-compact.ts" }] }],
    "SessionStart":[{ "matcher": "", "hooks": [{ "type": "command", "command": "bun /path/to/orc/hooks/session-start.ts" }] }]
  },
  "env": { "ORC_API_BASE": "http://127.0.0.1:7700", "ORC_PROJECT": "" }
}
```

> [!TIP]
> Replace `/path/to/orc/` with your actual clone path. Hooks handle session events and snapshots automatically.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "orc": {
      "command": "orc",
      "args": ["mcp"],
      "env": { "ORC_API_BASE": "http://127.0.0.1:7700", "ORC_SESSION_ID": "cursor" }
    }
  }
}
```

<details>
<summary>Codex and Gemini CLI</summary>

**Codex** — Copy `hooks/codex/settings.json` to `~/.codex/settings.json` and replace the path placeholder.

**Gemini CLI** — Add to your MCP config:

```json
{
  "mcpServers": {
    "orc": {
      "command": "orc",
      "args": ["mcp"],
      "env": { "ORC_API_BASE": "http://127.0.0.1:7700", "ORC_SESSION_ID": "gemini" }
    }
  }
}
```

</details>

## Projects and active project

Projects are the organizing hub — every task, memory, and job belongs to a project. Set an active project once and all commands auto-scope to it:

```bash
orc project add my-app -d "Main application"
orc project use my-app       # set active project

# Now these all target my-app automatically:
orc task list
orc mem search "auth"
orc job list

# Override for a specific command:
orc task list -p infra

# See everything across all projects:
orc task list --no-project
```

The active project is stored in `~/.orc/config.json` under `activeProject`.

**Resolution order:** explicit `-p <name>` > `activeProject` from config > error (if project required)

MCP tools follow the same logic — pass `project: "name"` to scope, or omit to use the active project.

## How agents use ORC

```
1. Agent starts         → calls context() for active tasks + key memories
2. Agent works          → creates tasks, stores decisions, records events
3. Agent submits work   → task_update(status: "review", comment: "summary")
4. Human reviews        → approves or requests changes via CLI / Telegram
5. Agent continues      → picks up next task or resumes with feedback
6. Session ends         → session_log() records what happened
```

When an agent's context window fills up, `session_snapshot` captures current state into a compact 2KB XML blob that `session_restore` injects back after compaction.

## Agent orchestration

The task loop automatically picks up `queued` tasks and spawns worker agents to execute them.

### How it works

1. Create tasks with `task_create` or `task_batch_create`
2. Set `prompt_id` to assign a workflow (e.g. `orc-coder`, `orc-bugfix`)
3. Set `agent_backend` to choose which agent executes (`claude`, `codex`)
4. Task loop polls for queued tasks, spawns workers, manages concurrency
5. Workers follow the assigned prompt, submit for review when done
6. Human approves or requests changes — loop continues automatically

### Configuration

Add to `~/.orc/config.json`:

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

Per-project concurrency: set `max_workers` on the project to limit how many workers run simultaneously for that project.

### Built-in prompts

Discover with `orc prompt list` or MCP `prompt_list`. Prompts live in `skills/prompts/*/SKILL.md` and are seeded to the database on startup.

| Prompt | Type | Purpose |
|---|---|---|
| `orc-worker-base` | Base | Default worker behavior — ORC awareness, status updates |
| `orc-main-base` | Base | Orchestration agent — planning, delegation |
| `orc-coder` | Workflow | Implementation — code, test, verify, submit |
| `orc-planner` | Workflow | Task decomposition with dependencies |
| `orc-reviewer` | Workflow | Structured code/work review |
| `orc-bugfix` | Workflow | Bug investigation and fix |
| `orc-requirements` | Skill | Requirements gathering interview |
| `orc-report` | Skill | Project status report |

## MCP tools

**20 tools** available to any connected agent. Start every session with `context` — it returns active tasks + key memories in ~200 tokens.

| Category | Tools |
|---|---|
| **Project** | `project_list` |
| **Memory** | `context`, `memory_search`, `memory_get`, `memory_store` |
| **Task** | `task_list`, `task_get`, `task_create`, `task_update`, `task_batch_create` |
| **Prompt** | `prompt_list`, `prompt_get` |
| **Search** | `search` |
| **Job** | `job_list`, `job_run`, `job_status` |
| **Session** | `session_event`, `session_snapshot`, `session_restore`, `session_log` |

### Memory types

| Type | Weight | Use for |
|---|---|---|
| `rule` | High | Conventions: "all IDs are ULIDs" |
| `decision` | High | Choices: "use PostgreSQL for concurrent writes" |
| `discovery` | Medium | Findings: "token refresh has a race condition" |
| `event` | Low | Things that happened: "deployed v1.0" |
| `fact` | Low | General knowledge (default) |

### Task status flow

```
todo → queued → doing → review → done
                  │         │
                  ▼         ▼
               blocked    changes_requested → doing
                  │
                  ▼
                paused
```

## CLI reference

```
orc daemon start|stop|status     Manage the daemon (API + scheduler + gateway)
orc api                          Start the API server only
orc mcp                          Start the MCP server (stdio)
orc home                         Show ~/.orc directory and config
orc status                       Show API health and counts

orc project list|add|show|use|update|archive
orc task list|add|show|update|done|review|approve|reject|delete
orc mem list|add|search
orc job list|add|run|runs
orc session list|show|log
orc prompt list|add|show|render
```

All task/mem/job commands default to the active project. Use `-p <name>` to override or `--no-project` to see everything.

## Jobs

```bash
orc job add deploy    --command "bun run deploy"    --trigger manual
orc job add nightly   --command "bun run test"      --trigger cron --cron "0 22 * * *"
orc job add on-change --command "bun run lint"      --trigger watch --watch "./src"
orc job add on-push   --command "bun run ci"        --trigger webhook
```

## Gateway

Connect Telegram and Slack to your ORC instance. Approve agent work from your phone, search memory, or start a live AI session — all from a chat message.

### Telegram setup

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Find your user ID via [@userinfobot](https://t.me/userinfobot)
3. Add to `~/.orc/config.json`:

```json
{
  "gateway": {
    "telegram": {
      "enabled": true,
      "token": "7123456789:AAF...",
      "authorized_users": [123456789]
    }
  }
}
```

**Commands:** `/status`, `/tasks`, `/approve <id>`, `/reject <id>`, `/jobs`, `/run <name>`, `/mem <query>`, `/agent <claude|codex>`

## REST API

Runs on port 7700 with auto-generated OpenAPI spec.

- `GET /docs` — Swagger UI
- `GET /openapi.json` — OpenAPI 3.1 spec

<details>
<summary>Full endpoint list</summary>

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET/POST/PATCH/DELETE` | `/projects` | CRUD projects |
| `GET` | `/projects/by-name/{name}` | Lookup by name |
| `GET` | `/projects/{id}/summary` | Task/memory/job counts |
| `GET/POST/PATCH/DELETE` | `/tasks` | CRUD tasks |
| `GET/POST` | `/tasks/{id}/notes` | Task notes |
| `GET/POST/DELETE` | `/tasks/{id}/links` | Task dependencies |
| `GET/POST/DELETE` | `/memories` | CRUD memories |
| `GET` | `/memories/search` | BM25 search |
| `GET/POST` | `/jobs` | CRUD jobs |
| `POST` | `/jobs/{id}/trigger` | Trigger a job |
| `GET` | `/jobs/{id}/runs` | Run history |
| `GET` | `/jobs/{id}/runs/{runId}/logs` | Run logs |
| `GET/POST/PATCH/DELETE` | `/prompts` | Prompt templates |
| `GET` | `/sessions` | Agent session logs |
| `POST` | `/mcp/tool` | Execute any MCP tool via HTTP |

</details>

## Configuration

ORC merges config in priority order (later wins):

1. `~/.orc/config.json` — user global
2. `./.orc/config.json` — project-local
3. Environment variables

| Variable | Default | Description |
|---|---|---|
| `ORC_DB_PATH` | `~/.orc/orc.db` | SQLite database path |
| `ORC_API_PORT` | `7700` | API listen port |
| `ORC_API_SECRET` | — | Bearer token for auth |
| `ORC_SESSION_ID` | `default` | Per-agent session identifier |
| `ORC_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ORC_RUNNER_TIMEOUT` | `300` | Default job timeout (seconds) |
| `ORC_AGENT_LOOP_ENABLED` | `false` | Enable the agent task loop |
| `ORC_AGENT_LOOP_POLL_INTERVAL` | `5` | Task loop poll interval (minutes) |
| `ORC_AGENT_LOOP_MAX_WORKERS` | `1` | Max concurrent worker agents |
| `ORC_AGENT_LOOP_DEFAULT_BACKEND` | `claude` | Default agent backend |
| `ORC_AGENT_LOOP_IDLE_TIMEOUT` | `20` | Session idle timeout (minutes) |
| `ORC_AGENT_LOOP_AUTO_APPROVE` | `true` | Auto-approve worker tool permissions |

## Running as a service

**PM2** (any platform):
```bash
pm2 start "orc daemon start" --name orc
pm2 save && pm2 startup
```

**macOS (launchd):** Set `ProgramArguments` to `["/usr/local/bin/orc", "daemon", "start"]` with `RunAtLoad` and `KeepAlive`.

**Linux (systemd):** `ExecStart=/usr/local/bin/orc daemon start` with `Restart=on-failure`.

## Architecture

```
packages/
  core/           Config (Zod), types, logger, ULID IDs
  db/             Drizzle ORM + SQLite (~/.orc/orc.db)
  api/            Hono REST API + OpenAPI spec (:7700)
  sdk/            Typed HTTP client from OpenAPI
  cli/            Commander CLI (the `orc` binary)
  mcp/            MCP server (stdio)
  runner/         Job executor + cron/watch scheduler + task loop
  gateway/        Telegram + Slack bridge + agent sessions
  agent-runtime/  Shared agent backend registry (claude, codex)
  task-service/   Task status transitions, side-effects, comments
  tui/            Terminal UI (WIP)
```

Data flow: `Agent → MCP → API → DB` / `CLI → SDK → API → DB`

## Development

```bash
bun install       # install all workspace deps
bun dev           # API + CLI in watch mode
bun typecheck     # typecheck all packages
bun check         # biome lint + format
bun test          # run all tests
bun build         # build all packages
```

See [AGENTS.md](./AGENTS.md) for the full development guide and coding conventions.

## Learn more

- [Vision](./docs/vision.md) — why ORC exists and the problem it solves
- [Roadmap](./docs/roadmap.md) — what shipped and what's next
