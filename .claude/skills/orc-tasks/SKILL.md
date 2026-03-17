---
name: orc-tasks
description: Use when creating, updating, or managing tasks in an ORC-backed project via MCP or CLI, when an agent needs to submit work for human review (HITL), when polling for task approval, when transitioning task status, when delegating work to other agents, or when coordinating multi-agent work items. Trigger on any task lifecycle operation — create, assign, claim, review, approve, reject, delegate, block, complete. Also trigger when the user asks you to break work into steps, track progress, or checkpoint your work.
---

# ORC Task Management

Tasks are the primary coordination unit between humans and agents. The HITL (Human-in-the-Loop) review gate ensures humans validate agent work before it's accepted.

## Why Use ORC Tasks

Without tasks, agent work is invisible — there's no record of what was planned, what's in progress, or what needs review. ORC tasks give you a shared work queue that multiple agents can pull from, with built-in status tracking and human approval gates.

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

- Only move to `doing` when actively working
- Use `review` for work that needs human sign-off
- `changes_requested` means the human gave feedback — read it with `task_get`
- `blocked` means you can't proceed — log why in notes

---

## MCP Task Tools

All tools accept `project` — a readable name (e.g. `"orc"`), not a ULID. Omit to use `activeProject`.

### Create

```typescript
task_create({
  title: "Implement memory search endpoint",
  body: "Add GET /memories/search with BM25 ranking. See spec in docs/api.md",
  priority: "high",
  project: "orc"
})
// Returns: { id: "task_01HXYZ...", status: "todo" }
```

### Claim and Start

```typescript
// Check if another agent already claimed it
const task = await task_get({ ids: ["task_01..."] });
// task.claimed_by === null → safe to claim
// task.claimed_by === "agent-cursor" → skip, find another

task_update({ id: "task_01...", status: "doing" })
// Sets claimed_by to your session ID
// claim_expires_at auto-TTL (~5 min) prevents dead locks

// Record the transition as a session event (survives compaction)
session_event({ type: "task", data: { id: "task_01...", status: "doing", title: "..." } })
```

### Submit for HITL Review

```typescript
task_submit_review({
  id: "task_01...",
  summary: "Implemented 3-layer search. All tests pass. Tested edge cases."
})
// Status → "review", Telegram/Slack notification sent
```

### Poll for Review Result

```typescript
task_check_review({ id: "task_01..." })
// { status: "pending" | "approved" | "changes_requested", note?: "..." }
```

Poll every 30-60 seconds. Work on other tasks while waiting.

If `changes_requested`:
```typescript
task_get({ ids: ["task_01..."] })  // Read the feedback
// Task is already back in "doing" — implement changes and re-submit
```

### Delegate to Another Agent

```typescript
task_delegate({
  title: "Write integration tests for search",
  body: "Cover empty queries, special chars, CJK input",
  priority: "normal",
  project: "orc",
  job_name: "run-tests"  // optional: trigger a job for the delegate
})
```

### Delete

```typescript
task_delete({ id: "task_01..." })
```

---

## Task Priorities

| Priority | Use for |
|----------|---------|
| `critical` | Blocking production, security issues |
| `high` | Current sprint, active development |
| `normal` | Standard backlog items (default) |
| `low` | Nice-to-have, future ideas |

---

## Multi-Agent Coordination

### Claiming prevents duplicated work

`claimed_by` + `claim_expires_at` ensure two agents don't work the same task. A crashed agent's claim expires automatically.

### Handoff pattern

Create a note explaining what was done and what's left, then release by setting status to `todo` or `blocked`:

```typescript
task_update({ id: "task_01...", status: "todo" })
// Next agent picks it up via task_list or context()
```

### Checkpoint-driven development

1. Break large feature into 3-5 tasks
2. Complete each → `task_submit_review` with summary
3. Human reviews incrementally — catches issues early
4. Approved tasks = safe foundation to build on

### Async HITL

```
Agent: task_submit_review("Refactored auth middleware")
Agent: [works on next task while waiting]
Human: orc task approve task_01  (via Telegram/CLI)
Agent: [polls → sees "approved" → picks next task]
```

---

## Task Links

Relationships between tasks:

```bash
orc task link task_01 blocks task_02
orc task link task_01 subtask_of task_02
orc task link task_01 duplicates task_02
```

Link types: `blocks | blocked_by | relates_to | duplicates | clones | subtask_of | parent_of`

---

## CLI Operations

```bash
orc task list
orc task list --status doing
orc task add "Fix memory dedup bug" --priority high --body "FTS5 returns dupes on trigram fallback"
orc task show task_01HXYZ
orc task review task_01HXYZ
orc task approve task_01HXYZ
orc task reject task_01HXYZ
orc task done task_01HXYZ
orc task note task_01HXYZ "Found FTS5 encoding issue with CJK"
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Marking `done` without review on important work | Use `review` → let human approve |
| Not reading `note` after `changes_requested` | Always `task_get` to read feedback |
| Creating tasks with no body | Include acceptance criteria and context |
| Skipping `session_event` for task transitions | Without it, transitions are lost on compaction |
| Tight polling loop on `task_check_review` | Wait 30-60s between polls, work on other tasks |
