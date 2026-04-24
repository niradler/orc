<div align="center">

# orc

**Multi-agent orchestrator with human-in-the-loop review**

[![npm version](https://img.shields.io/npm/v/orc-ai?style=flat-square)](https://www.npmjs.com/package/orc-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.1-f472b6?style=flat-square&logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)

One SQLite file. One CLI. Any agent.<br>
ORC coordinates Claude Code, Cursor, Codex, Gemini, and remote A2A agents through a shared task board, persistent memory, and a review flow that keeps you in control.

<img src="assets/Architecture.gif" alt="ORC Architecture" width="700" />

</div>

## Overview

Every AI agent session is an island. Start a new session and it knows nothing about the last one. Run two in parallel and they can't coordinate. Switch agents and you start from zero.

ORC fixes this. Shared memory across every session. A task board where agents submit work and you approve it. A scheduler that runs agents on a cron. All backed by a single SQLite file - no cloud, no account, no subscription.

### Key features

| Feature                   | What it does                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Agent orchestration**   | Task loop spawns workers across backends (Claude Code, Codex, Gemini, Copilot, A2A), manages concurrency and review cycles         |
| **Human-in-the-loop**     | Agents submit work for your approval via CLI, Telegram, or Slack before anything lands                                             |
| **Shared memory**         | Decisions, rules, and discoveries stored once, searchable by any session via ranked full-text search                               |
| **Task board**            | `todo → queued → doing → review → done` with dependency tracking, priority, and automatic unblocking                               |
| **Multi-backend routing** | Route to Claude Code, ACPX (Agent Communication Protocol, 14+ agents), or remote A2A endpoints; unknown names fall through to ACPX |
| **Job runner**            | Cron, file-watch, webhook, or manual triggers with full run history                                                                |
| **MCP server**            | 28 tools connect any [Model Context Protocol](https://modelcontextprotocol.io) (MCP) compatible agent — stdio or Streamable HTTP   |
| **Session continuity**    | Snapshots survive context compaction so agents resume where they left off                                                          |
| **Gateway**               | Approve work, search memory, and chat with live agents from Telegram or Slack                                                      |
| **Knowledge search**      | Index document collections (markdown, notes, wikis) and search them via BM25 or hybrid (vector + reranking)                        |
| **Skill library**         | Discoverable workflow templates (coder, reviewer, planner, bugfix) that encode your standards                                      |

## Getting started

### Prerequisites

- [Bun](https://bun.sh) >= 1.1

### Install

```bash
npm install -g orc-ai
```

<details>
<summary>Other installation methods</summary>

#### Pre-built binaries

Download from [GitHub Releases](https://github.com/niradler/orc/releases):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-mac-arm64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# macOS (Intel)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-mac-x64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# Linux (x64)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-linux-x64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# Linux (ARM64)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-linux-arm64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# Windows - download orc-windows-x64.exe from the release page and add to PATH
```

#### From source

```bash
git clone https://github.com/niradler/orc
cd orc && bun install && bun build
```

</details>

### Quick start

```bash
# 1. Start the daemon - runs the REST API on :7700, task loop, job scheduler, gateway, and web UI
orc daemon start

# 2. Create a project
orc project add my-app -d "My application"
orc project use my-app

# 3. Add tasks and memories - everything auto-scopes to my-app
orc task add "Fix the auth bug" --priority high
orc mem add "Use RWMutex for token refresh" --type decision
orc job add nightly --command "bun run test" --trigger cron --cron "0 22 * * *"

# 4. See everything
orc status
orc task list
```

Open `http://localhost:7700` to use the web dashboard - task board, kanban, jobs, memories, sessions, knowledge, and a live chat panel. The same server hosts both the REST API and the prebuilt React SPA, so there is no separate command to run for the UI.

> [!TIP]
> The database is created automatically at `~/.orc/orc.db` on first run. No setup needed.

### Web dashboard

The web dashboard ships inside the `orc` binary and is served by the API process at the root path. Endpoints are still reachable at both `/<route>` (legacy SDK/CLI/MCP) and `/api/<route>` (used by the dashboard's browser client).

| Route                            | Served from                                                         |
| -------------------------------- | ------------------------------------------------------------------- |
| `GET /`                          | `index.html` (web SPA shell)                                        |
| `GET /assets/*`                  | Built JS/CSS bundles                                                |
| `GET /api/*`                     | All REST routes (mirrors the root mount)                            |
| `GET /openapi.json`, `GET /docs` | Swagger UI                                                          |
| `GET /tasks`, `/memories`, …     | Same handler as `/api/<...>`, kept for SDK/CLI/MCP backwards compat |

Override the served dist directory with `ORC_WEB_DIST=/path/to/web/dist` if you want to host a custom build (e.g. a fork). If no dist is found, the server runs in pure-API mode.

## Docker

Run ORC in a container with the published image:

```bash
docker run -d --name orc \
  -p 7700:7700 \
  -v orc-data:/data \
  -e ORC_API_SECRET=changeme \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  niradler/orc:latest
```

Or with [docker-compose.yml](docker-compose.yml):

```bash
docker compose up -d
```

The container defaults to the `claude` backend (direct Anthropic API via SDK — no host CLI needed). To delegate to an agent running on the host instead, set `ORC_AGENT_LOOP_DEFAULT_BACKEND=agentapi` and run [coder/agentapi](https://github.com/coder/agentapi) on the host:

```bash
agentapi server --allowed-hosts '*' -- \
  claude --allowedTools all \
         --mcp-config '{"mcpServers":{"orc":{"type":"http","url":"http://localhost:7700/mcp"}}}'
```

The `--mcp-config` flag wires the host agent back to ORC's [HTTP MCP endpoint](#mcp-tools) so it can call `task_update`, `memory_*`, `knowledge_*`, etc. `host.docker.internal` lets the container reach agentapi on the host.

## Connect your agent

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|StrReplace|EditNotebook|Bash|Shell|Agent|EnterPlanMode|ExitPlanMode|mcp__orc__task_|mcp__orc__memory_store|mcp__orc__memory_delete|mcp__orc__job_run|mcp__orc__job_create|mcp__orc__job_update",
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/orc/hooks/post-tool-use.ts"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/orc/hooks/pre-compact.ts"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/orc/hooks/session-start.ts"
          }
        ]
      }
    ]
  },
  "env": { "ORC_API_BASE": "http://127.0.0.1:7700", "ORC_PROJECT": "" }
}
```

> [!NOTE]
> Replace `/path/to/orc/` with the path to your ORC clone or the installed package location (run `npm root -g` to find global installs). Hooks handle session events and snapshots automatically.

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

<details>
<summary>Codex, Gemini CLI, and other MCP agents</summary>

**Codex** - Copy `hooks/codex/settings.json` to `~/.codex/settings.json` and update the path.

**Gemini CLI / any MCP agent** - Add to your MCP config:

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

</details>

## Usage

### How agents use ORC

```
1. Agent starts          → context() returns active tasks + key memories
2. Agent works           → creates tasks, stores decisions, records events
3. Agent submits work    → task_update(status: "review", comment: "summary")
4. You review            → approve or request changes via CLI / Telegram / Slack
5. Agent continues       → picks up next task or resumes with feedback
6. Session ends          → session_log() records what happened
```

When a context window fills up, `session_snapshot` captures current state into a compact 2KB blob that `session_restore` injects back after compaction - the agent picks up where it left off.

### Agent orchestration

The task loop automatically picks up queued tasks and spawns worker agents:

```bash
# Create a task with a workflow and backend
orc task add "Implement user auth" --skill orc-coder --backend claude --priority high

# Or batch-create with dependencies via MCP
task_batch_create({ tasks: [
  { title: "Design schema", skill_name: "orc-planner" },
  { title: "Implement API",  skill_name: "orc-coder", blocked_by: [0] },
  { title: "Review code",    skill_name: "orc-reviewer", blocked_by: [1] }
]})
```

The loop handles concurrency, session resume on feedback, review round limits, stale claim cleanup, and backend routing.

#### Agent backends

| Backend         | Description                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `claude`        | Anthropic Claude via [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — no host CLI needed. Requires `ANTHROPIC_API_KEY`. |
| `agentapi`      | Delegates to a [coder/agentapi](https://github.com/coder/agentapi) server on the host (HTTP+SSE) — wraps any local coding agent (`claude`, `codex`, `aider`, …). Auth is whatever the host agent uses. |
| `acpx`          | 14+ agents via [ACP CLI](https://github.com/AgenTool/acpx) - Codex, Gemini, Copilot, Kiro, Cursor, and more. |
| `a2a`           | Remote agents via [Google A2A protocol](https://github.com/google/A2A) (JSON-RPC over HTTP).                 |
| _anything else_ | Routes through ACPX with the name as `--agent` flag.                                                         |

Enable the task loop in `~/.orc/config.json`:

```json
{
  "agent_loop": {
    "enabled": true,
    "poll_interval_minutes": 5,
    "max_workers": 1,
    "default_backend": "claude",
    "session_idle_timeout_minutes": 20,
    "worker_auto_approve": true
  }
}
```

### Projects

Projects group tasks, memories, and jobs. Set an active project and all commands auto-scope:

```bash
orc project add my-app -d "Main application"
orc project use my-app       # set active

orc task list                 # scoped to my-app
orc mem search "auth"         # scoped to my-app
orc task list -p infra        # override to different project
orc task list --no-project    # see everything
```

**Resolution order:** explicit `-p <name>` > `activeProject` from config > error

MCP tools follow the same logic - pass `project: "name"` to scope, or omit to use the active project.

### Memory

Store decisions, conventions, and discoveries that persist across all sessions:

```bash
orc mem add "All IDs are ULIDs" --type rule
orc mem add "Use PostgreSQL for concurrent writes" --type decision
orc mem search "authentication"
```

| Type        | Weight | Use for                                         |
| ----------- | ------ | ----------------------------------------------- |
| `rule`      | High   | Conventions: "all IDs are ULIDs"                |
| `decision`  | High   | Choices: "use PostgreSQL for concurrent writes" |
| `discovery` | Medium | Findings: "token refresh has a race condition"  |
| `event`     | Low    | Things that happened: "deployed v1.0"           |
| `fact`      | Low    | General knowledge (default)                     |

### Knowledge

Index existing document collections (markdown, notes, code docs) and make them searchable by any agent. Unlike memory (short agent-authored notes), knowledge searches pre-existing files on disk.

```bash
# Add a document collection
orc knowledge add my-docs --path ~/projects/docs --pattern "**/*.md"

# Search across indexed documents
orc knowledge search "authentication flow"

# List collections
orc knowledge list

# Re-index after files change
orc knowledge update
```

Knowledge uses [QMD](https://github.com/nicholasgriffintn/qmd) as the search engine. By default it runs BM25 full-text search (no LLM needed). Set `search_mode: "hybrid"` in config for vector search with reranking - embeddings are generated automatically when documents are indexed.

Collections can be scoped to projects. When scoped, searches and listing filter to only that project's collections.

**MCP tools:** `knowledge_search`, `knowledge_get`, `knowledge_collections`, `knowledge_collection_add`, `knowledge_collection_remove`, `knowledge_update`

### Task status flow

```
todo → queued → doing → review → done
                  │         │
                  v         v
               blocked    changes_requested → doing
                  │
                  v
                paused
```

Tasks with `required_review: true` (default) need your approval before moving to `done`. Set `max_review_rounds` to auto-pause tasks that cycle through too many revision rounds.

<img src="assets/TaskFlow.gif" alt="Task Flow" width="600" />

### Jobs

```bash
orc job add deploy    --command "bun run deploy"    --trigger manual
orc job add nightly   --command "bun run test"      --trigger cron --cron "0 22 * * *"
orc job add on-change --command "bun run lint"      --trigger watch --watch "./src"
orc job add on-push   --command "bun run ci"        --trigger webhook
```

### Gateway (Telegram / Slack)

Approve agent work from your phone, search memory, or start a live AI session.

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

> [!TIP]
> Create a Telegram bot via [@BotFather](https://t.me/BotFather) and find your user ID via [@userinfobot](https://t.me/userinfobot).

<details>
<summary>Slack setup</summary>

```json
{
  "gateway": {
    "slack": {
      "enabled": true,
      "bot_token": "xoxb-...",
      "app_token": "xapp-...",
      "authorized_users": ["U01ABCDEF"]
    }
  }
}
```

Same commands as Telegram. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) with Socket Mode enabled.

</details>

## Skills

ORC ships with agent workflow skills and built-in skill templates for the task loop.

### Install skills

```bash
# Install all ORC skills into your agent
npx skills add niradler/orc --all

# Or pick specific ones
npx skills add niradler/orc --skill orc-session orc-tasks

# Global install
npx skills add niradler/orc --all -g
```

### Agent workflow skills

| Skill           | Triggers on                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `orc-session`   | Session start, context compaction, resuming work                           |
| `orc-tasks`     | Task creation, status updates, HITL review, task decomposition             |
| `orc-knowledge` | Storing decisions, searching memory, "remember this", "what did we decide" |
| `orc-gateway`   | Telegram/Slack setup, remote approval, live agent sessions                 |

### Built-in skill templates

Skill templates live in `skills/*/SKILL.md` (built-in) and `~/.orc/skills/` (user-defined). Agents discover them via `skill_list` and load with `skill_read`.

| Skill              | Type     | Purpose                                                                     |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `orc-worker-base`  | Base     | Default worker behavior - ORC awareness, status updates, deliverable format |
| `orc-main-base`    | Base     | Orchestration agent - planning, decomposition, monitoring                   |
| `orc-coder`        | Workflow | Implementation - understand, plan, implement, verify, submit                |
| `orc-planner`      | Workflow | Task decomposition with dependencies and workflow assignment                |
| `orc-reviewer`     | Workflow | Structured evaluation - correctness, tests, security, conventions           |
| `orc-bugfix`       | Workflow | Bug investigation - reproduce, root-cause, fix, regression test             |
| `orc-requirements` | Skill    | Requirements interview - outcome, criteria, constraints, scope              |
| `orc-report`       | Skill    | Project status report - health summary, blockers, active work               |

Add custom skills by creating a `SKILL.md` in `~/.orc/skills/my-workflow/SKILL.md`.

## MCP tools

**28 tools** available to any connected agent. Start every session with `context`.

| Category      | Tools                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project**   | `project_list`                                                                                                                              |
| **Memory**    | `context`, `memory_search`, `memory_get`, `memory_store`, `memory_update`                                                                   |
| **Task**      | `task_list`, `task_get`, `task_create`, `task_update`, `task_batch_create`                                                                  |
| **Skill**     | `skill_list`, `skill_read`, `skill_create`                                                                                                  |
| **Knowledge** | `knowledge_search`, `knowledge_get`, `knowledge_collections`, `knowledge_collection_add`, `knowledge_collection_remove`, `knowledge_update` |
| **Search**    | `search`                                                                                                                                    |
| **Job**       | `job_list`, `job_run`, `job_status`                                                                                                         |
| **Session**   | `session_event`, `session_snapshot`, `session_restore`, `session_log`                                                                       |

## REST API

Runs on port 7700 with auto-generated OpenAPI spec.

- **Swagger UI:** `GET /docs`
- **OpenAPI spec:** `GET /openapi.json`

<details>
<summary>Full endpoint list</summary>

| Method                  | Path                           | Description                    |
| ----------------------- | ------------------------------ | ------------------------------ |
| `GET`                   | `/health`                      | Health check                   |
| `GET/POST/PATCH/DELETE` | `/projects`                    | CRUD projects                  |
| `GET`                   | `/projects/by-name/{name}`     | Lookup by name                 |
| `GET`                   | `/projects/{id}/summary`       | Task/memory/job counts         |
| `GET/POST/PATCH/DELETE` | `/tasks`                       | CRUD tasks                     |
| `GET/POST`              | `/tasks/{id}/notes`            | Task notes                     |
| `GET/POST/DELETE`       | `/tasks/{id}/links`            | Task dependencies              |
| `GET/POST/DELETE`       | `/memories`                    | CRUD memories                  |
| `GET`                   | `/memories/search`             | BM25 search                    |
| `GET`                   | `/knowledge/search`            | Search documents (BM25/hybrid) |
| `GET`                   | `/knowledge/documents/{id}`    | Get document by docid          |
| `GET/POST/DELETE`       | `/knowledge/collections`       | CRUD collections               |
| `POST`                  | `/knowledge/update`            | Re-index collections           |
| `GET`                   | `/knowledge/status`            | Index status                   |
| `GET/POST`              | `/jobs`                        | CRUD jobs                      |
| `POST`                  | `/jobs/{id}/trigger`           | Trigger a job                  |
| `GET`                   | `/jobs/{id}/runs`              | Run history                    |
| `GET`                   | `/jobs/{id}/runs/{runId}/logs` | Run logs                       |
| `GET`                   | `/skills`                      | Skill templates                |
| `GET`                   | `/sessions`                    | Agent session logs             |
| `POST`                  | `/mcp/tool`                    | Execute any MCP tool via HTTP  |

</details>

## CLI reference

```
orc daemon start|stop|status     Manage the daemon (API + scheduler + gateway)
orc daemon install|uninstall     Register/remove auto-start on login/boot
orc api                          Start the API server only
orc mcp                          Start the MCP server (stdio)
orc home                         Show ~/.orc directory and config
orc status                       Show API health and counts

orc project list|add|show|use|update|archive
orc task list|add|show|update|done|review|approve|reject|delete
orc mem list|add|search
orc job list|add|run|runs
orc session list|show|log
orc skill list|show
orc kb search|get|collections|add|remove|update|status
```

> [!NOTE]
> All task/mem/job/kb commands default to the active project. Use `-p <name>` to override or `--no-project` to see everything. Add `--json` for machine-readable output.

## Configuration

ORC merges config in priority order (later wins):

1. `~/.orc/config.json` - user global
2. `./.orc/config.json` - project-local
3. Environment variables

<details>
<summary>Environment variables</summary>

| Variable                         | Default               | Description                                       |
| -------------------------------- | --------------------- | ------------------------------------------------- |
| `ORC_DB_PATH`                    | `~/.orc/orc.db`       | SQLite database path                              |
| `ORC_API_HOST`                   | `127.0.0.1`           | API listen host (set to `0.0.0.0` in Docker)      |
| `ORC_API_PORT`                   | `7700`                | API listen port                                   |
| `ORC_API_SECRET`                 | -                     | Bearer token for auth                             |
| `ORC_TELEGRAM_TOKEN`             | -                     | Enables the Telegram gateway when set             |
| `AGENTAPI_URL`                   | `http://127.0.0.1:3284` | URL of host agentapi server (for `agentapi` backend) |
| `ANTHROPIC_API_KEY`              | -                     | Required for the `claude` backend (Anthropic SDK) |
| `ORC_SESSION_ID`                 | `default`             | Per-agent session identifier                      |
| `ORC_LOG_LEVEL`                  | `info`                | `debug`, `info`, `warn`, `error`                  |
| `ORC_LOG_DIR`                    | `~/.orc/logs`         | Log file directory                                |
| `ORC_LOG_FILE`                   | `1`                   | Set to `0` to disable file logging                |
| `ORC_RUNNER_TIMEOUT`             | `300`                 | Default job timeout (seconds)                     |
| `ORC_AGENT_LOOP_ENABLED`         | `false`               | Enable the agent task loop                        |
| `ORC_AGENT_LOOP_POLL_INTERVAL`   | `5`                   | Task loop poll interval (minutes)                 |
| `ORC_AGENT_LOOP_MAX_WORKERS`     | `1`                   | Max concurrent worker agents                      |
| `ORC_AGENT_LOOP_DEFAULT_BACKEND` | `claude`              | Default agent backend                             |
| `ORC_AGENT_LOOP_IDLE_TIMEOUT`    | `20`                  | Session idle timeout (minutes)                    |
| `ORC_AGENT_LOOP_AUTO_APPROVE`    | `true`                | Auto-approve worker tool permissions              |
| `ORC_KNOWLEDGE_DB_PATH`          | `~/.orc/knowledge.db` | Knowledge search database path                    |
| `ORC_KNOWLEDGE_SEARCH_MODE`      | `lexical`             | `lexical` (BM25) or `hybrid` (vector + reranking) |

</details>

### Logs

All output goes to **stderr** (colored, human-readable) and **`~/.orc/logs/orc.log`** (JSON lines, machine-readable). Log files rotate at 10 MB with 3 rotated backups (30 MB total).

```bash
# Tail recent errors
grep '"level":"error"' ~/.orc/logs/orc.log | tail -20

# Watch live
tail -f ~/.orc/logs/orc.log | jq .
```

### Running as a background service

The daemon runs the API server, job scheduler, file watchers, and gateway in one process. To start it automatically on login/boot:

```bash
orc daemon install     # register auto-start for your OS
orc daemon uninstall   # remove auto-start registration
```

| Platform    | Mechanism                                                          | Auto-restart on crash |
| ----------- | ------------------------------------------------------------------ | --------------------- |
| **Windows** | Registry Run key (`HKCU\...\Run`)                                  | No                    |
| **macOS**   | launchd (`~/Library/LaunchAgents/com.orc.daemon.plist`)            | Yes                   |
| **Linux**   | systemd user service (`~/.config/systemd/user/orc-daemon.service`) | Yes                   |

No admin/root privileges required on any platform.

```bash
# Manual control
orc daemon start       # start in foreground (API + scheduler + gateway)
orc daemon stop        # stop a running daemon
orc daemon status      # show scheduled jobs
orc api                # start the API server only (no scheduler/gateway)

# Check daemon health
curl http://localhost:7700/health
```

Logs go to `~/.orc/daemon.log`. Config is read from `~/.orc/config.json`.

## Architecture

```
packages/
  core/           Config (Zod), types, logger, ULID IDs
  db/             Drizzle ORM + SQLite (~/.orc/orc.db)
  api/            Hono REST API + OpenAPI spec (:7700)
  sdk/            Typed HTTP client from OpenAPI
  cli/            Commander CLI (the `orc` binary)
  mcp/            MCP server (stdio + Streamable HTTP at /mcp)
  runner/         Job executor + cron/watch scheduler + task loop
  gateway/        Telegram + Slack bridge + agent sessions
  agent-runtime/  Agent backend registry (claude, acpx, a2a)
  task-service/   Task status transitions + side-effects
  web/            React dashboard (Vite + Tailwind + shadcn + React Query)
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

- [Usage Guide](./docs/usage-guide.md) - best practices for memory, tasks, multi-agent workflows, and configuration
- [Vision](./docs/vision.md) - why ORC exists and the problem it solves
- [Roadmap](./docs/roadmap.md) - what shipped and what's next
- [Agent Orchestration Design](./docs/agent-orchestration-design.md) - architecture spec for the task loop and multi-agent workflow
