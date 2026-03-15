# orc — Human + AI Orchestration Hub

> Persistent memory · Task management with HITL review · Generic job runner ·
> MCP server for Claude Code, Cursor, Codex, and Gemini CLI.
>
> One SQLite file. Shared across every agent you use.

---

## What it does

ORC is the shared brain between you and your AI agents. Every agent connects to the same store of tasks, memories, and jobs — so when you switch from Claude Code to Cursor, context doesn't evaporate.

- **Shared memory** — store decisions, rules, discoveries once; any agent can search them
- **Task board** — tasks move through `todo → doing → review → done`; agents submit for review, you approve
- **Job runner** — schedule any command (cron, repeat, file-watch, manual); logs every run
- **MCP server** — one config line connects any agent to all of the above
- **Session continuity** — hooks capture what happened; snapshots survive context compaction

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

# 2. In another terminal — try it
orc status
orc task add "Fix the auth bug" --priority high
orc mem add "Use RWMutex for token refresh" --type decision --scope myproject
orc job add nightly --command "echo hello" --trigger cron --cron "0 22 * * *"
```

The database is created automatically at `~/.orc/orc.db` on first run.

---

## Running as a service

Use `orc daemon start` for production — it starts the API, scheduler, file-watchers, and gateway in one process.

```bash
orc daemon start      # start all services
orc daemon status     # show scheduler state + next run times per job
orc daemon stop       # graceful shutdown
orc home              # show ~/.orc directory state + daemon status
```

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

## Agent Setup

### Claude Code

Copy `hooks/claude-code/settings.json` to `~/.claude/settings.json` and replace `/path/to/orc/` with your actual clone path:

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

| Hook | Fires when | What it does |
|---|---|---|
| `PostToolUse` | After Write / Edit / Bash / Shell | Records session events |
| `PreCompact` | Context window fills | Builds + stores ≤2KB snapshot |
| `SessionStart` | Session starts or restarts | Injects context or snapshot |

### Cursor

Add to `.cursor/mcp.json` in your project (or the global Cursor MCP config):

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

**Start every session with `context` — it returns active tasks + key memories in ~200 tokens.**

### Memory tools

| Tool | Description |
|---|---|
| `context` | Compact session start: active tasks + key memories |
| `memory_search` | 3-layer BM25 search: porter stemming → trigram → LIKE |
| `memory_timeline` | Chronological context around a memory ID |
| `memory_get` | Fetch full content by IDs (batch) |
| `memory_store` | Store a fact, decision, rule, event, or discovery |
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
| `task_list` | List active tasks — compact, no body |
| `task_get` | Full task detail by IDs |
| `task_create` | Create a task with title, body, priority, project |
| `task_update` | Update status, priority, or body |
| `task_submit_review` | HITL checkpoint — sets status to `review`, sends Telegram card |
| `task_check_review` | Poll review result: `pending` · `approved` · `changes_requested` |

**Task status flow:**

```
todo → doing → review → done
                     ↘ changes_requested → doing (again)
```

### Job tools

| Tool | Description |
|---|---|
| `job_list` | All jobs with last run status |
| `job_run` | Trigger a job by name |
| `job_status` | Status, exit code, and error for a run ID |

### Session tools

| Tool | Description |
|---|---|
| `session_event` | Record a significant action (file, task, decision, error, git…) |
| `session_snapshot` | Build ≤2KB XML snapshot of current session state |
| `session_restore` | Restore session state after compaction or restart |
| `session_log` | Log a session summary after completing a unit of work |

---

## CLI Reference

All commands accept global flags: `--port`, `--host`, `--secret`, `--db`, `--log-level`.

```
orc daemon start             Start API + scheduler + file-watchers + gateway
orc daemon stop              Send SIGTERM to running daemon
orc daemon status            Show scheduler state + next run times per job
orc home                     Show ~/.orc directory, daemon state, and config

orc api                      Start the API server only (no scheduler)
orc mcp                      Start the MCP server in stdio mode
orc status                   Show API health, task count, memory count

orc task list [--status]     List tasks (default: active)
orc task add <title>         Create a task (--priority, --body, --project)
orc task done <id>           Mark a task done (accepts full ULID or 6-char suffix)
orc task review <id>         Submit task for HITL review
orc task approve <id>        Approve a review
orc task reject <id>         Request changes (HITL)

orc mem list                 List recent memories (--limit)
orc mem add <content>        Store a memory (--type, --scope, --title)
orc mem search <query>       Search memories via BM25 + trigram (--scope, --limit)

orc job list                 List all jobs with trigger type and run count
orc job add <name>           Create a job (--command, --trigger, --cron, --watch)
orc job run <name>           Trigger a job immediately
orc job runs <name>          Show run history (--logs, --sessions, --limit)

orc session list             List recent agent sessions (--agent, --limit)
orc session show <id>        Show session detail (--events, --snapshot, --limit)
orc session log <summary>    Log a session summary (--agent, --agent-version)
```

---

## Cross-agent collaboration

All agents share one SQLite file. This is intentional.

```
Claude Code  ──┐
Cursor       ──┤──→  ~/.orc/orc.db  ←──  orc cli (you)
Codex        ──┘
```

A task created by Claude Code appears in Cursor's `context`. A rule stored by Codex shows up in Claude Code's `memory_search`. Session snapshots built by one agent are restorable by another.

Set `ORC_SESSION_ID` per agent (`cursor`, `codex`, `claude-code`) so sessions don't collide. Use `decision` and `rule` memory types — they surface automatically in context even when old.

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
