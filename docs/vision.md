# Vision

## The Gap

Every AI agent session today is an island. Start a new Claude Code session and it knows nothing about the last one. Run two sessions in parallel and they can't coordinate. Switch to Cursor or Codex and you start from zero. You become the integration layer — manually copying context between sessions that should share it automatically.

Worse: you either trust the agent completely, or you can't trust it at all. There's no middle ground. No way to say "do the work, but check with me before you touch production."

ORC is that middle ground.

## Who This Is For

ORC is developer infrastructure — a binary you install once that sits at the center of your workflow and gets out of the way until you need it.

It's for developers who:

- Run multiple agent sessions (same agent or different agents) that need to share context
- Want to automate AI tasks on a schedule
- Need to review and approve AI work rather than babysit it
- Care about knowing what happened and why

Think of it like `git` for your AI workflow. It's plumbing. Good plumbing makes everything above it work better.

## Why Each Feature Exists

**Shared memory** — Decisions made in one session should be available to every other session — whether that's a different agent or the same agent running in parallel. You stop being the person who remembers everything.

**Task board with HITL review** — Tasks have a `review` status between "agent thinks it's done" and "human agrees it's done." You get the leverage of AI doing the work without giving up the judgment of what "done" means.

**Job scheduler** — Any command can run on a schedule, file-watch, or webhook. The highest-leverage use of AI isn't answering your questions — it's doing the thinking you'd have forgotten to do.

**Gateway (Telegram/Slack)** — Approve agent work from your phone, search memory, trigger jobs. The work continues at the speed of your attention, wherever that attention is.

**Session continuity** — Every significant action gets captured. When a context window fills, a compact snapshot is built and restored after compaction. Continuity is the foundation of productive work.

**Prompt library** — Prompts encode judgment. A good code-review prompt encodes your team's standards. Worth preserving and reusing as seriously as code.

## How They Combine

You make a decision. It flows into memory. An agent reads it before making a related choice. The choice becomes a task. A scheduled job picks it up, runs Claude against it, submits for review. You get a Telegram message. You approve. The session summary logs what happened. Tomorrow morning, your standup job reads the log and tells you what matters.

Every feature feeds the next. Individually, each is useful. Together, they're a workflow.

## What ORC Is Not

ORC doesn't have a chat interface. It doesn't generate code. It doesn't think.

It's infrastructure — the layer between your agents and your working life that holds state, routes approvals, runs jobs, and keeps a record of everything. Like CI/CD for agent work.

**Lean by design.** One binary. One SQLite file. No cloud dependency. No account. No subscription.
