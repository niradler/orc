---
name: orc-task-workflow
description: Use when creating, updating, or managing tasks in an ORC-backed project via MCP or CLI, when an agent needs to submit work for human review (HITL), when polling for task approval, when transitioning task status, or when coordinating multi-agent work items. Trigger on any task lifecycle operation: create, assign, review, approve, reject, block, complete.
---

# ORC Task Workflow

ORC tasks are the primary coordination unit between human and agents. The HITL (Human-in-the-Loop) review gate at `doing → review` is where a human validates agent work before it's accepted as done.

---

## Task State Machine

```
todo ──► doing ──► review ──► done
          │           │
          ▼           ▼
        blocked    changes_requested ──► doing
          │
          ▼ (or cancelled from any state)
       cancelled
```

**Rules:**
- Only move to `doing` when you're actively working on it
- Use `review` for work that needs human sign-off — not for tasks you completed yourself
- `changes_requested` means the human gave feedback in `note` field — read it with `task_get`
- `blocked` means you can't proceed and need human intervention (log why in notes)

---

## MCP Task Operations

### Create a task

```typescript
task_create({
  title: "Implement memory search endpoint",
  body: "Add GET /memories/search with BM25 ranking. See spec in docs/api.md",
  priority: "high",          // low | normal | high | critical
  project_id: "proj_01..."   // optional
})
// Returns: { id: "task_01HXYZ...", status: "todo" }
```

### Claim and start work

```typescript
// First, check if already claimed by another agent
const task = await task_get({ ids: ["task_01..."] });
// task.claimed_by === null → safe to claim
// task.claimed_by === "agent-cursor" → skip, find another task

task_update({ id: "task_01...", status: "doing" })
// Sets claimed_by to your session ID. claim_expires_at is a ~5-min auto-TTL
// so a crashed agent won't permanently lock a task.

// Always record task transitions as session events — they're preserved in snapshots:
session_event({ type: "task", data: { id: "task_01...", status: "doing", title: "..." } })
```

### Submit for HITL review

```typescript
task_submit_review({
  id: "task_01...",
  summary: "Implemented 3-layer search: porter stemming → trigram → LIKE fallback. All tests pass. Tested with edge cases for empty queries and special chars."
})
// Status becomes "review", Telegram card sent to authorized users
```

### Poll for review result

```typescript
task_check_review({ id: "task_01..." })
// Returns: { status: "pending" | "approved" | "changes_requested", note?: "..." }
```

Poll every 30-60 seconds. Don't block the agent — work on other tasks while waiting.

If your session ends with a review still pending, a new session will find it via `context()` (active tasks include those in `review` status) or `task_list({ status: "review" })`.

If `changes_requested`:
```typescript
task_get({ ids: ["task_01..."] })  // Read the note with human feedback
// Task is already back in "doing" — implement changes and re-submit
```

### Mark complete (after approval)

The task moves to `done` automatically when approved. If working without HITL (internal task):
```typescript
task_update({ id: "task_01...", status: "done" })
```

---

## CLI Task Operations

```bash
# List active tasks
orc task list
orc task list --status doing

# Create task
orc task add "Fix memory deduplication bug" --priority high --body "FTS5 returns dupes on trigram fallback"

# View task details
orc task show task_01HXYZ

# Transitions (human-side, not agent-side)
orc task review task_01HXYZ          # Submit for review
orc task approve task_01HXYZ         # Approve (as human)
orc task reject task_01HXYZ          # Reject with optional note
orc task done task_01HXYZ            # Mark done directly
```

---

## Task Priorities

| Priority | Use for |
|----------|---------|
| `critical` | Blocking production, security issues |
| `high` | Current sprint, active development |
| `normal` | Default — standard backlog items |
| `low` | Nice-to-have, future ideas |

---

## Multi-Agent Task Coordination

ORC tasks support `claimed_by` and `claim_expires_at`. Agents can claim tasks to prevent duplication:

```typescript
// Before starting work, check if task is already claimed
task_get({ ids: ["task_01..."] })
// { claimed_by: null } → safe to claim
// { claimed_by: "agent-cursor" } → another agent is working on it

task_update({ id: "task_01...", status: "doing" })  // This sets claimed_by to your session ID
```

For agent-to-agent handoffs: create a note explaining what was done and what's left, then release the task by setting it to `todo` or `blocked`.

---

## Task Notes (Threads)

Add context or questions as notes:

```typescript
// Via API (no direct MCP tool — use task_update with body modification, or CLI)
orc task note task_01HXYZ "Ran into FTS5 encoding issue with CJK characters — may need ICU tokenizer"
```

Notes preserve the reasoning trail for future agents and humans.

---

## Task Links

Relationships between tasks:

```bash
# Via CLI
orc task link task_01 blocks task_02        # task_01 must complete before task_02
orc task link task_01 subtask_of task_02    # task_01 is part of task_02
orc task link task_01 duplicates task_02    # mark as duplicate
```

Link types: `blocks | blocked_by | relates_to | duplicates | clones | subtask_of | parent_of`

---

## Common Patterns

**Pattern: Checkpoint-driven development**
1. Break large feature into 3-5 tasks
2. Complete each task → `task_submit_review` with what you did
3. Human reviews incrementally — catches issues early
4. Approved tasks = safe foundation to build on

**Pattern: Async HITL**
```
Agent A: task_submit_review("Refactored auth middleware")
Agent A: [moves to next task while waiting]
Human: orc task approve task_01 (via Telegram or CLI)
Agent A: [polls task_check_review → sees "approved" → moves to done → picks next task]
```

**Pattern: Blocked with context**
```typescript
task_update({ id: "task_01...", status: "blocked" })
// Add note explaining what's blocking and what's needed
session_event({ type: "task", data: { id: "task_01...", status: "blocked", reason: "Waiting for API key" }})
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Marking task `done` without human review on important work | Use `review` → let human approve |
| Not reading the `note` after `changes_requested` | Always `task_get` to read feedback |
| Creating tasks with no body | Include acceptance criteria and context |
| Treating `session_event` for task transitions as optional | It's not — without it, transitions are lost on compaction and the next agent starts blind |
| Polling `task_check_review` in a tight loop | Wait 30-60s between polls, work on other tasks |
