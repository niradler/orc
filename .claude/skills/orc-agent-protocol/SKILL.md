---
name: orc-agent-protocol
description: Use when starting any agent session that has access to the ORC MCP server, when an agent needs to initialize state on a project using ORC, when resuming work after a context compaction or restart, or when coordinating tasks and knowledge via the ORC shared brain. Essential for Claude Code, Cursor, Codex, and Gemini CLI agents working on ORC-backed projects.
---

# ORC Agent Protocol

ORC is a local-first orchestration hub — a shared SQLite brain at `~/.orc/orc.db` that all agents read/write. It provides persistent memory, task management (with HITL review), job scheduling, and multi-agent coordination.

**MCP transport**: `orc mcp` (stdio). API on `:7700`. CLI: `orc <command>`.

---

## Session Start — Always Do This First

```
context({})
```

Returns ~200 tokens: active tasks + key memories. Do this before any other MCP call. It tells you what's in flight, what decisions have been made, and what rules apply.

**Fresh ORC instance** (context returns empty): The DB is new. Start by storing any known project rules/decisions with `memory_store`, then create tasks for your planned work.

If the context shows you're resuming after compaction, the response includes a `session_id` field. Use it to restore:
```
session_restore({ session_id: "<session_id from context response>" })
```

Your session ID is also available as `ORC_SESSION_ID` env var (set in your agent's MCP config).

---

## Core Session Loop

**Note on `session_event` vs `memory_store`**: Use `session_event` for things that happened (actions, changes, intents) — they're tied to your session and used for snapshots. Use `memory_store` for things that should be findable by *any* agent, now or months from now (decisions, rules, discoveries) — they're searchable and survive session deletion.

### 1. Record significant actions as events

Call `session_event` after any action worth preserving across context compaction:

| Action | Event type | When |
|--------|-----------|------|
| File written/edited | `file` | After every Write/Edit |
| Task created or status changed | `task` | Immediately |
| Convention established | `rule` | When you decide "always X" |
| Architectural choice made | `decision` | When you choose between options |
| Commit/push/branch | `git` | After git operations |
| Dependency installed | `env` | After npm/pip/bun install |
| Tool error or command failure | `error` | On failures worth tracking |
| Subagent launched/completed | `subagent` | When spawning/joining agents |

Events are deduplicated. Prefer `rule` and `decision` types — they float to the top in future `context()` calls.

```typescript
session_event({
  type: "decision",
  data: {
    description: "Use ULID for all IDs (not UUID) for sortability",
    context: "chose during db schema design"
  }
})
```

### 2. Snapshot before context fills (Claude Code handles this automatically)

The `PreCompact` hook calls `session_snapshot` automatically. In other agents (Cursor, Gemini), call it manually when context is near limit:
```
session_snapshot({ session_id: "<id>", hint: "optional priority hint" })
```
Snapshot is ≤2KB XML. Prioritizes: P1 (files + tasks) → P2 (decisions + git) → P3 (intent/mode).

### 3. Log completed work units

At the end of a task or significant work block:
```
session_log({ agent: "claude-code", summary: "Implemented memory search with 3-layer cascade" })
```
Auto-derives: touched files, task status changes, memories stored this session.

---

## Agent Configuration

### Claude Code (hooks auto-manage continuity)

`~/.claude/settings.json` must include (replace `/path/to/orc` with the actual clone location, e.g. `/c/Projects/orc`):
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit|StrReplace|Bash|Shell",
      "hooks": [{"type": "command", "command": "bun /c/Projects/orc/hooks/post-tool-use.ts"}]
    }],
    "PreCompact": [{"hooks": [{"type": "command", "command": "bun /c/Projects/orc/hooks/pre-compact.ts"}]}],
    "SessionStart": [{"hooks": [{"type": "command", "command": "bun /c/Projects/orc/hooks/session-start.ts"}]}]
  }
}
```

### Cursor / Gemini CLI (MCP-driven, no hooks)

`.cursor/mcp.json` or equivalent:
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

Use a unique `ORC_SESSION_ID` per agent to isolate sessions.

---

## Quick Reference: All 21 MCP Tools

**Session**
- `context` — start-of-session summary (always call first)
- `session_event` — record significant action
- `session_snapshot` — compress session to ≤2KB before compaction
- `session_restore` — restore after compaction/restart
- `session_log` — log work unit summary

**Memory**
- `memory_store` — store fact/decision/rule/event/discovery
- `memory_search` — 3-layer BM25 search (stemming → trigram → LIKE)
- `memory_get` — fetch full content by IDs
- `memory_timeline` — chronological context around a memory ID
- `memory_delete` — delete by ID

**Tasks**
- `task_create` — create with title, body, priority, project_id
- `task_list` — list active tasks (compact, no body)
- `task_get` — full task details + notes + history
- `task_update` — change status, priority, body
- `task_submit_review` — send to HITL (sets status=review, triggers Telegram)
- `task_check_review` — poll result: `pending | approved | changes_requested`

**Jobs**
- `job_list` — all jobs with last run status
- `job_run` — trigger job by name, returns run_id
- `job_status` — status + exit code + error for run_id

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Skipping `context()` at start | Always call it first — you may duplicate work or miss critical rules. With Claude Code hooks, context is injected automatically but calling it manually is harmless and gives you a current snapshot. |
| Using `context()` as a general search | Use `memory_search` for targeted knowledge queries |
| Not recording decisions as events | Decisions lost on compaction = re-making the same choices |
| One giant `session_log` at end | Log per work unit so partial progress is preserved |
| Wrong `ORC_SESSION_ID` | Give each agent a unique ID to avoid session collision |
