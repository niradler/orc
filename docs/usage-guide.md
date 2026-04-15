# Usage Guide

Practical patterns for getting the most out of ORC. Covers project setup, memory strategy, task workflows, and multi-agent orchestration.

## First setup

```bash
# Install and start
npm install -g orc-ai
orc daemon start

# Create your first project
orc project add my-app -d "Main application"
orc project use my-app
```

Once the daemon is running, connect your agent (see [README - Connect your agent](../README.md#connect-your-agent)). Every MCP tool call and CLI command will auto-scope to the active project.

## Memory best practices

Memory is the shared context layer. What you store determines how useful ORC is across sessions.

### What to store

| Type        | Store when                                                     | Example                                                                |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `rule`      | A convention is established that all future work should follow | "All API responses use camelCase keys"                                 |
| `decision`  | A choice was made with tradeoffs                               | "Use PostgreSQL over SQLite for the main app - need concurrent writes" |
| `discovery` | Something non-obvious was found during investigation           | "The token refresh endpoint has a 2-second race window under load"     |
| `event`     | Something happened that future sessions might need to know     | "Deployed v2.1 to production on 2026-03-15"                            |
| `fact`      | General context that doesn't fit other types                   | "The frontend repo is at github.com/team/frontend"                     |

### What not to store

- Things already in the code (file paths, function signatures)
- Things already in git (who changed what, when)
- Temporary debugging notes
- Anything that changes every session

### Search effectively

```bash
# BM25 full-text search
orc mem search "authentication token"

# Via MCP - agents should search before storing to avoid duplicates
memory_search({ query: "auth", project: "my-app" })
```

The `context` MCP tool returns high-weight memories (`rule` and `decision`) automatically at session start. Low-weight memories (`event`, `fact`) are returned only when searched.

## Task workflows

### Simple tasks (no orchestration)

For tasks you track manually:

```bash
orc task add "Fix login redirect bug" --priority high
orc task update <id> --status doing
# ... work on it ...
orc task update <id> --status done
```

### Orchestrated tasks (agent loop)

For tasks the loop should pick up and assign to agents:

```bash
# Set a skill to make the task agent-eligible
orc task add "Implement user auth" --skill orc-coder --priority high

# Or set a backend directly
orc task add "Review PR #42" --skill orc-reviewer --backend claude
```

A task is picked up by the loop when **any** of these is true:

- `skill_name` is set
- `agent_backend` is set
- Tagged with `"agent"`

### Task decomposition

Use `task_batch_create` for multi-step work with dependencies:

```
task_batch_create({ tasks: [
  { title: "Design database schema", skill_name: "orc-planner" },
  { title: "Implement API endpoints", skill_name: "orc-coder", blocked_by: [0] },
  { title: "Write integration tests", skill_name: "orc-coder", blocked_by: [1] },
  { title: "Code review", skill_name: "orc-reviewer", blocked_by: [2] }
]})
```

Tasks blocked by dependencies won't be picked up until their blockers are `done`.

### Review flow

When an agent finishes work, it sets the task to `review`:

```
task_update({ id: "...", status: "review", comment: "Implemented auth with JWT. Added 12 tests." })
```

You review via CLI, Telegram, or Slack:

```bash
orc task approve <id>                            # approve
orc task reject <id> -m "Missing error handling" # request changes
```

On rejection, the task goes to `changes_requested` and the loop picks it up again - resuming the previous agent session if possible, or starting fresh with all comments as context.

**Review round limits:** Tasks have `max_review_rounds` (default 3). If an agent exceeds this, the task is auto-paused and you get a notification. This prevents infinite token burn on tasks the agent can't resolve.

## Multi-agent patterns

### Main + workers pattern

The most common setup: you (or a main agent) create tasks, the loop spawns workers.

1. Human or main agent creates tasks with appropriate skills
2. Task loop spawns worker agents per task
3. Workers follow skills, post comments, submit for review
4. Human approves or requests changes
5. Loop handles the rest

### Multi-backend routing

Route different types of work to different agents:

```bash
# Complex implementation → Claude Code
orc task add "Refactor auth module" --skill orc-coder --backend claude

# Quick code review → Codex via ACPX
orc task add "Review utils.ts changes" --skill orc-reviewer --backend codex

# Remote specialized agent → A2A (requires a2a_url on the task or session)
orc task add "Run security scan" --backend a2a
```

For A2A backends, the remote agent URL is set via the `a2a_url` field on the task or session. The task loop sends JSON-RPC messages to that endpoint following the Google A2A protocol.

Set `agent_loop.default_backend` in config for the fallback. Any unknown backend name routes through ACPX with the name as `--agent` flag - so `--backend gemini` runs `acpx --agent gemini`.

### Per-project concurrency

Limit how many agents run simultaneously per project:

```bash
orc project update my-app --max-workers 2
```

This prevents one project from starving others when the global `max_workers` is higher.

## Session continuity

ORC captures session state so agents survive context compaction:

1. **During work** - hooks automatically record file edits, task updates, git operations, and decisions as session events
2. **Before compaction** - `session_snapshot` builds a priority-tiered 2KB summary (P1: files/tasks, P2: decisions/git, P3: intent)
3. **After compaction** - `session_restore` injects the snapshot back so the agent resumes with full context

For Claude Code and Codex, this is automatic via hooks. For Cursor and other agents, call `session_event` and `session_snapshot` manually.

### What agents should record

| Event type | When                                 | Example                                            |
| ---------- | ------------------------------------ | -------------------------------------------------- |
| `file`     | After writing/editing a file         | `{ path: "src/auth.ts" }`                          |
| `task`     | After creating or updating a task    | `{ id: "...", status: "doing" }`                   |
| `decision` | After making an architectural choice | `{ content: "Using JWT over sessions" }`           |
| `rule`     | After establishing a convention      | `{ content: "All errors return { error, code }" }` |
| `git`      | After commit, push, branch           | `{ action: "commit", ref: "abc123" }`              |
| `error`    | After a tool error or failed command | `{ tool: "Bash", error: "..." }`                   |

## Jobs

### Scheduled agent work

Combine jobs with the task loop for fully automated workflows:

```bash
# Nightly: create a task for the agent to run tests and report
orc job add nightly-tests \
  --command "orc task add 'Run test suite and report failures' --skill orc-coder --priority high" \
  --trigger cron --cron "0 22 * * *"

# Weekly: generate a project status report
orc job add weekly-report \
  --command "orc task add 'Generate weekly status report' --skill orc-report" \
  --trigger cron --cron "0 9 * * 1"
```

### File-watch triggers

React to code changes:

```bash
orc job add lint-on-save --command "bun run lint" --trigger watch --watch "./src"
```

## Gateway tips

### Telegram workflow

The most productive Telegram workflow is async review:

1. Agents work and submit for review
2. You get Telegram notifications with task summaries
3. `/approve <id>` or `/reject <id> Missing tests` from your phone
4. Loop continues without you touching a terminal

### Live agent sessions

Start a live agent session from Telegram:

```
/agent claude
```

This spawns a Claude Code session you can chat with directly from Telegram. Useful for quick investigations or ad-hoc tasks.

## Configuration tips

### Minimal config

```json
{
  "activeProject": "my-app"
}
```

### Full production config

```json
{
  "activeProject": "my-app",
  "agent_loop": {
    "enabled": true,
    "poll_interval_minutes": 5,
    "max_workers": 2,
    "default_backend": "claude",
    "session_idle_timeout_minutes": 20,
    "worker_auto_approve": true
  },
  "gateway": {
    "telegram": {
      "enabled": true,
      "token": "...",
      "authorized_users": [123456789]
    }
  }
}
```

### Config resolution

1. `~/.orc/config.json` - user global
2. `./.orc/config.json` - project-local (overrides global)
3. Environment variables (override both)

Project-local config is useful for setting `ORC_PROJECT` per-repo so agents auto-scope without you running `orc project use`.
