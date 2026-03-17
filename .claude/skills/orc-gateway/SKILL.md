---
name: orc-gateway
description: Use when setting up or using ORC's multi-channel gateway (Telegram, Slack) for human-agent collaboration, when routing messages to live agent sessions, when a human needs to approve or monitor agent work remotely from their phone, when starting a live Claude/Codex/Cursor session via Telegram or Slack, or when configuring voice integration. Trigger when user mentions gateway, Telegram bot, Slack integration, live agent session, remote approval, bot commands, or multi-agent orchestration via messaging.
---

# ORC Gateway

The gateway bridges messaging platforms (Telegram, Slack) with live AI agent sessions. Humans can approve work, trigger jobs, and chat with agents from their phone. Agents can be launched and coordinated via the same channels.

## Why Use the Gateway

Without the gateway, HITL review requires the human to be at their terminal. The gateway lets you approve tasks, monitor agents, and even start new agent sessions from Telegram or Slack — on your phone, on the bus, wherever.

---

## Architecture

```
Telegram/Slack ──► Gateway Manager ──► Mode Router
                                           │
                          ┌────────────────┼────────────────┐
                          ▼                ▼                 ▼
                    Direct commands   Agent session    Job trigger
                    (/tasks, /mem)    (claude/codex)  (bridge-msg)
```

Each Telegram chat or Slack channel has its own **mode** that determines where messages go.

---

## Chat Modes

| Mode | What it does |
|------|-------------|
| `direct` | ORC native commands (`/tasks`, `/mem`, `/jobs`) |
| `agent:claude` | Live Claude Code session — messages go to/from Claude |
| `agent:codex` | Live Codex session |
| `agent:cursor` | Live Cursor session |
| `job:<name>` | Messages fed into a bridge-msg–triggered job |

Switch modes with `/mode` or `/agent <claude|codex|cursor>`.

---

## Setup

### Start the gateway

```bash
orc daemon start      # Starts API + scheduler + gateway + file watchers
orc gateway status    # Check gateway health
```

### Configuration (`~/.orc/config.json`)

```json
{
  "gateway": {
    "telegram": {
      "enabled": true,
      "token": "YOUR_BOT_TOKEN",
      "authorized_users": [123456789],
      "mode": "direct"
    },
    "slack": {
      "enabled": true,
      "bot_token": "xoxb-...",
      "app_token": "xapp-..."
    }
  }
}
```

---

## Bot Commands

These work in both Telegram and Slack when in `direct` mode:

**Tasks**
```
/tasks                      List active tasks
/task task_01HXYZ           Show task details
/approve task_01HXYZ        Approve HITL review
/reject task_01HXYZ         Reject with note
/assign task_01HXYZ claude  Assign to agent
```

**Jobs**
```
/jobs                       List jobs with status
/run <job-name>             Trigger job
```

**Memory**
```
/mem <query>                Search memories
```

**Agent Sessions**
```
/agent claude               Start Claude Code session
/agent codex                Start Codex session
/sessions                   List active sessions
/session new                Create new session
/session switch <id>        Switch to session
/session stop               Stop current session
```

**Status**
```
/status                     ORC health + counts
/mode                       Show current chat mode
/cwd                        Current working directory
/help                       Command list
```

---

## HITL Review Flow

When an agent calls `task_submit_review(...)`, the gateway sends a card with:
- Task title and summary
- Inline buttons: Approve / Reject

**Approve** → task moves to `done`, agent receives `approved`
**Reject** → type a note → agent receives `changes_requested` + your feedback

The agent polls with `task_check_review({ id })` every 30-60s.

---

## Live Agent Sessions

```
/agent claude               (in Telegram)
→ Claude session starts
→ Type your task as a message
→ Claude responds with streaming output
→ Permission prompts appear as inline keyboard buttons
→ Tap Allow/Deny
```

All I/O stored in `bridge_messages` table for auditing.

---

## Agent-to-Agent Coordination

### Sequential handoff via tasks
```
Agent A (Claude): Implements feature → task_submit_review → (human approves)
Agent B (Codex):  task_list → picks up next task → task_update(status: "doing")
```

### Parallel agents via jobs
```bash
orc job add "run-tests" --command "bun test" --trigger manual
```
Agent A calls `job_run({ name: "run-tests" })`. Results in `job_runs` table.

### Bridge-msg triggered pipeline
Jobs with `trigger_type: "bridge-msg"` receive Telegram messages as stdin:
```json
{
  "name": "process-feature-request",
  "command": "bun /path/to/process.ts",
  "trigger_type": "bridge-msg"
}
```

---

## Voice Integration

Telegram gateway supports voice messages:

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

Voice notes → transcribed → sent to agent. Responses → TTS → voice reply.

Providers: `openai`, `groq`, `qwen`.

---

## Session Lifecycle

Gateway sessions persist across reconnects:

| Field | Meaning |
|-------|---------|
| `backend` | `claude` / `codex` / `cursor` |
| `status` | `active` / `idle` / `stopped` |
| `auto_approve` | Skip permission prompts (dev mode only) |
| `session_id` | Links to ORC session for continuity |

Close Telegram and reopen — `/session list` shows resumable sessions.

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| No HITL cards arriving | Check `telegram.authorized_users` includes your Telegram ID |
| Agent session won't start | Need `orc daemon start`, not just `orc api` |
| Messages going nowhere | Check `/mode` — may be `direct` when you need `agent:claude` |
| Auto-approve left on in prod | `auto_approve: false` — only enable during development |
