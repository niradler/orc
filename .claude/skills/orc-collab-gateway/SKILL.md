---
name: orc-collab-gateway
description: Use when setting up or using ORC's multi-channel gateway (Telegram, Slack) for human-agent or agent-to-agent collaboration, when routing messages to live agent sessions via Telegram or Slack, when a human needs to approve or monitor agent work remotely, when starting a multi-agent session with ORC as the coordinator, or when using bot commands to control ORC from mobile/messaging apps. Trigger when user mentions gateway, Telegram bot, Slack integration, live agent session, remote approval, or multi-agent orchestration.
---

# ORC Collaboration Gateway

The ORC gateway bridges messaging platforms (Telegram, Slack) with live AI agent sessions. Humans can approve work, trigger jobs, and chat with agents from their phone. Agents can be launched and coordinated via the same channels.

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

The gateway uses a **mode per chat** — each Telegram chat or Slack channel has its own mode that determines where messages go.

---

## Chat Modes

| Mode | What it does |
|------|-------------|
| `direct` | ORC native commands (`/tasks`, `/mem`, `/jobs`, etc.) |
| `agent:claude` | Live Claude Code session — messages go to/from Claude |
| `agent:codex` | Live Codex session |
| `agent:cursor` | Live Cursor session |
| `agent:multi` | Multi-agent mode (future) |
| `job:<name>` | Messages fed into a bridge-msg–triggered job |

Switch modes with `/mode` or `/agent <claude\|codex\|cursor>`.

---

## Starting the Gateway

```bash
# Start everything (API + scheduler + gateway + file watchers)
orc daemon start

# Check gateway status
orc gateway status

# View active gateway sessions
orc session list --agent gateway
```

Gateway config in `~/.orc/config.json`:
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

## Bot Commands Reference

These work in both Telegram and Slack when in `direct` mode:

**Task management**
```
/tasks                     List active tasks
/task task_01HXYZ          Show task details
/approve task_01HXYZ       Approve HITL review
/reject task_01HXYZ        Reject with note
/assign task_01HXYZ claude  Assign task to agent
```

**Jobs**
```
/jobs                      List jobs with status
/run <job-name>            Trigger job immediately
```

**Memory**
```
/mem <query>               Search memories
```

**Agent sessions**
```
/agent claude              Start Claude Code session in this chat
/agent codex               Start Codex session
/sessions                  List active sessions
/session new               Create new session
/session switch <id>       Switch to existing session
/session stop              Stop current session
```

**Status & navigation**
```
/status                    ORC health + task/memory counts
/help                      Command list
/mode                      Show current chat mode
/cwd                       Show current working directory
```

---

## Human-Agent Collaboration Flow

### Reviewing and approving work via Telegram

When an agent calls `task_submit_review(...)`, ORC sends a Telegram card with:
- Task title and summary
- Two inline buttons: ✅ Approve / ❌ Reject

Tap Approve → task moves to `done`, agent receives `approved`.
Tap Reject → type a note → agent receives `changes_requested` + your note.

The agent polls with `task_check_review({ id: "..." })` (every 30-60s).

### Starting a live agent session

```
/agent claude               (in Telegram)
→ Claude session starts
→ Type your task as a message
→ Claude responds with streaming output (Telegram shows preview updates)
→ If Claude needs permission for a dangerous command, you get an inline keyboard prompt
→ Tap Allow/Deny
```

Permission prompts appear for commands marked sensitive in the agent runtime. All I/O is also stored in `bridge_messages` table for auditing.

---

## Agent-to-Agent Coordination Patterns

### Pattern 1: Sequential handoff via tasks

```
Agent A (Claude): Implements feature → task_submit_review → (human approves)
Agent B (Codex):  Picks up next task → task_update(status: "doing") → continues
```

Both agents read the same ORC task state. The shared `tasks` table is the coordination bus.

### Pattern 2: Parallel agents via jobs

```bash
# Create a job that Agent B runs while Agent A is reviewing
orc job add "run-tests" --command "bun test" --trigger manual
orc job run run-tests
```

Agent A calls `job_run({ name: "run-tests" })` via MCP. Agent B (as the runner subprocess) executes. Results in `job_runs` table — both agents can query status.

### Pattern 3: Bridge-msg triggered pipeline

Configure a job with `trigger_type: "bridge-msg"`. When a message arrives in a designated Telegram chat, the job receives it as stdin and can take action (run a script, create a task, call the API).

```json
{
  "name": "process-feature-request",
  "command": "bun /path/to/process.ts",
  "trigger_type": "bridge-msg",
  "env_vars": { "ORC_API_BASE": "http://127.0.0.1:7700" }
}
```

### Pattern 4: Shared memory as message bus

Agent A stores a discovery: `memory_store({ content: "Auth token format changed to JWT", type: "discovery", scope: "api" })`

Agent B calls `context()` and picks it up in the next session, or searches: `memory_search({ query: "auth token format" })`

---

## Voice Integration (Speech-to-Text)

Telegram gateway supports voice messages:

```json
{
  "gateway": {
    "speech": {
      "enabled": true,
      "provider": "openai",   // or "groq" | "qwen"
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

Voice notes → transcribed → sent to agent. Responses → TTS → voice message reply.

---

## Gateway Session Lifecycle

Gateway sessions are stored in `gateway_sessions` table:

| Field | Meaning |
|-------|---------|
| `backend` | `claude` / `codex` / `cursor` |
| `status` | `active` / `idle` / `stopped` |
| `auto_approve` | Skip permission prompts (dev mode only) |
| `session_id` | Links to ORC session for continuity |

Sessions persist across reconnects. If you close Telegram and reopen, `/session list` shows resumable sessions.

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Gateway not receiving HITL cards | Check `telegram.authorized_users` includes your Telegram ID |
| Agent session doesn't start | Ensure `orc daemon start` is running, not just `orc api` |
| Messages going nowhere | Check chat mode with `/mode` — may be in `direct` when you need `agent:claude` |
| Auto-approve left on in prod | `auto_approve: false` in gateway_sessions — only enable during development |
| Forgetting to start daemon | `orc daemon start` — not `orc mcp` — for gateway to work |
