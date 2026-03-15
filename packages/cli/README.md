# orc — Human + AI Orchestration Hub

> Persistent memory · Task management with HITL review · Generic job runner · MCP server for Claude Code, Cursor, Codex, and Gemini CLI.
>
> One SQLite file. Shared across every agent you use.

## Install

```bash
npm install -g orc-ai
# or
bun add -g orc-ai
```

> **Requires [Bun](https://bun.sh) ≥ 1.1** to run. Bun is used as the runtime — install it once, then `orc` works everywhere.

## What it does

ORC is the shared brain between you and your AI agents. Every agent connects to the same store of tasks, memories, and jobs — so when you switch from Claude Code to Cursor, context doesn't evaporate.

- **Shared memory** — store decisions, rules, discoveries once; any agent can search them
- **Task board** — tasks move through `todo → doing → review → done`; agents submit for review, you approve
- **Job runner** — schedule any command (cron, file-watch, manual); logs every run
- **MCP server** — one config line connects any agent to all of the above
- **Session continuity** — hooks capture what happened; snapshots survive context compaction
- **Gateway** — approve agent work from Telegram or Slack; start live Claude/Codex sessions from your phone

## Quick Start

```bash
# Start the API (keeps the DB open and serves the REST + MCP endpoint)
orc daemon start

# In another terminal — try it
orc status
orc task add "Fix the auth bug" --priority high
orc mem add "Use RWMutex for token refresh" --type decision --scope myproject
orc job add nightly --command "echo hello" --trigger cron --cron "0 22 * * *"
```

The database is created automatically at `~/.orc/orc.db` on first run.

## Agent Setup

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

### Claude Code

Copy `hooks/claude-code/settings.json` from the [orc repo](https://github.com/niradler/orc) to `~/.claude/settings.json` and replace the path placeholder with your actual path.

### Codex

Copy `hooks/codex/settings.json` from the [orc repo](https://github.com/niradler/orc) to `~/.codex/settings.json`.

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

## CLI Reference

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
orc task done <id>           Mark a task done
orc task review <id>         Submit task for HITL review
orc task approve <id>        Approve a review
orc task reject <id>         Request changes

orc mem list                 List recent memories (--limit)
orc mem add <content>        Store a memory (--type, --scope, --title)
orc mem search <query>       Search memories via BM25 + trigram

orc job list                 List all jobs with trigger type and run count
orc job add <name>           Create a job (--command, --trigger, --cron, --watch)
orc job run <name>           Trigger a job immediately
orc job runs <name>          Show run history (--logs, --sessions, --limit)

orc session list             List recent agent sessions
orc session show <id>        Show session detail
```

## Configuration

Create `~/.orc/config.json`:

```json
{
  "api": {
    "port": 7700,
    "host": "127.0.0.1",
    "secret": "optional-bearer-token"
  }
}
```

Key env vars: `ORC_DB_PATH`, `ORC_API_PORT` (default 7700), `ORC_API_SECRET`, `ORC_SESSION_ID`, `ORC_LOG_LEVEL`.

## Cross-agent collaboration

All agents share one SQLite file — intentionally.

```
Claude Code  ──┐
Cursor       ──┤──→  ~/.orc/orc.db  ←──  orc cli (you)
Codex        ──┘
```

A task created by Claude Code appears in Cursor's context. A rule stored by Codex shows up in Claude Code's memory search.

Set `ORC_SESSION_ID` per agent (e.g. `cursor`, `codex`, `claude-code`) so sessions don't collide.

---

Full documentation: [github.com/niradler/orc](https://github.com/niradler/orc)
