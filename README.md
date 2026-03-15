# orc — Human + AI Orchestration Hub

> Project management · Persistent memory · Task board with HITL review · Job runner ·
> MCP server for Claude Code, Cursor, Codex, and Gemini CLI.
>
> One SQLite file. Shared across every agent you use.

---

## What it does

ORC is the shared brain between you and your AI agents. **Projects** are the organizing hub — every task, memory, and job belongs to a project, so work stays grouped and discoverable across agents.

- **Projects** — group tasks, memories, and jobs under a named project; set an active project and all commands auto-scope to it
- **Shared memory** — store decisions, rules, discoveries; any agent can search them via BM25 full-text search
- **Task board** — tasks move through `todo → doing → review → done`; agents submit for human review, you approve or request changes
- **Job runner** — schedule any command (cron, file-watch, webhook, manual); logs every run with stdout/stderr
- **MCP server** — one config line connects any AI agent to all of the above
- **Session continuity** — hooks capture file edits, decisions, git ops; snapshots survive context compaction

---

## Install

### npm (recommended)

```bash
npm install -g orc-ai
# or
bun add -g orc-ai
```

> Requires [Bun](https://bun.sh) ≥ 1.1 as the runtime.

### From binary

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

# Windows — download orc.exe, add to PATH
```

### From source

```bash
git clone https://github.com/niradler/orc
cd orc
bun install
bun build
```

Add `dist/` to your `PATH`, or run `bun orc <command>` from the repo root.

---

## Quick Start

```bash
# 1. Start the daemon (API + scheduler + gateway)
orc daemon start

# 2. Create a project and set it as active
orc project add my-app -d "My application"
orc project use my-app

# 3. Everything auto-scopes to the active project
orc task add "Fix the auth bug" --priority high
orc task add "Add caching layer" --priority normal
orc mem add "Use RWMutex for token refresh" --type decision
orc job add nightly --command "bun run test" --trigger cron --cron "0 22 * * *"

# 4. See everything grouped under the project
orc project show
orc task list            # grouped by status with color
```

The database is created automatically at `~/.orc/orc.db` on first run.

---

## Project Management

Projects are the organizing hub. Every task, memory, and job belongs to a project.

### Creating and switching projects

```bash
orc project add my-app -d "Main application"
orc project add infra -d "Infrastructure and DevOps"

# Set active project — all commands auto-scope to it
orc project use my-app

# Now these all target my-app automatically:
orc task list
orc mem search "auth"
orc job list

# Explicitly target a different project:
orc task list -p infra

# See everything across all projects:
orc task list --no-project
```

### Project names

- **Unique, case-insensitive** — `my-app` and `My-App` are the same project
- **Characters**: letters, numbers, `-`, `_` only — human-readable, URL-safe
- **Used everywhere in CLI** instead of internal IDs

### Project dashboard

```bash
orc project show           # active project
orc project show my-app    # specific project
orc project list           # all projects with task/memory/job counts
```

### Active project

```bash
orc project use my-app       # set active project
orc project use --clear      # unset active project
```

The active project is stored in `~/.orc/config.json` under `activeProject`. When set, all CLI commands (`task`, `mem`, `job`) auto-scope to it. Use `-p <name>` to override or `--no-project` to bypass.

**Resolution order**: explicit `-p <name>` > `activeProject` from config > error

---

## How Agents Use ORC

### The workflow

```
1. Agent starts         → calls context() to get active tasks + key memories
2. Agent works          → creates tasks, stores decisions, records events
3. Agent submits work   → task_submit_review() for human approval
4. Human reviews        → approves or requests changes via CLI/Telegram
5. Agent continues      → checks review status, picks up next task
6. Session ends         → session_log() records what happened
```

### Agent session protocol

**Every agent session should:**

1. **Start with `context`** — returns active tasks + importance-weighted memories in ~200 tokens
2. **Use `project_list` / `project_get`** — discover and target the right project
3. **Create tasks with `project_id`** — keeps work organized
4. **Store knowledge with `memory_store`** — decisions, rules, and discoveries persist across sessions
5. **Submit for review** — `task_submit_review` triggers HITL approval via Telegram/Slack
6. **Record events** — `session_event` captures file edits, decisions, errors for context continuity
7. **End with `session_log`** — summarizes what happened for the next session

### Context survival

When an agent's context window fills up:
1. `PreCompact` hook calls `session_snapshot` → builds ≤2KB XML of current state
2. Context compacts (old messages dropped)
3. `SessionStart` hook calls `session_restore` → injects the snapshot back

The snapshot includes active tasks, recent file edits, decisions, and git ops — prioritized to fit the 2KB budget.

---

## Agent Setup

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Write|Edit|MultiEdit|StrReplace|Bash|Shell", "hooks": [{ "type": "command", "command": "bun /path/to/orc/hooks/post-tool-use.ts" }] }],
    "PreCompact":  [{ "matcher": "", "hooks": [{ "type": "command", "command": "bun /path/to/orc/hooks/pre-compact.ts" }] }],
    "SessionStart":[{ "matcher": "", "hooks": [{ "type": "command", "command": "bun /path/to/orc/hooks/session-start.ts" }] }]
  },
  "env": { "ORC_API_BASE": "http://127.0.0.1:7700" }
}
```

Replace `/path/to/orc/` with your actual clone path. Hooks handle session events and snapshots automatically.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "orc": {
      "command": "orc",
      "args": ["mcp"],
      "env": {
        "ORC_API_BASE": "http://127.0.0.1:7700",
        "ORC_SESSION_ID": "cursor"
      }
    }
  }
}
```

### Codex

Copy `hooks/codex/settings.json` to `~/.codex/settings.json` and replace the path placeholder.

### Gemini CLI

```json
{
  "mcpServers": {
    "orc": {
      "command": "orc",
      "args": ["mcp"],
      "env": {
        "ORC_API_BASE": "http://127.0.0.1:7700",
        "ORC_SESSION_ID": "gemini"
      }
    }
  }
}
```

---

## MCP Tools Reference

**21 tools** available to any connected agent.

**Start every session with `context` — it returns active tasks + key memories in ~200 tokens.**

### Project tools

| Tool | Description |
|---|---|
| `project_list` | List all projects with name, status, and ID |
| `project_get` | Get a project by name (case-insensitive) — returns ID and details |

### Memory tools

| Tool | Description |
|---|---|
| `context` | Compact session start: active tasks + importance-weighted memories |
| `memory_search` | 3-layer BM25 search: porter stemming → trigram → LIKE. Filter by `type`, `scope`, `project_id` |
| `memory_timeline` | Chronological context around a memory ID |
| `memory_get` | Fetch full content by IDs (batch up to 20) |
| `memory_store` | Store a fact, decision, rule, event, or discovery. Pass `project_id` to scope |
| `memory_delete` | Delete a memory by ID |

**Memory types** — `rule` and `decision` are weighted higher in `context`:

| Type | Use for |
|---|---|
| `decision` | Choices made: "we use PostgreSQL because of concurrent writes" |
| `rule` | Conventions: "all IDs are ULIDs", "never use `any`" |
| `discovery` | Findings: "auth token refresh has a race condition" |
| `event` | Things that happened: "deployed v0.1.0 to staging" |
| `fact` | General knowledge (default) |

### Task tools

| Tool | Description |
|---|---|
| `task_list` | List active tasks — compact, no body. Filter by `project_id`, `status` |
| `task_get` | Full task detail by IDs (batch up to 10) |
| `task_create` | Create a task with title, body, priority, `project_id` |
| `task_update` | Update status, priority, or body |
| `task_submit_review` | HITL checkpoint — sets status to `review`, appends summary to body, sends Telegram card |
| `task_check_review` | Poll review result: `pending` / `approved` / `changes_requested` |

**Task status flow:**

```
todo → doing → review → done
                     ↘ changes_requested → doing (again)
```

### Job tools

| Tool | Description |
|---|---|
| `job_list` | All jobs with last run status. Filter by `project_id` |
| `job_run` | Trigger a job by name |
| `job_status` | Status, exit code, and error for a run ID |

### Session tools

| Tool | Description |
|---|---|
| `session_event` | Record a significant action (file, task, decision, error, git…). Auto-deduped. |
| `session_snapshot` | Build ≤2KB XML snapshot of current session state |
| `session_restore` | Restore session state after compaction or restart |
| `session_log` | Log a session summary after completing a unit of work |

---

## CLI Reference

All commands accept global flags: `--port`, `--host`, `--secret`, `--db`, `--log-level`.

All task/mem/job commands default to the active project. Use `-p <name>` to target a specific project or `--no-project` to see everything.

```
orc daemon start             Start API + scheduler + file-watchers + gateway
orc daemon stop              Send SIGTERM to running daemon
orc daemon status            Show scheduler state + next run times per job
orc home                     Show ~/.orc directory, daemon state, and config

orc api                      Start the API server only (no scheduler)
orc mcp                      Start the MCP server in stdio mode
orc status                   Show API health, task count, memory count

orc project list             List projects with task/memory/job counts
orc project add <name>       Create a project (-d, --scope, --tags)
orc project show [name]      Project dashboard (defaults to active project)
orc project use <name>       Set active project (--clear to unset)
orc project update <name>    Update project fields
orc project archive <name>   Archive a project

orc task list                List tasks grouped by status (--flat, --status, -p)
orc task add <title>         Create a task (--priority, --body)
orc task done <id>           Mark a task done (6-char suffix or full ULID)
orc task review <id>         Submit task for HITL review
orc task approve <id>        Approve a review
orc task reject <id>         Request changes (HITL)

orc mem list                 List recent memories (--limit, -p)
orc mem add <content>        Store a memory (--type, --scope, --title)
orc mem search <query>       Search via BM25 + trigram (--scope, --limit, -p)

orc job list                 List jobs with trigger type and run count (-p)
orc job add <name>           Create a job (--command, --trigger, --cron, --watch)
orc job run <name>           Trigger a job immediately
orc job runs <name>          Show run history (--logs, --sessions, --limit)

orc session list             List recent agent sessions (--agent, --limit)
orc session show <id>        Show session detail (--events, --snapshot)
orc session log <summary>    Log a session summary (--agent, --agent-version)
```

---

## Running as a service

Use `orc daemon start` for production — it starts the API, scheduler, file-watchers, and gateway in one process.

**macOS — launchd**: set `ProgramArguments` to `["/usr/local/bin/orc", "daemon", "start"]` with `RunAtLoad` and `KeepAlive`.

**Linux — systemd**: `ExecStart=/usr/local/bin/orc daemon start` with `Restart=on-failure`.

**Any platform — PM2**:
```bash
pm2 start "orc daemon start" --name orc
pm2 save && pm2 startup
```

---

## Configuration

ORC merges config in this priority order (later wins):

1. `~/.orc/config.json` — user global
2. `./.orc/config.json` — project-local
3. Environment variables

```json
{
  "activeProject": "my-app",
  "db": { "path": "~/.orc/orc.db" },
  "api": {
    "port": 7700,
    "host": "127.0.0.1",
    "secret": "optional-bearer-token-for-auth"
  },
  "context": {
    "task_limit": 10,
    "memory_limit": 8
  }
}
```

| Variable | Default | Description |
|---|---|---|
| `ORC_DB_PATH` | `~/.orc/orc.db` | SQLite database path |
| `ORC_API_PORT` | `7700` | API listen port |
| `ORC_API_SECRET` | — | Bearer token for auth |
| `ORC_SESSION_ID` | `default` | Per-agent session identifier |
| `ORC_LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `ORC_RUNNER_TIMEOUT` | `300` | Default job timeout in seconds |

---

## Cross-agent collaboration

All agents share one SQLite file. This is intentional.

```
Claude Code  ──┐
Cursor       ──┤──→  ~/.orc/orc.db  ←──  orc cli (you)
Codex/Gemini ──┘
```

A task created by Claude Code appears in Cursor's `context`. A rule stored by Codex shows up in Claude Code's `memory_search`. Session snapshots built by one agent are restorable by another.

**Best practices:**
- Set `ORC_SESSION_ID` per agent (`cursor`, `codex`, `claude-code`) so sessions don't collide
- Use `decision` and `rule` memory types — they surface automatically in `context` even when old
- Always pass `project_id` when creating tasks/memories — keeps cross-agent work organized
- Use `task_submit_review` for any work that needs human sign-off before proceeding

---

## Gateway

The gateway connects Telegram and Slack to your ORC instance and to live AI agent sessions. Run it with `orc daemon start`.

- Approve or reject agent work from your phone (HITL review cards)
- Start a live Claude / Codex session and chat with it from Telegram or Slack
- Run jobs and search memory without opening a terminal

### Telegram setup

1. Create a bot via [@BotFather](https://t.me/BotFather), copy the token
2. Find your user ID via [@userinfobot](https://t.me/userinfobot)
3. Add to `~/.orc/config.json`:

```json
{
  "gateway": {
    "telegram": {
      "enabled": true,
      "token": "7123456789:AAF...",
      "authorized_users": [123456789],
      "mode": "direct"
    }
  }
}
```

### Bot commands

```
/status             ORC health + task/memory counts
/tasks              List active tasks
/approve <id>       Approve a HITL review
/reject <id>        Reject with note
/jobs               List jobs with last run status
/run <name>         Trigger a job immediately
/mem <query>        Search memories
/agent <claude|codex>   Start live session
```

---

## Jobs

```bash
# Manual (trigger on-demand)
orc job add deploy --command "bun run deploy" --trigger manual

# Cron (5-field expression)
orc job add nightly --command "claude --print '...'" --trigger cron --cron "0 22 * * *"

# Cron every 30 seconds (6-field, seconds first)
orc job add heartbeat --command "curl http://myservice/ping" --trigger cron --cron "*/30 * * * * *"

# File-watch (fires when a path changes)
orc job add on-change --command "bun run lint" --trigger watch --watch "./src"

# Webhook (triggered via HTTP POST to /webhooks/<token>)
orc job add on-push --command "bun run ci" --trigger webhook
```

---

## REST API

The API runs on port 7700 with auto-generated OpenAPI spec.

- `GET /docs` — Swagger UI
- `GET /openapi.json` — OpenAPI 3.1 spec

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET/POST/PATCH/DELETE` | `/projects` | CRUD projects |
| `GET` | `/projects/by-name/{name}` | Lookup by name (case-insensitive) |
| `GET` | `/projects/{id}/summary` | Task/memory/job counts |
| `GET/POST/PATCH/DELETE` | `/tasks` | CRUD tasks |
| `POST` | `/tasks/{id}/review` | Submit for review |
| `GET` | `/tasks/{id}/review` | Check review status |
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

---

## Contributing

See [AGENTS.md](./AGENTS.md) for the full development guide, package layout, and coding conventions.

```bash
bun install          # install all workspace deps
bun dev              # API in watch mode
bun typecheck        # typecheck all packages
bun check            # biome lint + format (auto-fix)
bun test             # run all tests
bun build            # build all packages
```
