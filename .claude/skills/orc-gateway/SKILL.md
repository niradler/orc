---
name: orc-gateway
description: Use when setting up or using ORC's multi-channel gateway (Telegram, Slack) for human-agent collaboration, when routing messages to live agent sessions, when a human needs to approve or monitor agent work remotely, when starting a live Claude/Codex/Cursor session via messaging, or when configuring voice integration. Trigger on gateway, Telegram bot, Slack integration, live agent session, remote approval, bot commands, or voice messages.
---

# ORC Gateway

The gateway bridges messaging platforms (Telegram, Slack) with live AI agent sessions. Approve work, trigger jobs, and chat with agents from your phone.

## Why

Without the gateway, HITL review requires the human at their terminal. The gateway lets you approve tasks, monitor agents, and start new agent sessions from Telegram or Slack.

---

## Setup

```bash
orc daemon start       # Starts API + scheduler + gateway
orc gateway status     # Check health
```

Config in `~/.orc/config.json`:
```json
{
  "gateway": {
    "telegram": { "enabled": true, "token": "BOT_TOKEN", "authorized_users": [123456789] },
    "slack": { "enabled": true, "bot_token": "xoxb-...", "app_token": "xapp-..." }
  }
}
```

---

## Chat Modes

Each chat has a mode: `direct` (ORC commands), `agent:claude`/`agent:codex`/`agent:cursor` (live session), or `job:<name>` (bridge-msg). Switch with `/mode` or `/agent <backend>`.

## HITL Review

When an agent calls `task_submit_review`, the gateway sends a card with Approve/Reject buttons. Tap to respond — the agent picks up the result via `task_check_review`.

## Live Agent Sessions

```
/agent claude → type task → Claude responds with streaming output
→ Permission prompts appear as inline keyboard buttons → Tap Allow/Deny
```

## Voice

Telegram voice messages → transcribed → sent to agent. Responses → TTS → voice reply. Configure `speech`/`tts` providers in config (openai, groq, qwen).

---

## Bot Commands (direct mode)

```
/tasks, /task <id>, /approve <id>, /reject <id>    — Task management
/jobs, /run <name>                                   — Job management
/mem <query>                                         — Memory search
/agent <backend>, /sessions, /session stop           — Agent sessions
/status, /mode, /help                                — Status
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| No HITL cards arriving | Check `authorized_users` includes your Telegram ID |
| Agent session won't start | Need `orc daemon start`, not just `orc api` |
| Messages going nowhere | Check `/mode` — may be `direct` when you need `agent:claude` |
