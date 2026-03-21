---
name: orc-session
description: Use when starting any agent session on an ORC-backed project, when resuming after context compaction, when recording significant actions during work, or when ending a work unit. This is the foundational ORC workflow — call context() first, record events as you work, snapshot before compaction, restore after. Essential for Claude Code, Cursor, Codex, and Gemini CLI agents.
---

# ORC Session Workflow

ORC is a local-first orchestration hub — a shared SQLite brain that all agents read/write. Sessions ensure continuity across context compactions and agent restarts.

## Why

Context windows are finite. When compaction happens, everything you learned vanishes unless recorded. ORC sessions capture events as they happen and compress them into a restorable snapshot.

---

## Workflow

### 1. Start — Always call `context()` first

Returns ~200 tokens: active tasks, key memories, last session summary. Pass `project` to scope (e.g. `"orc"`), or omit for the default.

- **Empty response**: Fresh ORC. Store project rules with `memory_store`, create tasks for planned work.
- **Has `session_id`**: You're resuming after compaction. Call `session_restore` to get your previous snapshot.

### 2. Discover available workflows

Use `prompt_list` to see available prompts and skills. Use `prompt_get` to load specific prompt content when you need a structured workflow (e.g. for code review, planning, or bug fixes).

### 3. Record events as you work

Call `session_event` after anything worth surviving compaction. Events are deduplicated automatically.

**What to record:**
- File edits (type: `file`) — after Write/Edit
- Task transitions (type: `task`) — when status changes
- Conventions (type: `rule`) — when you establish "always do X"
- Architectural choices (type: `decision`) — when choosing between options
- Git operations (type: `git`) — commits, pushes, branches
- Failures (type: `error`) — tool errors, failed commands

Rules and decisions get highest priority in snapshots and future `context()` calls.

### 4. Snapshot before compaction

`session_snapshot` builds a priority-tiered XML blob (<=2KB). Claude Code's `PreCompact` hook calls this automatically. Cursor/Gemini agents should call it manually when context is near limit.

### 5. Log completed work

At the end of a task or work block, call `session_log` with a summary. It auto-derives touched files, task changes, and stored memories from your session events.

---

## Agent Setup

**Claude Code** — hooks handle events, snapshots, and restore automatically. See `hooks/` directory and `hooks/claude-code/settings.json` for the hook configuration.

**Cursor / Gemini** — no hooks, so call `session_event` manually after significant edits and decisions. Set a unique `ORC_SESSION_ID` per agent in your MCP config to isolate sessions.

**Agent Loop Workers** — sessions are managed automatically by the task loop. Workers call `context()` at start and the loop handles lifecycle.

---

## CLI Fallbacks

For operations not in MCP (delete, advanced queries):

```bash
orc session list              # List sessions
orc session show <id>         # Show session details
orc mem delete <id>           # Delete a memory
orc task done <id>            # Mark task done directly
orc project add <name>        # Create a project
orc project update <name>     # Update project details
orc job add <name> --command "..." # Create a job
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Skipping `context()` at start | Always call it first — you'll duplicate work or miss rules |
| Using `context()` as a search | Use `memory_search` for targeted queries |
| Not recording decisions | Decisions lost on compaction = re-making the same choices |
| One giant `session_log` at end | Log per work unit so partial progress is preserved |

---

## Related

- **orc-tasks** skill — task lifecycle, HITL review, agent loop patterns
- **orc-knowledge** skill — when and how to store decisions and rules
- Built-in prompts: use `prompt_list` to discover available workflows, `prompt_get` to load them
