# ORC Agent Orchestration — Design Spec

> **Date:** 2026-03-21
> **Status:** Draft
> **Goal:** Make ORC a one-stop orchestrator for multi-agent coding workflows with human-in-the-loop review.

---

## Overview

ORC becomes the central brain that coordinates multiple coding agents (Claude Code, Codex, Cursor) through a task-driven loop. A main agent talks to the human, gathers requirements, creates tasks. A background loop spawns worker agents to execute tasks. Humans review results via Telegram/CLI. Everything flows through the task board.

### Roles

| Role | What it does | How it runs |
|---|---|---|
| **Human** | Defines requirements, reviews work, approves/rejects | Telegram, CLI, or direct conversation |
| **Main agent** | General assistant. ORC-aware. Gathers requirements, creates tasks, reports status on request | Local Claude Code session or Telegram gateway |
| **Planner worker** | Deep-dives a task, creates detailed plan + subtasks. Optional — skipped for simple tasks | Spawned by task loop |
| **Coder worker** | Implements a plan. Writes code, tests, submits for review | Spawned by task loop |
| **Reviewer worker** | Reviews code/work against requirements and DOD | Spawned by task loop |

### Flow

```
Human ↔ Main agent (general, ORC-aware)
  │  Loads skills on-demand (requirements, planning, etc.)
  │  Gets requirements, DOD, clarifications
  │  Creates/reuses project
  │  Creates task(s)
  │
  ▼
Task board (source of truth)
  │
  ▼
Task loop (in runner/daemon, polls every 5 min)
  │  Finds eligible tasks (todo, unclaimed, unblocked)
  │  Respects concurrency limits
  │  Spawns worker agent sessions
  │
  ├─→ [Optional] Planner worker
  │     Deep-dives task → creates plan → submits for human review
  │     Human approves plan → planner creates implementation subtasks
  │
  ├─→ Coder worker
  │     Implements plan → submits for review
  │
  ├─→ Reviewer worker (agent review, configurable)
  │     Reviews code → approves or requests changes
  │
  ▼
Human review (Telegram/CLI)
  │  Approves → task done, dependents unblocked
  │  Requests changes → task goes back, worker resumes
  │
  ▼
Done. Main agent reports status when asked (orc-report skill).
```

---

## 1. Task Schema Changes

### New fields on `tasks` table

| Field | Type | Default | Purpose |
|---|---|---|---|
| `skill_name` | text | null | Skill to load for this task's worker (references `skills/*/SKILL.md`) |
| `required_review` | boolean | true | Whether human must review. false = auto-approve on agent review pass |
| `agent_backend` | text | null | Preferred backend: `claude \| codex \| cursor`. null = use project/global default |
| `max_review_rounds` | integer | 3 | Max times a task can cycle through changes_requested before escalating to human. Prevents infinite agent token burn. 0 = unlimited. |

### Existing fields used for orchestration

| Field | Current state | How we use it |
|---|---|---|
| `claimed_by` | Exists, text | Stores session ID of the agent working on this task |
| `claim_expires_at` | Exists, timestamp | Timeout for stale claims |
| `tags` | Exists, JSON array | General purpose filtering. Can tag tasks for agent pickup |
| `blocked_by` (dependencies) | Exists via dependency system | Block tasks until prerequisites done |
| `status` | Exists | Drive the entire workflow via status transitions |
| `author` | Exists | `"human"` or `"agent"` — who created the task |

### Status flow expansion

Current: `todo → doing → review → done / changes_requested → blocked → cancelled`

Proposed:

| Status | Meaning | Who sets it |
|---|---|---|
| `todo` | Ready to be picked up by loop or human | Main agent, planner, human |
| `queued` | Claimed by loop, waiting for concurrency slot | Task loop |
| `doing` | Agent actively working | Worker agent |
| `review` | Submitted for review (agent review first if configured, then human) | Worker agent |
| `changes_requested` | Sent back with feedback | Reviewer or human |
| `done` | Approved and complete | Human or auto-approve |
| `blocked` | Blocked by task dependency | Automatic (dependency system) |
| `paused` | Manually held — loop won't touch it | Human |
| `cancelled` | Dead | Human or main agent |

**Note:** There is no separate `human_review` status. The `review` status is used for both agent and human review. When a reviewer agent is configured, the loop picks up `review` tasks for agent review first. If the agent reviewer approves, it notifies the human (via gateway) for final approval while staying in `review` status. The task's `required_review` flag determines whether human approval is needed.

### Status transition side-effects

All notifications and automation are driven by status transitions through a **shared task service layer** (not embedded in MCP tools). Both the MCP `task_update` tool and the task loop call through this service, ensuring side-effects fire consistently regardless of entry point.

The task service lives in `packages/core` (or a new `packages/task-service`) and is imported by both `packages/mcp` and `packages/runner`.

| Transition | Side-effect |
|---|---|
| `* → review` | Notify gateway (Telegram/Slack) if `required_review = true` |
| `* → done` | Unblock dependent tasks. Update parent progress. |
| `* → changes_requested` | Add comment with feedback. Task becomes eligible for loop pickup. Increment review round counter. If `review_rounds >= max_review_rounds`, set status to `paused` and notify human instead. |
| `* → doing` | Set `claimed_by` to session ID. |
| `doing → todo` | Clear `claimed_by` (agent crashed/timed out). |
| `* → paused` | Clear `claimed_by`. Loop ignores this task. |
| `paused → todo` | Task becomes eligible for pickup again. |

### `comment` parameter on `task_update`

When `task_update` is called with a `comment` string, the service creates a row in the existing `comments` table (`resource_type: "task"`, `resource_id: task.id`). This replaces the old `task_submit_review` behavior of appending summaries to the task body.

### Remove dedicated review tools

Remove `task_submit_review` and `task_check_review`. Agents use `task_update({id, status: "review", comment: "summary"})` instead. Fewer tools, status field drives everything.

---

## 2. Skills System

### Current state

Skills are filesystem-based, living in `skills/*/SKILL.md` (built-in) and `~/.orc/skills/` (user-defined). No database table — loaded directly from the filesystem.

### New MCP tools

| Tool | Input | Output |
|---|---|---|
| `skill_list` | `{tags?: string[]}` | Array of `{name, description, tags}` |
| `skill_read` | `{name: string}` | Full skill content + metadata |

Two tools only. The task loop injects task context alongside the skill. Agents receive the skill as static text plus task details as separate context.

**Skill scoping:** Skill names are globally unique (directory name = skill name). No project-scoped skills in v1. If project-specific behavior is needed, use tags to categorize and let agents filter via `skill_list({tags: ["project-x"]})`.

### Built-in skill templates

Shipped with ORC, loaded from `skills/` directory:

| Name | Description |
|---|---|
| `orc-main-base` | Base skill for main agent. ORC awareness, advise using ORC for state management, discover/load skills, create tasks for the loop. Injected into main agent sessions. |
| `orc-worker-base` | Base skill for all worker sessions. ORC awareness, MCP tool usage, update status, post comments, store memories. Injected into every worker. |
| `requirements-gathering` | Loaded on-demand by main agent. Interview human: clarifying questions, DOD, constraints, scope. |
| `planner` | Deep-dive a task. Create implementation plan. Break into subtasks with clear descriptions. |
| `coder` | Implement a plan. Write code, tests. Update task status and post comments as you go. |
| `reviewer` | Review code/work against requirements, DOD, and project conventions. Approve or request specific changes. |
| `bug-fix` | Investigate, reproduce, fix, verify. |
| `orc-report` | Collect task statuses, session errors, worker activity across project. Build summary report. |

Skills are all filesystem-based. The task loop loads the `SKILL.md` content and injects it. Tags in the skill metadata can be used for organization and filtering via `skill_list` output.

### Skill variable handling

Skills are static text. The task loop does NOT perform variable substitution. Instead, it concatenates:

1. `orc-worker-base` content (always)
2. Task-specific skill content from `skill_name` (if set)
3. Task context block: title, body, all comments, project name

The agent receives all three sections and uses them as instructions + context. This avoids template syntax complexity entirely.

### How agents use skills

1. Main agent calls `skill_list()` to discover available skills
2. Based on task nature, calls `skill_read({name: "requirements-gathering"})` to load it
3. Follows the skill to gather requirements from the human
4. Creates tasks. If a task needs a specific workflow, sets `skill_name` pointing to the relevant skill
5. Worker agents receive: `orc-worker-base` + task-specific skill (from `skill_name`) + task body + comments

---

## 3. Task Loop (Agent Orchestrator)

### Where it lives

In `packages/runner` — extends the existing daemon/scheduler as a new loop type alongside cron/watch/webhook.

### Agent runtime as shared infrastructure

The agent spawning logic currently lives in `packages/gateway/src/agent-runtime/` (Claude, Codex, Cursor backends). The task loop needs the same infrastructure. To avoid circular dependencies:

**Extract agent runtime into `packages/agent-runtime`** (new shared package):
- `AgentBackend` interface: `startSession()`, `sendMessage()`, `getStatus()`
- Backend implementations: `claude.ts`, `codex.ts`, `cursor.ts`
- Session management: PID tracking, idle detection, cleanup

Both `packages/gateway` and `packages/runner` import from `packages/agent-runtime`. The gateway uses it for live Telegram/Slack sessions. The runner uses it for task loop workers.

### Configuration

Global or per-project in ORC config:

```json
{
  "agent_loop": {
    "enabled": true,
    "poll_interval_minutes": 5,
    "max_workers": 1,
    "default_backend": "claude",
    "session_idle_timeout_minutes": 20
  }
}
```

**Note:** Wave 1 uses global config only. Per-project overrides come in Wave 3.

### Loop cycle (every poll interval)

```
1. Health check
   - Check running sessions → mark crashed if PID dead
   - Clean up expired sessions (idle > session_idle_timeout_minutes)
   - Release claimed tasks back to "todo" if session crashed/expired
     (calls task service → triggers side-effects)

2. Concurrency check
   - Count active worker sessions (status = "running")
   - If active >= max_workers → skip, wait for next cycle

3. Task pickup
   - Query tasks WHERE:
     - status = "todo" OR status = "changes_requested"
     - claimed_by IS NULL
     - all dependencies resolved (not blocked)
     - eligible for agent pickup (has skill_name, or tagged "agent", or agent_backend set)
   - Order by priority DESC, created_at ASC
   - Pick first eligible task

4. Spawn worker
   - Claim task via task service: set claimed_by = new_session_id, status = "queued"
   - Build prompt: orc-worker-base + skill from skill_name (if set) + task context
   - Select backend: task.agent_backend → project default → global default
   - For changes_requested: try resume first (see Section 4 resume logic)
   - Spawn agent via AgentBackend.startSession() from packages/agent-runtime
   - Record session in gateway_sessions table
   - Task status transitions to "doing" once agent starts

5. No event pushing to main agent
   - Human asks main agent for status when they want it
   - Main agent uses task_list / task_get / orc-report skill
```

### Task pickup eligibility

A task is agent-eligible when ANY of these is true:
- `skill_name` is set
- `agent_backend` is set
- Tagged with `"agent"`

Tasks without any of these are human tasks — the loop ignores them.

**Known limitation (Wave 1):** Global `max_workers` means one project's tasks could starve others. Per-project concurrency comes in Wave 3.

### Worker session lifecycle

```
Loop spawns worker
  → Worker receives: base skill + task skill + task context
  → Worker sets status = "doing" (via MCP task_update)
  → Worker works (writes code, runs tests, posts comments via task_update)
  → Worker sets status = "review"
  → If required_review = false → auto-transition to "done" (task service)
  → If required_review = true → human reviews via Telegram/CLI
  → If changes_requested:
     → Loop picks up on next cycle
     → Try resume original session (see Section 4)
     → If resume fails → fresh session with ORC context
  → Cycle until approved or max_review_rounds reached
```

---

## 4. Agent Session Management

### Extend existing `gateway_sessions` table

Instead of creating a new `agent_sessions` table, extend the existing `gateway_sessions` table (schema.ts lines 290-314) which already has: `id`, `backend`, `runtime_session_id`, `status`, `last_activity_at`, `task_id`, `cwd`.

**New fields to add:**

| Field | Type | Purpose |
|---|---|---|
| `role` | `main \| worker` | Session role |
| `pid` | integer | OS process ID for monitoring/cleanup |
| `project_id` | FK to projects | Which project |
| `review_rounds` | integer (default 0) | How many changes_requested cycles this session has been through |

**Existing fields already sufficient:**

| Field | Already exists | Used for |
|---|---|---|
| `id` | Yes | Session ULID |
| `task_id` | Yes | Which task |
| `backend` | Yes | `claude \| codex \| cursor` |
| `runtime_session_id` | Yes | Backend's native session ID (for resume) |
| `status` | Yes | `running \| idle \| finished \| crashed` → add `crashed` |
| `last_activity_at` | Yes | Heartbeat for timeout detection |
| `cwd` | Yes | Working directory for the agent |

### Timeout unification

The gateway currently hardcodes `IDLE_TIMEOUT_MS = 10 * 60 * 1000` (10 min). Replace with configurable `session_idle_timeout_minutes` from agent loop config (default 20 min). Both gateway sessions and task loop workers use the same config value.

### Resume logic (on changes_requested)

```
1. Look up last session for this task (from gateway_sessions)
2. If same backend + session age < session_idle_timeout:
   a. Try --resume <runtime_session_id> with feedback appended
      (feedback = latest comment on the task)
   b. If success → agent continues with full context
3. If resume fails OR session expired:
   a. Spawn fresh session via AgentBackend.startSession()
   b. Inject: orc-worker-base + task skill + task body + all comments (includes feedback)
   c. Agent reads code from repo, rebuilds context, continues
4. Increment review_rounds on the session
5. If review_rounds >= task.max_review_rounds:
   a. Set task status = "paused"
   b. Notify human: "Task exceeded max review rounds, needs manual attention"
```

---

## 5. Review Flow

### Default flow (required_review = true)

```
Coder finishes → status: "review"
  → [Optional] Reviewer agent picks up (if task has a reviewer-tagged subtask or config)
     → Reviewer approves → notifies human via gateway for final approval
     → Reviewer requests changes → status: "changes_requested" + comment
  → Human reviews (Telegram/CLI)
     → Approve → status: "done"
     → Request changes → status: "changes_requested" + comment
  → Worker resumes (resume or fresh session) on next loop cycle
```

**No separate `human_review` status.** The `review` status serves both agent and human review. The flow is:
1. Worker sets `review`
2. If reviewer agent configured → loop spawns reviewer → reviewer either approves (notifies human) or requests changes
3. Human sees notification, approves or rejects
4. Single status, multiple review stages tracked by comments

### Configurable per task

| Config | Effect |
|---|---|
| `required_review: true` (default) | Human must approve |
| `required_review: false` | Auto-approve when agent sets review |
| Task has reviewer skill | Agent reviews first, then human |
| `paused` status | Taken off the board entirely |
| `max_review_rounds: 3` (default) | Escalate to human after N failed review cycles |

---

## 6. MCP Tool Changes Summary

### New tools

| Tool | Purpose |
|---|---|
| `skill_list` | Discover available skills (name + description) |
| `skill_read` | Load full skill content by name |

### Modified tools

| Tool | Change |
|---|---|
| `task_update` | Support new statuses (`queued`, `paused`). Add `comment` param — creates a row in `comments` table (`resource_type: "task"`). All transitions go through shared task service for side-effects (notifications, unblocking). |
| `task_create` | Add `skill_name`, `required_review`, `agent_backend`, `max_review_rounds` params |
| `task_batch_create` | Same new params as `task_create` |
| `task_list` | Update status filter enum to include `queued`, `paused` |
| `context` | Include active agent sessions count and status summary in context output |

### Removed tools

| Tool | Reason | Migration |
|---|---|---|
| `task_submit_review` | Replaced by `task_update({status: "review", comment: "summary"})` | Deprecate first: log warning if called, internally redirect to task_update. Remove in next major version. |
| `task_check_review` | Replaced by `task_get` — check status field directly | Same deprecation path. |

---

## 7. Component Responsibilities

| Component | Responsibility | Does NOT do |
|---|---|---|
| **Main agent** | Talk to human, gather requirements, create tasks, report status on request | Spawn workers, manage concurrency, push events |
| **Task loop** (runner) | Watch board, spawn workers, manage concurrency, clean up crashes, handle timeouts | Review work, push updates to main agent |
| **Task service** (core) | Status transitions, side-effects (notifications, unblocking, comments). Shared by MCP and runner. | Agent management, skill loading |
| **Agent runtime** (new shared pkg) | Spawn agent sessions, manage backends, PID tracking. Shared by gateway and runner. | Task logic, review flow |
| **Worker agents** | Execute task, post comments, update status | Coordinate with other workers, talk to human |
| **Gateway** | Telegram/Slack for human review, approvals, notifications | Spawn agents, manage task board |
| **Skills** | Define agent behavior, discoverable via MCP | Execute anything — they're templates |

---

## 8. Implementation Waves

### Wave 1 — Core Orchestration

- Extract agent runtime to `packages/agent-runtime` (from gateway)
- Extract task service to shared layer (from MCP tools)
- Task schema changes (new fields: `skill_name`, `required_review`, `agent_backend`, `max_review_rounds`, new statuses: `queued`, `paused`)
- Extend `gateway_sessions` with `role`, `pid`, `project_id`, `review_rounds`
- Skill MCP tools (`skill_list`, `skill_read`)
- Load built-in skills from filesystem
- Task loop in runner (poll, pickup, spawn, concurrency, cleanup)
- Deprecate `task_submit_review` / `task_check_review` (log warning, redirect)
- Status transition side-effects via task service
- `comment` param on `task_update` creating `comments` rows

### Wave 2 — Session Resume & Review

- Resume logic (try backend resume, fall back to fresh + ORC context)
- Agent review step (reviewer worker before human review)
- `orc-report` skill for status collection
- Configurable review gates per task/project
- Gateway review cards updated for new status flow
- `max_review_rounds` enforcement with escalation to human

### Wave 3 — Claude Code Channel & Polish

- ORC channel MCP server for real-time task events into CC sessions
- Per-project concurrency overrides
- Skill versioning and management via CLI
- Session activity dashboard (TUI)
- Multi-backend routing config
- Remove deprecated `task_submit_review` / `task_check_review`

---

## 9. Resolved Decisions

| Decision | Resolution |
|---|---|
| Task pickup signal | `skill_name` OR `agent_backend` OR tag `"agent"` — any one makes a task agent-eligible |
| Skill scoping | Globally unique names (directory name = skill name). Use tags for categorization. |
| Agent session table | Extend existing `gateway_sessions`, don't create new table |
| Side-effect execution | Shared task service layer, not embedded in MCP tools |
| Worker spawn mechanism | Shared `packages/agent-runtime` extracted from gateway |
| Template variables | No template syntax. Loop concatenates skill + task context as separate sections. |
| Review status | Single `review` status for both agent and human review. No `human_review`. |
| Timeout config | Unified `session_idle_timeout_minutes` used by both gateway and task loop |

## 10. Open Questions

1. **Planner → coder handoff** — When planner creates subtasks, should they auto-inherit the parent's `agent_backend` and review settings?
2. **Concurrent planners** — Can two planner tasks run in parallel, or does planning always serialize?
3. **Gateway notifications** — Should `paused` → `todo` transition notify the human that a task was unpaused and is back on the board?
