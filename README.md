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

### From binary (recommended)

Download the latest release for your platform from [GitHub Releases](https://github.com/your-org/orc/releases):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/your-org/orc/releases/latest/download/orc-darwin-arm64 -o /usr/local/bin/orc
chmod +x /usr/local/bin/orc

# macOS (Intel)
curl -L https://github.com/your-org/orc/releases/latest/download/orc-darwin-x64 -o /usr/local/bin/orc
chmod +x /usr/local/bin/orc

# Linux (x64)
curl -L https://github.com/your-org/orc/releases/latest/download/orc-linux-x64 -o /usr/local/bin/orc
chmod +x /usr/local/bin/orc

# Windows — download orc.exe, add to PATH
```

### From source

Requires [Bun](https://bun.sh) ≥ 1.1.

```bash
git clone https://github.com/your-org/orc
cd orc
bun install
bun build           # produces dist/orc (or dist/orc.exe on Windows)
```

Add `dist/` to your `PATH`, or run with `bun orc <command>` from the repo root.

---

## Quick Start

```bash
# 1. Start the API (keeps the DB open and serves the MCP HTTP endpoint)
orc api

# 2. In another terminal — try it
orc status
orc task add "Fix the auth bug" --priority high
orc mem add "Use RWMutex for token refresh" --type decision --scope myproject
orc job add nightly --command "echo hello" --trigger cron --cron "0 22 * * *"
```

The database is created automatically at `~/.orc/orc.db` on first run. No migrations needed.

---

## Running as a service (always-on)

Use **`orc daemon`** for production — it starts the API, scheduler, file-watchers, and gateway in one process. Use `orc api` if you only need the REST API without the scheduler.

```bash
orc daemon start      # start all services (API + scheduler + watchers + gateway)
orc daemon status     # show scheduler state + next run times per job
orc daemon stop       # graceful shutdown via SIGTERM
orc home              # show ~/.orc directory state + daemon running status
```

Run it as a system service so it starts on boot and restarts on crash.

### macOS — launchd

Create `~/Library/LaunchAgents/sh.orc.daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.orc.daemon</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/orc</string>
    <string>daemon</string>
    <string>start</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/orc-daemon.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/orc-daemon.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>ORC_API_PORT</key>
    <string>7700</string>
    <key>HOME</key>
    <string>/Users/YOUR_USERNAME</string>
  </dict>
</dict>
</plist>
```

```bash
# Replace YOUR_USERNAME, then:
launchctl load ~/Library/LaunchAgents/sh.orc.daemon.plist

# Check it started
launchctl list | grep orc
curl http://127.0.0.1:7700/health

# Restart / stop
launchctl unload ~/Library/LaunchAgents/sh.orc.daemon.plist
launchctl load   ~/Library/LaunchAgents/sh.orc.daemon.plist

# View logs
tail -f /tmp/orc-daemon.log
```

### Linux — systemd (user service)

Create `~/.config/systemd/user/orc.service`:

```ini
[Unit]
Description=ORC daemon (API + scheduler + gateway)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/orc daemon start
Restart=on-failure
RestartSec=5
Environment=ORC_API_PORT=7700
Environment=ORC_LOG_LEVEL=info

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now orc

# Check status
systemctl --user status orc
curl http://127.0.0.1:7700/health

# View logs
journalctl --user -u orc -f

# Restart
systemctl --user restart orc
```

To start automatically at login (without being logged in), enable lingering:

```bash
loginctl enable-linger $USER
```

### Linux — systemd (system-wide, runs as root or dedicated user)

Create `/etc/systemd/system/orc.service`:

```ini
[Unit]
Description=ORC daemon (API + scheduler + gateway)
After=network.target

[Service]
Type=simple
User=orc
Group=orc
ExecStart=/usr/local/bin/orc daemon start
Restart=on-failure
RestartSec=5
Environment=ORC_API_PORT=7700
Environment=ORC_DB_PATH=/var/lib/orc/orc.db
Environment=ORC_LOG_LEVEL=info

[Install]
WantedBy=multi-user.target
```

```bash
# Create dedicated user (optional but recommended)
useradd --system --no-create-home --shell /usr/sbin/nologin orc
mkdir -p /var/lib/orc && chown orc:orc /var/lib/orc

sudo systemctl daemon-reload
sudo systemctl enable --now orc
sudo systemctl status orc
```

### Windows — Task Scheduler

```powershell
# Run as Administrator
$action  = New-ScheduledTaskAction -Execute "C:\path\to\orc.exe" -Argument "daemon start"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartOnIdle -ExecutionTimeLimit 0

Register-ScheduledTask `
  -TaskName "ORC Daemon" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -RunLevel Highest `
  -Force

Start-ScheduledTask -TaskName "ORC Daemon"
```

Check it's running:

```powershell
(Invoke-WebRequest http://127.0.0.1:7700/health).Content
```

### Windows — NSSM (Non-Sucking Service Manager)

[Download NSSM](https://nssm.cc/download), then:

```powershell
nssm install OrcDaemon "C:\path\to\orc.exe" "daemon start"
nssm set OrcDaemon AppStdout "C:\logs\orc.log"
nssm set OrcDaemon AppStderr "C:\logs\orc.log"
nssm set OrcDaemon AppRestartDelay 5000
nssm start OrcDaemon
```

### Any platform — PM2

If you have Node.js / PM2 installed:

```bash
pm2 start "orc daemon start" --name orc
pm2 save           # persist across reboots
pm2 startup        # generate OS startup script (follow the printed command)

pm2 logs orc       # tail logs
pm2 restart orc
```

---

## Configuration

ORC merges config in this priority order (later wins):

1. `~/.orc/config.json` — user global
2. `./.orc/config.json` — project-local (checked in with the repo)
3. Environment variables

Create `~/.orc/config.json` to configure once:

```json
{
  "db": {
    "path": "~/.orc/orc.db"
  },
  "api": {
    "port": 7700,
    "host": "127.0.0.1",
    "secret": "optional-bearer-token-for-auth"
  },
  "context": {
    "task_limit": 10,
    "memory_limit": 8,
    "snapshot_max_bytes": 2048
  }
}
```

**Environment variables:**

| Variable                | Default         | Description                                                                 |
| ----------------------- | --------------- | --------------------------------------------------------------------------- |
| `ORC_DB_PATH`           | `~/.orc/orc.db` | SQLite database path                                                        |
| `ORC_API_PORT`          | `7700`          | API listen port                                                             |
| `ORC_API_HOST`          | `127.0.0.1`     | API listen host                                                             |
| `ORC_API_SECRET`        | —               | Bearer token; if set, all API calls require `Authorization: Bearer <token>` |
| `ORC_SESSION_ID`        | `default`       | Session identifier (set per-agent for proper isolation)                     |
| `ORC_JOB_RUN_ID`        | —               | Injected into spawned job subprocesses — links agent sessions to job runs   |
| `ORC_LOG_LEVEL`         | `info`          | `debug` · `info` · `warn` · `error`                                         |
| `ORC_RUNNER_TIMEOUT`    | `300`           | Default job timeout in seconds                                              |
| `ORC_RUNNER_MAX_JOBS`   | `5`             | Max concurrent job executions                                               |
| `ORC_SNAPSHOT_MAX_BYTES`| `2048`          | Session snapshot XML budget in bytes                                        |

---

## Agent Setup

### Claude Code

Claude Code uses **hooks** — scripts that fire on tool use, pre-compaction, and session start. Copy `hooks/claude-code/settings.json` from the orc repo to `~/.claude/settings.json` (or project-level `.claude/settings.json`) and replace `/path/to/orc/` with the actual path:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|StrReplace|Bash|Shell",
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
  "env": {
    "ORC_API_BASE": "http://127.0.0.1:7700",
    "ORC_API_SECRET": "your-secret-if-set"
  }
}
```

What each hook does:

| Hook           | Fires when                                  | What it does                                               |
| -------------- | ------------------------------------------- | ---------------------------------------------------------- |
| `PostToolUse`  | After Write / Edit / Bash / Shell           | Records a session event (file edit, git op, error)         |
| `PreCompact`   | Context window fills → before compaction    | Builds + stores a ≤2KB snapshot of current session state   |
| `SessionStart` | Session starts or restarts after compaction | Injects `context` (fresh start) or snapshot (post-compact) |

### Cursor

Cursor uses **MCP** for agent tools. It has no hook system — session continuity is MCP-driven.

Create or update `.cursor/mcp.json` in your project (or the global Cursor MCP config):

```json
{
  "mcpServers": {
    "orc": {
      "command": "orc",
      "args": ["mcp"],
      "env": {
        "ORC_API_BASE": "http://127.0.0.1:7700",
        "ORC_API_SECRET": "your-secret-if-set",
        "ORC_SESSION_ID": "cursor"
      }
    }
  }
}
```

**Session protocol for Cursor agents** — instruct your agent (via system prompt or AGENTS.md):

```
At session start:          call context({})
After significant edits:   call session_event({ type: "file", data: { path: "..." } })
After a decision:          call session_event({ type: "decision", ... })
                           call memory_store({ content: "...", type: "decision" })
Before ending session:     call session_log({ agent: "cursor", summary: "..." })
```

### Codex

Codex supports hooks similar to Claude Code. Use the same hook scripts — `post-tool-use.ts` handles Codex tool names automatically. Copy `hooks/codex/settings.json` from the orc repo and replace the path placeholder:

**`~/.codex/settings.json`** (or project-level):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "shell|str_replace|write_file|apply_patch",
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
  "env": {
    "ORC_API_BASE": "http://127.0.0.1:7700",
    "ORC_SESSION_ID": "codex"
  }
}
```

### Gemini CLI

Add to your Gemini CLI MCP config:

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

## Claude Code Skills

ORC ships with five Claude Code skills in `.claude/skills/`. Skills are reference guides that Claude loads on demand — they teach it the ORC-specific protocols so you don't have to re-explain them every session.

| Skill | Triggers when... |
|-------|-----------------|
| `orc-agent-protocol` | Starting any ORC-backed session, initializing MCP, resuming after compaction |
| `orc-task-workflow` | Creating tasks, submitting for HITL review, polling for approval |
| `orc-memory-knowledge` | Storing decisions/rules, searching past context, cross-agent knowledge |
| `orc-collab-gateway` | Gateway setup, live agent sessions, multi-agent coordination |
| `orc-dev-contributing` | Contributing to the ORC codebase itself |

### Installing the skills

**Option A — register as a local plugin (recommended)**

Add an entry to `~/.claude/plugins/installed_plugins.json`:

```json
{
  "orc@local": [{
    "scope": "user",
    "installPath": "/path/to/orc/.claude",
    "version": "0.1.0",
    "installedAt": "2025-01-01T00:00:00.000Z",
    "lastUpdated": "2025-01-01T00:00:00.000Z",
    "gitCommitSha": "local"
  }]
}
```

Then enable it in `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "orc@local": true
  }
}
```

Replace `/path/to/orc` with the actual clone path (e.g. `/c/Projects/orc` on Windows, `~/src/orc` on macOS/Linux).

**Option B — copy to your personal skills directory**

```bash
cp -r /path/to/orc/.claude/skills/orc-* ~/.claude/skills/
```

Claude Code picks up skills from `~/.claude/skills/` automatically.

### How skills work

Skills load automatically based on context — you don't invoke them manually. When you start a session in a project that uses ORC, `orc-agent-protocol` loads and tells Claude to call `context({})` first, record session events, and maintain continuity. When you ask about tasks, `orc-task-workflow` loads with the HITL flow. And so on.

If you want to invoke a skill explicitly:

```
/orc-agent-protocol     # loads the session protocol skill
```

---

## MCP Tools Reference

Connect any agent once; all tools below are available via MCP.

**Start every session with `context` — it returns active tasks + key memories in ~200 tokens.**

### Memory tools

| Tool              | Description                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `memory_search`   | 3-layer BM25 search: porter stemming → trigram → LIKE. Filter by `type` or `scope`. Returns IDs + snippets. |
| `memory_timeline` | Chronological context around a memory ID — what was stored before and after.                                |
| `memory_get`      | Fetch full content by IDs. Batch multiple IDs in one call. Token-expensive — filter first.                  |
| `memory_store`    | Store a fact, decision, rule, event, or discovery. Accepts `title`, `type`, `scope`, `tags`, `importance`.  |
| `memory_delete`   | Delete a memory by ID.                                                                                      |

**Memory types** (`type` field):

| Type        | Use for                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `decision`  | Choices made: "we use PostgreSQL because of concurrent writes"             |
| `rule`      | Conventions and constraints: "all IDs are ULIDs", "never use `any`"        |
| `discovery` | Findings: "auth token refresh has a race condition on concurrent requests" |
| `event`     | Things that happened: "deployed v0.1.0 to staging", "ran migration"        |
| `fact`      | General knowledge (default): anything that doesn't fit the above           |

`rule` and `decision` types are weighted higher in `context` — they surface automatically even if old.

### Task tools

| Tool                 | Description                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `context`            | Compact session start: active tasks + key memories. Call once at the top of every session. |
| `task_list`          | List active tasks — compact, no body. Filter by `project_id` or `status`.                  |
| `task_get`           | Full task detail by IDs: body, notes, history.                                             |
| `task_create`        | Create a task with `title`, `body`, `priority`, `project_id`.                              |
| `task_update`        | Update `status`, `priority`, or `body`.                                                    |
| `task_submit_review` | HITL checkpoint — sets status to `review`, sends Telegram card if configured.              |
| `task_check_review`  | Poll review result: `pending` · `approved` · `changes_requested` + reviewer note.          |

**Task status flow:**

```
todo → doing → review → done
                     ↘ changes_requested → doing (again)
```

### Job tools

| Tool         | Description                                           |
| ------------ | ----------------------------------------------------- |
| `job_list`   | All jobs with last run status and run count.          |
| `job_run`    | Trigger a job by name. Returns `run_id`.              |
| `job_status` | Status, exit code, and error for a specific `run_id`. |

### Session tools

| Tool               | Description                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_event`    | Record a significant action. Types: `file` · `task` · `decision` · `error` · `git` · `env` · `rule` · `plan` · `intent` · `subagent`. Duplicates are silently dropped. |
| `session_snapshot` | Build ≤2KB XML snapshot of current session state. Called automatically by `PreCompact` hook.                                                                           |
| `session_restore`  | Restore session state after compaction or agent restart.                                                                                                               |
| `session_log`      | Log a session summary after completing a unit of work.                                                                                                                 |

---

## CLI Reference

All commands accept global flags: `--port`, `--host`, `--secret`, `--db`, `--log-level` (override config/env).

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

**To make this work well:**

- Set `ORC_SESSION_ID` per agent (e.g. `cursor`, `codex`, `claude-code`) so sessions don't collide
- Store `decision` and `rule` memories — they are weighted higher than `fact` in the context layer, and survive across sessions
- Use `task_submit_review` when agents complete work that needs your eyes — it's the review queue across all agents

---

## Gateway

The gateway connects Telegram and Slack to your ORC instance and to live AI agent sessions. Run it with `orc daemon start`.

**What it enables:**
- Approve or reject agent work from your phone (HITL review cards)
- Start a live Claude / Codex session and chat with it from Telegram or Slack
- Run jobs and search memory without opening a terminal
- Voice notes → agent input (with reply as voice)

---

### Telegram setup

**1. Create a bot** — talk to [@BotFather](https://t.me/BotFather), run `/newbot`, copy the token.

**2. Find your Telegram user ID** — message [@userinfobot](https://t.me/userinfobot), it replies with your numeric ID.

**3. Add to config:**

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

`authorized_users` is a whitelist — only these user IDs can interact with your bot. Start with `"mode": "direct"` for ORC commands; switch to an agent session per-chat later.

**4. Start and verify:**

```bash
orc daemon start
# Send /status to your bot in Telegram
```

---

### Slack setup

**1. Create a Slack app** at [api.slack.com/apps](https://api.slack.com/apps):
- Enable **Socket Mode** → copy the App-Level Token (`xapp-...`)
- Add Bot Token Scopes: `channels:history`, `chat:write`, `commands`
- Install the app to your workspace → copy the Bot Token (`xoxb-...`)

**2. Add to config:**

```json
{
  "gateway": {
    "slack": {
      "enabled": true,
      "bot_token": "xoxb-...",
      "app_token": "xapp-..."
    }
  }
}
```

---

### Chat modes

Each Telegram chat or Slack channel has its own mode. Switch with `/mode` or `/agent`:

| Mode | What it does |
|------|-------------|
| `direct` | ORC commands — `/tasks`, `/mem`, `/jobs`, etc. |
| `agent:claude` | Live Claude Code session — your messages go to Claude, replies stream back |
| `agent:codex` | Live Codex session |
| `agent:cursor` | Live Cursor session |
| `job:<name>` | Messages trigger the named `bridge-msg` job |

```
# In Telegram or Slack
/agent claude       → start a live Claude session in this chat
/mode               → show current mode
```

---

### Bot commands

These work in `direct` mode:

```
/status             ORC health + task/memory counts
/help               Full command list

/tasks              List active tasks
/task <id>          Show task details
/approve <id>       Approve a HITL review
/reject <id>        Reject with note
/assign <id> <agent>  Assign task to an agent

/jobs               List jobs with last run status
/run <name>         Trigger a job immediately

/mem <query>        Search memories

/agent <claude|codex|cursor>   Start live session
/sessions           List active sessions
/session new        Create new session
/session switch <id> Switch to existing session
/session stop       Stop current session

/cwd                Show current working directory
```

---

### HITL review flow

When an agent calls `task_submit_review(...)`, ORC sends a card to your Telegram:

```
📋 Review: Fix memory deduplication bug
─────────────────────────────────────
Implemented 3-layer search fallback. All tests pass.

[✅ Approve]  [❌ Reject]
```

Tap **Approve** → task moves to `done`, agent receives `approved` on its next poll.

Tap **Reject** → bot asks for a note → agent receives `changes_requested` + your note, task returns to `doing`.

You can also approve from the CLI:

```bash
orc task approve task_01HXYZ
orc task reject  task_01HXYZ   # prompts for note
```

---

### Live agent sessions

Start a Claude session directly from Telegram:

```
/agent claude
→ Session started. Send your task.

you: refactor the auth middleware to use JWT instead of sessions
Claude: I'll start by reading the current auth middleware...
        [streams output as it works]
        Done. Modified: src/middleware/auth.ts, src/routes/login.ts
        Should I submit this for review?
```

If Claude needs to run a potentially dangerous command, the gateway sends a permission prompt:

```
🔐 Permission request
────────────────────
rm -rf dist/

[✅ Allow]  [❌ Deny]
```

All I/O is stored in the `bridge_messages` table for auditing.

---

### Voice integration

Configure speech-to-text and text-to-speech for Telegram voice notes:

```json
{
  "gateway": {
    "speech": {
      "enabled": true,
      "provider": "openai",
      "language": "en"
    },
    "tts": {
      "enabled": true,
      "provider": "openai",
      "voice": "alloy"
    }
  }
}
```

Supported STT providers: `openai` · `groq` · `qwen`
Supported TTS providers: `openai` · `qwen`

Send a voice note → transcribed → sent to agent. Agent response → synthesized → returned as voice.

---

### Bridge-msg jobs

Route messages into a job for custom automation:

```bash
# Create a job triggered by bridge messages
orc job add handle-request \
  --command "bun /path/to/handler.ts" \
  --trigger bridge-msg
```

```
# In Telegram, switch to this job
/mode job:handle-request

# Now every message you send becomes stdin for the job
```

The job receives the message as stdin and can call the ORC API, create tasks, store memories, or respond back through the gateway.

---

## Jobs

Jobs are commands ORC can run on a schedule or on-demand.

```bash
# Manual (trigger on-demand)
orc job add deploy --command "bun run deploy" --trigger manual

# Cron (standard 5-field expression)
orc job add nightly --command "claude --print '...'" --trigger cron --cron "0 22 * * *"

# Cron every 30 seconds (6-field expression — seconds first)
orc job add heartbeat --command "curl http://myservice/ping" --trigger cron --cron "*/30 * * * * *"

# File-watch (fires when a path changes)
orc job add on-change --command "bun run lint" --trigger watch --watch "./src"

# Webhook (triggered via HTTP POST to /webhooks/<token>)
orc job add on-push --command "bun run ci" --trigger webhook
```

Trigger any job immediately:

```bash
orc job run nightly
orc job runs nightly       # check history
```

All stdout/stderr is streamed line-by-line into `job_run_logs` — available via API or `orc job runs <name> --logs`.

---

## Memory search: how it works

Queries cascade through three layers, stopping when results are found:

```
1. Porter stemming AND  — "caching" matches "cache", "cached", "caches" (exact stems, AND mode)
2. Porter stemming OR   — any word in the query matches (higher recall)
3. Trigram AND          — substring match, "useCall" finds "useCallback"
4. Trigram OR           — any trigram in query matches
5. LIKE fallback        — last resort, content LIKE %query%
```

Results include which layer found them — `(porter)` or `(trigram)` — so you can judge relevance.

`context` scores memories by importance × type weight × recency. Rules and decisions float to the top even when old.

---

## Dev / contributing

```bash
bun install          # install all workspace deps
bun dev              # API in watch mode
bun typecheck        # typecheck all packages
bun check            # biome lint + format (auto-fix)
bun test             # run all tests (91 passing across 6 files)
bun build            # build all packages
bun db:push          # push schema changes to dev DB
bun sdk:generate     # regenerate SDK from running API
```

### Package layout

```
packages/
  core/     @orc/core     — config, types, logger, ULID IDs
  db/       @orc/db       — Drizzle schema + SQLite client
  api/      @orc/api      — Hono REST + OpenAPI spec (:7700)
  sdk/      @orc/sdk      — typed HTTP client (generated)
  cli/      @orc/cli      — commander CLI using SDK
  mcp/      @orc/mcp      — MCP server + all tool definitions
  runner/   @orc/runner   — job executor + scheduler (cron/watch/one-shot)
  gateway/  @orc/gateway  — multi-channel gateway (Telegram, Slack) + agent sessions
  tui/      @orc/tui      — terminal UI (in-progress)
```

Data flow: `Agent → MCP → API → DB` and `CLI → SDK → API → DB`.

### Adding a new MCP tool

1. Add tool definition (name, description, `inputSchema`) to `toolDefinitions` in `packages/mcp/src/tools.ts`
2. Add the matching `case` in `executeTool`
3. Add an API route in `packages/api/src/server.ts` if persistence is needed
4. Run `bun sdk:generate` to regenerate SDK types (API must be running)
