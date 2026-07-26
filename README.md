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
| **Multi-backend routing** | Route to Claude (in-process, nothing to install), ACPX (14+ agents), agentapi, or remote A2A endpoints — with `orc doctor` reporting which are usable |
| **Job runner**            | Cron, file-watch, webhook, or manual triggers with full run history                                                                |
| **MCP server**            | 34 tools connect any [Model Context Protocol](https://modelcontextprotocol.io) (MCP) compatible agent — stdio or Streamable HTTP   |
| **Session continuity**    | Snapshots survive context compaction so agents resume where they left off                                                          |
| **Gateway**               | Approve work, search memory, and chat with live agents from Telegram or Slack                                                      |
| **Knowledge search**      | Index document collections (markdown, notes, wikis) and search them via BM25 or hybrid (vector + reranking)                        |
| **Skill library**         | Discoverable workflow templates (coder, reviewer, planner, bugfix) that encode your standards                                      |
| **Task flows**            | Per-task graphs: conditional edges, bounded loops, parallel fan-out with joins, and human gates — with hard termination rails      |

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

Open `http://localhost:7700` to use the web dashboard - task board, kanban, flow runs, jobs, memories, sessions, knowledge, and a live chat panel. The same server hosts both the REST API and the prebuilt React SPA, so there is no separate command to run for the UI.

> [!TIP]
> The database is created automatically at `~/.orc/orc.db` on first run. No setup needed.

### Web dashboard

The web dashboard ships inside the `orc` binary and is served by the API process at the root path. REST routes live under `/api/<route>` - the SDK, CLI and MCP clients add that prefix themselves - which leaves the root path free for the SPA.

| Route                              | Served from                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                            | `index.html` (web SPA shell)                                                                                                   |
| `GET /assets/*`                    | Built JS/CSS bundles                                                                                                           |
| `GET /api/*`                       | All REST routes                                                                                                                |
| `GET /openapi.json`, `GET /docs`   | Swagger UI                                                                                                                     |
| `GET /mcp`                         | MCP server (streamable HTTP)                                                                                                   |
| `GET /tasks/<id>`, `/flows/<name>`, … | `index.html` again - a navigation request matching no static file falls back to the SPA shell, so dashboard links are shareable |

Override the served dist directory with `ORC_WEB_DIST=/path/to/web/dist` if you want to host a custom build (e.g. a fork). If no dist is found, the server runs in pure-API mode.

## Docker

Run ORC in a container with the published image:

```bash
docker run -d --name orc \
  -p 7700:7700 \
  -v orc-data:/data \
  -e ORC_API_SECRET=$(openssl rand -hex 32) \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  niradler/orc:latest
```

> The container binds `0.0.0.0`. Set a strong `ORC_API_SECRET` before exposing the
> mapped port beyond localhost — without it, every endpoint (including job execution,
> which runs arbitrary shell commands) is open to anyone who can reach the port.

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

Every task runs a **flow graph** (see [Task flows](#task-flows)); `orc-default` is the build → review → done pipeline described above.

#### Agent backends

| Backend         | Needs                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `claude`        | Nothing to install: runs **in-process** via [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which ships with orc. Uses the Claude Code CLI's stored credentials, or `ANTHROPIC_API_KEY`. The default. |
| `acpx`          | The [ACP CLI](https://github.com/openclaw/acpx) — 14+ agents (Codex, Gemini, Copilot, Kiro, Cursor, …). Installed as an optional dependency, so a normal `npm i -g orc-ai` gets it; orc finds it there even when it is not on your `PATH`. Point `ORC_ACPX_PATH` at a specific copy to override. |
| `agentapi`      | A [coder/agentapi](https://github.com/coder/agentapi) server on the host (HTTP+SSE), wrapping any local coding agent. `AGENTAPI_URL` if it is not on the default port. |
| `a2a`           | A remote [A2A](https://github.com/google/A2A) endpoint, supplied per task/session — nothing local.            |
| `claude-cli`    | The `claude` binary on `PATH`. The pre-SDK path, kept for when driving the real CLI matters.                  |
| `codex-cli`     | The `codex` binary on `PATH`, driven natively instead of through acpx.                                        |
| _anything else_ | Passed to acpx as its agent name, so `--agent-backend gemini` means "acpx driving gemini".                    |

Which of these actually work on a given machine depends on what is installed, so orc probes them rather than making you guess:

```bash
orc doctor          # per backend: usable or not, what it resolved to, what a missing one needs
orc doctor --json   # same, machine-readable
```

The dashboard shows the same probe: the agent-backend field on a task is a picker that marks each backend ready or unavailable, and names the one a task with no backend of its own will use. `GET /api/backends` is the endpoint behind both.

Enable the task loop in `~/.orc/config.json`:

```json
{
  "agent_loop": {
    "enabled": true,
    "poll_interval_minutes": 5,
    "max_workers": 1,
    "default_backend": "claude",
    "session_idle_timeout_minutes": 20,
    "worker_auto_approve": true,
    "default_flow": "orc-default",
    "review_flow": "orc-review-only"
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

`queued` means a node is waiting for a worker slot — the task is claimed but nothing is running on it yet, so it counts as pending rather than in progress (the dashboard's board shows it under Todo, labelled `queued`). It becomes `doing` when a session actually starts, which is what keeps the board from showing more work in flight than `agent_loop.max_workers` allows.

<img src="assets/TaskFlow.gif" alt="Task Flow" width="600" />

### Task flows

That pipeline is not hardcoded — it is a **flow graph** named `orc-default`. A flow is nodes joined by conditional edges that may cycle, so a task can run whatever shape its work actually needs: a plan → build → verify loop, a bug-fix-then-confirm loop, an executor with an independent supervisor, or three reviewers in parallel joined before a decision.

The graph itself is deterministic; only the nodes are agents. That means loops, branches, and fan-out behave predictably and are fully unit-testable, while the agents just do the work and report a verdict.

```bash
orc flow list                                    # what graphs are available
orc flow show orc-plan-build-verify              # nodes, edges, limits
orc task add "Fix the flaky test" --flow orc-fix-verify
orc flow status <taskId>                         # active nodes + the ledger of outcomes
orc flow resume <taskId> --outcome approved      # resolve a human gate
orc flow halt <taskId>                           # stop it and kill live nodes
```

| Built-in flow           | Shape                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| `orc-default`           | build → review → done, looping back while `max_review_rounds` allows         |
| `orc-review-only`       | A single review pass for a task you moved straight to `review`               |
| `orc-plan-build-verify` | planner → coder → reviewer, looping until acceptance criteria pass           |
| `orc-fix-verify`        | bugfix → independent confirmation the fix holds and a regression test exists  |
| `orc-supervisor`        | Executor keeping its context, plus a supervisor re-verifying from a clean one |
| `orc-parallel-review`   | Fan out to correctness / security / tests reviewers, join on all three       |

**Nodes** are `agent` (runs a session with a skill), `gate` (deterministic branching, fan-out, join points), `human` (waits for you), or `terminal` (ends the run and sets the task's final status). **Edges** carry declarative conditions — `outcome`, `visits`, `var`, `elapsed_secs`, composed with `all`/`any`/`not` — which are data, never evaluated code.

Loops always terminate. Per-node `max_visits`, a per-run node-execution budget, a wall clock, plus deadlock and stall detection each halt the run and hand the task back to you with an explanation of which rail tripped.

#### Custom graphs per task

For work no named flow fits, attach a bespoke graph to a single task:

```bash
orc flow validate --file ./my-graph.json          # catch mistakes before running anything
orc flow attach <taskId> --file ./my-graph.json --start
```

Definitions are JSON, validated on load: unknown edge targets, unreachable nodes, a graph that can never finish, or an edge shadowed by an earlier catch-all are all rejected up front rather than discovered mid-run. Reusable flows go in `~/.orc/flows/<name>/flow.json` (or `./.orc/flows/` to pin one per repo), and a user flow shadows a built-in of the same name — that is how you customise `orc-default` without patching orc.

Agents can do all of this themselves via the `flow_list`, `flow_read`, `flow_create`, `flow_attach`, `flow_status`, and `flow_report` MCP tools, so a planner can design the pipeline for the work it just decomposed.

#### In the web dashboard

A task's **Flow** section draws the graph the run froze at start next to its ledger: which node is active, the verdict each visit produced, how many visits a node has spent of its budget, per-node timings and errors, a link to each node's agent transcript, and — when a rail tripped — which one and why. Loopbacks are drawn as edges that go backwards, so a rework cycle looks like one.

When a run parks on a human gate, that panel is where you answer it: pick one of the outcomes the node's own edges can route, add a comment, and the flow continues. `Halt` stops a run and kills its live sessions. The **Flows** page lists every graph available with its source, marks the one a task with no flow of its own will run, shows any definition, and reports flows that failed validation along with the errors — so a broken graph is visible before a task tries to run it.

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

**34 tools** available to any connected agent. Start every session with `context`.

| Category      | Tools                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project**   | `project_list`                                                                                                                              |
| **Memory**    | `context`, `memory_search`, `memory_get`, `memory_store`, `memory_update`                                                                   |
| **Task**      | `task_list`, `task_get`, `task_create`, `task_update`, `task_batch_create`                                                                  |
| **Skill**     | `skill_list`, `skill_read`, `skill_create`                                                                                                  |
| **Flow**      | `flow_report`, `flow_status`, `flow_list`, `flow_read`, `flow_create`, `flow_attach`                                                        |
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
| `GET`                   | `/backends`                    | Agent backends + usability     |
| `GET/POST`              | `/flows`                       | List/create flow graphs        |
| `GET`                   | `/flows/{name}`                | Read a flow definition         |
| `POST`                  | `/flows/validate`              | Validate without saving        |
| `GET/POST`              | `/tasks/{id}/flow`             | Get a task's run / attach one  |
| `POST`                  | `/tasks/{id}/flow/resume`      | Resolve a human node           |
| `POST`                  | `/tasks/{id}/flow/halt`        | Stop a running flow            |
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
orc doctor                       Check which agent backends are usable here

orc project list|add|show|use|update|archive
orc task list|add|show|update|done|review|approve|reject|delete
orc mem list|add|search
orc job list|add|run|runs
orc session list|show|log
orc skill list|show
orc flow list|show|validate|create|attach|status|resume|halt
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
- [Task Flows](./docs/task-flows.md) - flow graphs: nodes, conditional edges, bounded loops, fan-out and joins, and how to author your own
