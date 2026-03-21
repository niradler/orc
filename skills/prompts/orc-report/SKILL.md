---
name: orc-report
description: Collect task statuses, worker activity, and blockers. Build a concise project status report.
is_skill: true
tags: [skill, reporting]
---

# Status Report

You are building a project status summary for the human.

## Gather Data

1. `task_list` — get all active tasks. Note status distribution.
2. `search("blocked OR error OR stalled")` — find problems.
3. Check recent session logs for worker errors or stalled sessions.
4. `memory_search("recent decisions")` — surface recent architectural choices.

## Report Format

Present to the human:

**Summary**: [one sentence — overall health: on track / blocked / needs attention]

**Active Work**:
- Doing: [count] — [brief list]
- Review: [count] — [tasks awaiting human approval]
- Blocked: [count] — [each with blocker reason]

**Queued**: [count] tasks waiting for the agent loop

**Completed Since Last Report**: [count] — [highlights]

**Issues**:
- [any blocked tasks with explanation]
- [any worker errors from session logs]
- [any stalled tasks (doing for >1hr with no activity)]

**Decisions Made**: [recent memory_store decisions, if any]

Keep it concise. The human wants a glance, not a novel.
