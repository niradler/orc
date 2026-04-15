# Vision

## The Gap

Every AI agent session is an island. Start a new session and it knows nothing about the last one. Run two in parallel and they can't coordinate. Switch to a different agent and you start from zero. You become the integration layer - manually copying context between sessions that should share it automatically.

Worse: there's no middle ground between full autonomy and full babysitting. No way to say "do the work, but check with me before you merge."

ORC is that middle ground - and the layer that connects every session.

## Who This Is For

ORC is developer infrastructure. A single binary that orchestrates your AI agents, holds their shared state, and routes their work through your approval.

It's for developers who:

- Run multiple agent sessions - same agent or different agents, serial or parallel - that need shared context
- Want agents to do work autonomously and submit it for review, not wait for hand-holding
- Use more than one coding agent (Claude Code, Codex, Cursor, Gemini, Copilot) and need them to coordinate
- Want to schedule agent work on a cron and review results when convenient
- Need a record of what happened, what was decided, and why

Think of it like CI/CD for agent work. It's plumbing. Good plumbing makes everything above it work better.

## Why Each Feature Exists

**Agent orchestration** - A task loop that polls the board, spawns worker agents, manages concurrency, handles session resume on feedback, and respects review round limits. You create tasks; ORC runs agents to complete them. Multiple backends (Claude Code, ACPX, A2A) mean you aren't locked to one agent.

**Shared memory** - Decisions made in one session are available to every other session - whether that's a different agent or the same agent running in parallel. You stop being the person who remembers everything.

**Task board with HITL review** - Tasks have a `review` status between "agent thinks it's done" and "human agrees it's done." You get the leverage of AI doing the work without giving up the judgment of what "done" means.

**Multi-backend routing** - Route tasks to Claude Code natively, to 14+ agents via ACPX, or to remote endpoints via A2A. Unknown backend names fall through to ACPX automatically. One task board, any agent.

**Job scheduler** - Any command can run on a schedule, file-watch, or webhook. The highest-leverage use of AI isn't answering your questions - it's doing the thinking you'd have forgotten to do.

**Gateway (Telegram/Slack)** - Approve agent work from your phone, search memory, trigger jobs, chat with live agent sessions. The work continues at the speed of your attention, wherever that attention is.

**Session continuity** - Every significant action gets captured. When a context window fills, a compact snapshot is built and restored after compaction. Continuity is the foundation of productive work.

**Prompt library** - Prompts encode judgment. A good code-review prompt encodes your team's standards. Ship them as discoverable templates that the task loop assigns to workers automatically.

## How They Combine

You describe what you need. A main agent gathers requirements, creates tasks, assigns workflows. The task loop spawns workers - a coder implements, a reviewer checks the work. Each worker stores decisions in shared memory, posts progress as comments, and submits for your review. You get a Telegram notification. You approve from your phone. Dependents unblock. The next task starts. Tomorrow morning, a scheduled report job tells you what shipped.

Every feature feeds the next. Individually, each is useful. Together, they're a workflow that runs at the speed of your attention - not your typing.

## What ORC Is Not

ORC doesn't generate code. It doesn't think. It doesn't replace your agents - it coordinates them.

It's infrastructure: the layer between your agents and your working life that holds state, routes work, manages approvals, and keeps a record of everything.

**Lean by design.** One binary. One SQLite file. No cloud. No account. No subscription.
