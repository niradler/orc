---
name: orc-tasks
description: Use when creating, updating, or managing tasks in an ORC-backed project, when submitting work for human review (HITL), when polling for approval, when transitioning task status, or when coordinating multi-agent work. Trigger on any task lifecycle operation — create, claim, review, approve, reject, block, complete. Also trigger when the user asks to break work into steps, track progress, or checkpoint work for review.
---

# ORC Task Workflow

Tasks are the primary coordination unit between humans and agents. The HITL review gate ensures humans validate agent work before it's accepted.

## Why Use ORC Tasks

Without tasks, agent work is invisible. ORC tasks give you a shared work queue with status tracking and human approval gates. Multiple agents can pull from the same queue without duplicating work. The agent loop automatically picks up queued tasks and spawns workers.

---

## Task Lifecycle

```
todo ──► queued ──► doing ──► review ──► done
                      │          │
                      ▼          ▼
                   blocked    changes_requested ──► doing
                      │
                      ▼
                    paused
```

- `todo` — work defined, not yet claimed
- `queued` — claimed by the task loop, waiting for a worker to start
- `doing` — agent is actively working
- `review` — work complete, waiting for human sign-off
- `changes_requested` — human gave feedback, agent should resume and address it
- `blocked` — can't proceed, needs human intervention
- `paused` — exceeded max review rounds or manually paused
- `done` — approved and complete

---

## Workflow Patterns

### Single task with HITL review

1. `task_create` — define the work with acceptance criteria
2. `task_update` status → `doing` — claim it
3. Do the work, recording `session_event`s as you go
4. `task_update` status → `review`, comment → summary of what you did
5. Wait for human review (work on other tasks meanwhile)
6. If `changes_requested` → read feedback via `task_get` → fix → re-submit to `review`

### Agent loop (automatic orchestration)

1. `task_create` with `prompt_id` (e.g. `orc-coder`) and optionally `agent_backend` (e.g. `claude`)
2. Task enters `todo` → the task loop picks it up, transitions to `queued` → `doing`
3. Worker agent follows the assigned prompt, submits to `review` when done
4. Human approves (`done`) or requests changes → worker resumes automatically
5. If max review rounds exceeded → task auto-pauses

### Breaking down large features

Use `task_batch_create` to create multiple tasks with dependency links atomically. Each task gets a temporary ref (e.g. `T1`, `T2`) used to express `blocks`/`blocked_by`/`subtask_of` relationships.

### Multi-agent coordination

`claimed_by` + auto-expiring claims prevent two agents from working the same task. The task loop handles this automatically. For manual workflows, check `task_get` before claiming — if `claimed_by` is set, skip and find another task.

### Assigning prompts and backends

- `prompt_id` — assign a workflow prompt (use `prompt_list` to discover available ones)
- `agent_backend` — choose which agent type executes: `claude`, `codex`, or `cursor`
- `required_review` — whether the task needs human review (default: true)
- `max_review_rounds` — how many review cycles before auto-pause (default: 3)

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
| Not reading feedback after `changes_requested` | Always `task_get` to read comments |
| Creating tasks with no body | Include acceptance criteria |
| Skipping `session_event` for transitions | Without it, transitions are lost on compaction |
| Not setting `prompt_id` on tasks for the agent loop | Workers need a workflow to follow |

---

## Related

- **orc-session** skill — session start protocol, event recording, snapshot/restore
- **orc-knowledge** skill — when to store decisions and rules in memory
- **orc-gateway** skill — remote task approval via Telegram/Slack
- Built-in prompts: `orc-coder`, `orc-planner`, `orc-reviewer`, `orc-bugfix` — use `prompt_list` to discover, assign via `prompt_id`
