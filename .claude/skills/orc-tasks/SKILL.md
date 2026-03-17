---
name: orc-tasks
description: Use when creating, updating, or managing tasks in an ORC-backed project, when submitting work for human review (HITL), when polling for approval, when transitioning task status, or when coordinating multi-agent work. Trigger on any task lifecycle operation — create, claim, review, approve, reject, block, complete. Also trigger when the user asks to break work into steps, track progress, or checkpoint work for review.
---

# ORC Task Workflow

Tasks are the primary coordination unit between humans and agents. The HITL review gate ensures humans validate agent work before it's accepted.

## Why Use ORC Tasks

Without tasks, agent work is invisible. ORC tasks give you a shared work queue with status tracking and human approval gates. Multiple agents can pull from the same queue without duplicating work.

---

## Task Lifecycle

```
todo ──► doing ──► review ──► done
          │           │
          ▼           ▼
        blocked    changes_requested ──► doing
```

- Move to `doing` only when actively working
- Use `review` for work needing human sign-off
- `changes_requested` = human gave feedback — read it with `task_get`
- `blocked` = can't proceed, need human help

---

## Workflow Patterns

### Single task with HITL review

1. `task_create` — define the work with acceptance criteria
2. `task_update` status → `doing` — claim it
3. Do the work, recording `session_event`s as you go
4. `task_submit_review` — summarize what you did
5. `task_check_review` — poll every 30-60s (work on other tasks while waiting)
6. If `changes_requested` → read feedback via `task_get` → fix → re-submit

### Breaking down large features

Use `task_batch_create` to create multiple tasks with dependency links atomically. Each task gets a temporary ref (e.g. `T1`, `T2`) used to express `blocks`/`blocked_by`/`subtask_of` relationships.

### Multi-agent coordination

`claimed_by` + auto-expiring claims prevent two agents from working the same task. Check `task_get` before claiming — if `claimed_by` is set, skip and find another task.

### Checkpoint-driven development

1. Break feature into 3-5 tasks
2. Complete each → `task_submit_review`
3. Human reviews incrementally — catches issues early
4. Approved tasks = safe foundation to build on

---

## CLI Fallbacks

For operations not in MCP (delete, approve, reject, notes, links):

```bash
orc task list
orc task add "Fix bug" --priority high --body "Description"
orc task show <id>
orc task done <id>            # Mark done directly
orc task approve <id>         # Human approves
orc task reject <id>          # Human rejects with note
orc task note <id> "context"  # Add a note
orc task link T1 blocks T2    # Create dependency
orc task delete <id>          # Delete task
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Marking `done` without review | Use `review` → let human approve |
| Not reading feedback after `changes_requested` | Always `task_get` |
| Creating tasks with no body | Include acceptance criteria |
| Skipping `session_event` for transitions | Without it, transitions are lost on compaction |
| Tight polling on `task_check_review` | 30-60s between polls, work on other tasks |
