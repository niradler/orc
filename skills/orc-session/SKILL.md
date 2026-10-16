---
name: orc-session
description: Use when starting any agent session on an ORC-backed project, when resuming after context compaction, when recording significant actions during work, or when ending a work unit. This is the foundational ORC workflow - call context() first, record events as you work, snapshot before compaction, restore after. Essential for Claude Code, Cursor, Codex, and Gemini CLI agents.
allowed-tools: mcp__orc__skill_read mcp__orc__audit_list mcp__orc__memory_get mcp__orc__memory_update mcp__orc__memory_store mcp__orc__wiki_search mcp__orc__wiki_get mcp__orc__wiki_write mcp__orc__context mcp__orc__session_event mcp__orc__session_snapshot mcp__orc__session_restore mcp__orc__session_log
---

# ORC Session Workflow

ORC is a local-first orchestration hub - a shared SQLite brain that all agents read/write. Sessions ensure continuity across context compactions and agent restarts.

## Why

Context windows are finite. When compaction happens, everything you learned vanishes unless recorded. ORC sessions capture events as they happen and compress them into a restorable snapshot.

---

## Workflow

### 1. Start - Always call `context()` first

Returns ~200 tokens: active tasks, key memories, last session summary. Pass `project` to scope (e.g. `"orc"`), or omit for the default.

- **Empty response**: No saved context. Inspect current project instructions and the assigned task; do not invent rules or duplicate existing tasks.
- **Resuming after compaction**: Use your supplied session ID to call `session_restore`, then refresh the task, feedback and relevant memory/wiki context.

### 2. Discover available workflows

Use `skill_list` to see available skills. Use `skill_read` to load specific skill content when you need a structured workflow (e.g. for code review, planning, or bug fixes).

During memory writes, pass the same explicit `session_id` you use for session events/logging. HTTP MCP calls share a server process, so do not rely on the server environment to identify your work unit. Preserve returned memory IDs for the end-of-session review.

### 3. Record events as you work

Call `session_event` after anything worth surviving compaction. Events are deduplicated automatically.

**What to record:**

- File edits (type: `file`) - after Write/Edit
- Task transitions (type: `task`) - when status changes
- Conventions (type: `rule`) - when you establish "always do X"
- Architectural choices (type: `decision`) - when choosing between options
- Git operations (type: `git`) - commits, pushes, branches
- Failures (type: `error`) - tool errors, failed commands

Rules and decisions get highest priority in snapshots and future `context()` calls.

### 4. Snapshot before compaction

`session_snapshot` builds a priority-tiered XML blob (<=2KB). Claude Code's `PreCompact` hook calls this automatically. Cursor/Gemini agents should call it manually when context is near limit.

### 5. Log completed work

At the end of a task or work block, load `orc-memory-review` with `skill_read` and follow its review steps inline before calling `session_log` with a summary. Use ordinary `wiki_search` / `search` / `kb_search` for lessons as needed; normal `skill_read` returns edited instructions in the selected project. It auto-derives touched files, task changes, and stored memories from your session events.

---

## Agent Setup

**Claude Code** - hooks handle events, snapshots, and restore automatically. See `hooks/` directory and `hooks/claude-code/settings.json` for the hook configuration.

**Other clients** - hook support varies. Use explicit session tools when lifecycle events are not automatically recorded. Use the session ID supplied by ORC; native sessions need a unique ID per work unit.

**Agent Loop Workers** - sessions are managed automatically by the task loop. Workers call `context()` at start and the loop handles lifecycle.

---

## CLI Fallbacks

For operations not in MCP (delete, advanced queries):

```bash
orc session list              # List sessions
orc session show <id>         # Show session details
orc mem delete <id>           # Delete a memory
orc flow status <id>          # Inspect a managed task; the flow owns status
orc project add <name>        # Create a project
orc project update <name>     # Update project details
orc job add <name> --command "..." # Create a job
```

---

## Common Mistakes

| Mistake                        | Fix                                                        |
| ------------------------------ | ---------------------------------------------------------- |
| Skipping `context()` at start  | Always call it first - you'll duplicate work or miss rules |
| Using `context()` as a search  | Use `memory_search` for targeted queries                   |
| Not recording decisions        | Decisions lost on compaction = re-making the same choices  |
| One giant `session_log` at end | Log per work unit so partial progress is preserved         |

---

## Related

- **orc-tasks** skill - task lifecycle, HITL review, agent loop patterns
- **orc-knowledge** skill - when and how to store decisions and rules
- Built-in skills: use `skill_list` to discover available workflows, `skill_read` to load them
