---
name: orc-session
description: Use when starting any agent session that has access to the ORC MCP server, when resuming work after context compaction or restart, when you need to record significant actions (file edits, decisions, git ops), or when ending a work unit. This is the foundational ORC skill — trigger it at session start, before compaction, and at session end. Essential for Claude Code, Cursor, Codex, and Gemini CLI agents on ORC-backed projects.
---

# ORC Session Management

ORC is a local-first orchestration hub — a shared SQLite brain at `~/.orc/orc.db` that all agents read/write. It provides persistent memory, task management (with HITL review), job scheduling, and multi-agent coordination.

The session lifecycle ensures continuity across context compactions and agent restarts. Without it, every new context window starts blind.

## Why Sessions Matter

Context windows are finite. When compaction happens, everything you learned — files touched, decisions made, tasks started — vanishes unless it's been recorded. ORC sessions solve this by capturing events as they happen and compressing them into a restorable snapshot before compaction.

---

## Session Lifecycle

```
START ──► context() ──► work loop ──► session_snapshot() ──► [compaction] ──► session_restore() ──► work loop ──► session_log()
```

### 1. Initialize — Always First

```typescript
context({ project: "my-project" })  // or omit project to use activeProject
```

Returns ~200 tokens: active tasks + key memories + session state. Tells you what's in flight, what decisions have been made, and what rules apply.

- **Fresh ORC instance** (empty response): Store initial project rules with `memory_store`, create tasks for planned work.
- **Resuming after compaction**: Response includes `session_id` — call `session_restore({ session_id })` to get your previous snapshot back.

### 2. Record Events During Work

Call `session_event` after any action worth surviving compaction:

| Event type | When | Example |
|-----------|------|---------|
| `file` | After Write/Edit | `{ path: "src/api.ts", action: "created" }` |
| `task` | Task status change | `{ id: "task_01...", status: "doing" }` |
| `rule` | Convention established | `{ content: "all IDs are ULIDs" }` |
| `decision` | Choice between options | `{ content: "use Hono over Express" }` |
| `git` | Commit/push/branch | `{ action: "commit", message: "..." }` |
| `env` | Dependency installed | `{ action: "install", package: "drizzle-orm" }` |
| `error` | Tool/command failure | `{ command: "bun test", error: "..." }` |
| `plan` | Plan mode entered/exited | `{ action: "enter", summary: "..." }` |
| `intent` | Mode shift | `{ mode: "implement" }` |
| `subagent` | Agent launched/completed | `{ action: "launched", task: "..." }` |

Events are deduplicated automatically. Prefer `rule` and `decision` types — they get highest priority in snapshots and future `context()` calls.

```typescript
session_event({
  type: "decision",
  data: { description: "Use ULID for all IDs for sortability", context: "db schema design" }
})
```

### 3. Snapshot Before Compaction

```typescript
session_snapshot({ session_id: "<id>", hint: "optional priority hint" })
```

Produces a priority-tiered XML blob (<=2KB):
- **P1** (always included): files touched, active tasks
- **P2** (if space): decisions, git operations
- **P3** (if space): intent, mode

**Claude Code**: The `PreCompact` hook calls this automatically.
**Cursor/Gemini**: Call manually when context is near limit.

### 4. Log Work Units

At the end of a task or significant work block:

```typescript
session_log({
  agent: "claude-code",
  summary: "Implemented memory search with 3-layer cascade",
  project: "orc"
})
```

Auto-derives: touched files, task status changes, memories stored this session.

---

## Agent Setup

### Claude Code (hooks auto-manage continuity)

Hooks in `hooks/` handle event recording, snapshots, and restore automatically. Configure in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit|StrReplace|Bash|Shell",
      "hooks": [{ "type": "command", "command": "bun /c/Projects/orc/hooks/post-tool-use.ts" }]
    }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "bun /c/Projects/orc/hooks/pre-compact.ts" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun /c/Projects/orc/hooks/session-start.ts" }] }]
  }
}
```

### Cursor / Gemini CLI (no hooks — manual events)

MCP config (`.cursor/mcp.json` or equivalent):
```json
{
  "mcpServers": {
    "orc": {
      "command": "orc",
      "args": ["mcp"],
      "env": { "ORC_API_BASE": "http://127.0.0.1:7700", "ORC_SESSION_ID": "cursor" }
    }
  }
}
```

Use a unique `ORC_SESSION_ID` per agent to isolate sessions.

---

## All MCP Tools (Quick Reference)

ORC exposes 42 tools across 6 domains. All tools accepting `project` take a **readable project name** (e.g. `"orc"`), not a ULID.

**Session (4)**: `context`, `session_event`, `session_snapshot`, `session_restore`, `session_log`

**Memory (5)**: `memory_store`, `memory_search`, `memory_get`, `memory_timeline`, `memory_delete`

**Tasks (7)**: `task_create`, `task_list`, `task_get`, `task_update`, `task_submit_review`, `task_check_review`, `task_delegate`, `task_delete`

**Jobs (5)**: `job_list`, `job_get`, `job_create`, `job_run`, `job_status`, `job_update`, `job_delete`

**Projects (4)**: `project_list`, `project_get`, `project_create`, `project_update`, `project_delete`

**Prompts (5)**: `prompt_list`, `prompt_get`, `prompt_create`, `prompt_update`, `prompt_delete`

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Skipping `context()` at start | Always call it first — you may duplicate work or miss rules |
| Using `context()` as a search tool | Use `memory_search` for targeted queries |
| Not recording decisions as events | Decisions lost on compaction = re-making the same choices |
| One giant `session_log` at end | Log per work unit so partial progress is preserved |
| Wrong `ORC_SESSION_ID` | Each agent needs a unique ID to avoid session collision |
