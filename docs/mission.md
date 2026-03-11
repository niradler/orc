# The Collaboration Gap

## Why We Built ORC

---

The way developers work with AI has changed faster than the tools around it.
You have Claude Code in one terminal, Cursor in another, a Telegram message from
yourself reminding you what you were doing yesterday, and a CLAUDE.md file that
four different agents have rewritten without any of them knowing what the others said.

The agents are getting smarter. The infrastructure around them hasn't kept up.

This is the gap ORC fills.

---

## The Core Problem

Every AI agent today is an island.

Claude Code has its own memory. Cursor has its own context. Codex starts fresh.
When you switch between them — which every developer does, multiple times a day —
you lose the thread. You become the integration layer. You are manually copying
context between tools that should be sharing it automatically.

Worse: you don't know what your AI did while you weren't looking.

You come back to a session, something changed, and there's no reliable way to know
why, who approved it, or what the agent was thinking. The work happened. The reasoning
evaporated.

And then there's the deeper issue: **you either trust the agent completely, or you
can't trust it at all.** There's no middle ground. No way to say "do the work, but
check with me before you touch production."

ORC is that middle ground.

---

## Who This Is For

ORC is developer infrastructure. Not an app, not a SaaS platform — a binary
you install once, that sits quietly at the center of your workflow and gets out of
the way until you need it.

It's for developers who:

- Use two or more AI coding agents in their daily work
- Want to automate AI tasks on a schedule (morning standup, nightly review, PR analysis)
- Need to stay informed without staying attached to a terminal
- Want to review and approve AI work rather than babysit it
- Care about knowing what happened and why — especially when something breaks

Think of it less like a product and more like `git` for your AI workflow.
It's plumbing. But good plumbing makes everything above it work better.

---

## The Features, and Why Each One Exists

---

### 1. Shared Memory — The Persistent Brain

**The gap:** Every agent session starts blank. Every morning, you re-explain your
project to Claude. Every time you switch from Cursor to Claude Code, you paste the
same context again. Your institutional knowledge lives in your head, not anywhere
the agents can find it.

**The story:** You spend an hour with Claude Code figuring out that your auth token
refresh has a race condition and the fix involves a specific mutex pattern. You write
it down in a note. The next day, you open Cursor. It knows nothing. You explain it
again. A week later, you onboard a colleague who asks about the auth system.
You explain it a third time.

**What ORC does:** Everything worth remembering gets stored once, searchable
everywhere. When you make a decision — "we use PostgreSQL, not SQLite, because of
concurrent writes" — that decision lives in a shared knowledge base that every agent
can query before starting work. The memory outlasts any single session, any single
agent, any single conversation.

**Why it matters:** You stop being the person who remembers everything. The system
remembers. You and your agents can focus on doing the work instead of reconstructing
the context for it.

---

### 2. Task Management With AI as a First-Class Participant

**The gap:** Task management tools were designed for humans managing humans.
Jira, Linear, Notion — they assume a person picks up a ticket, does work, and
marks it done. They weren't designed for an AI to pick up a task, do the work,
and hand it back for a human to review. There's no status for "the agent finished
but I haven't checked it yet."

**The story:** You have 12 open tasks. Claude Code closes 4 of them overnight in
a scheduled session. How do you know which ones it touched? How do you know the
fixes are actually correct? You have to read through session logs, diff files,
piece together what happened. By the time you've verified the work, you've spent
as much time reviewing as you would have fixing.

**What ORC does:** Tasks have a `review` status — a dedicated holding state
between "agent thinks it's done" and "human agrees it's done." When an agent
finishes work, it doesn't mark the task done. It submits it for review, with a
plain-language summary of what it did. You see it, you decide: approve and move on,
or send it back with a note. Agents and humans share the same task board.

**Why it matters:** You get the leverage of AI doing the work without giving up
the judgment of what "done" actually means. The review queue becomes your daily
interface to everything your agents have been working on.

---

### 3. Human-in-the-Loop Review — Approval as a Workflow

**The gap:** The current options are "trust the agent completely" or "watch every
keystroke." Neither is sustainable. `--dangerouslySkipPermissions` exists because
the permission model is binary — it's either locked down so much it's unusable, or
wide open. There's no "I trust you with tests but not with production."

**The story:** You're at lunch. Claude is running a refactor job. It finishes the
code changes, runs the tests, and then wants to delete 40 old files. This is fine —
you'd approve it instantly. But without `--dangerouslySkipPermissions`, the job is
blocked. With it, you have no idea what it'll delete. Neither option is right.

**What ORC does:** Approval is a first-class concept. Jobs can require sign-off
before running. Agents can pause at a decision point and wait for a human response.
Task reviews are a structured conversation — not just a binary yes/no, but a
message thread where the human can say exactly what needs to change and the agent
can read that note on the next attempt.

**Why it matters:** Trust between humans and AI agents is built incrementally.
You give the agent more autonomy as it proves it deserves it. The approval system
is the mechanism for that trust to grow safely.

---

### 4. Telegram Bridge — Your AI Agents in Your Pocket

**The gap:** AI agents live in terminals. You don't. Your best thinking often
happens away from your desk. A decision you need to make, a review you need to
give, an approval you need to grant — these things get blocked not because they're
hard, but because you're not in front of the right window at the right time.

**The story:** You're in a meeting. You get a Telegram message: "Claude finished the
auth refactor. 3 files changed, 2 tests added. Approve?" You read the summary,
tap Approve, and it's done. The agent unblocks. The deploy continues. You return
to the meeting. Nothing slipped.

Alternatively: you're on your phone and you wonder what's on your task list. You
send `/tasks` to the bot. You get back a summary of everything active, grouped by
project. No laptop needed.

**What ORC does:** A bidirectional bridge between your agents and your
messaging app. Not just notifications that something happened — a full conversation
where you can approve work, query your task board, search your memory, fire off
a job, and get results back. The agent waits for your response and continues.

**Why it matters:** Productivity isn't just about doing more. It's about not being
blocked. The Telegram bridge removes the friction of "I need to sit at my laptop
to make a decision." The work continues at the speed of your attention, wherever
that attention is.

---

### 5. Job Scheduler — Proactive AI, Not Reactive AI

**The gap:** You only get value from AI agents when you ask them something.
But most of what an agent could usefully do for you — review your calendar,
summarize overnight progress, check for security issues, run tests, prepare
a daily brief — nobody asks for because they forget, or they're busy, or it
feels like too much effort to set up.

**The story:** Every morning you want to know: what are the three most important
things to work on today? This would take Claude 30 seconds to figure out from
your task board and memory. But you only get this if you open a terminal, start
a session, type the question, and wait. Most mornings you don't. Most mornings
you just start working on whatever is loudest, not whatever is most important.

**What ORC does:** Any command — Claude, Codex, a shell script, an API call,
anything — can be scheduled to run automatically. Daily at 9am. Every Sunday.
Whenever a file changes. When a webhook fires. The agent wakes up, does the work,
sends you the result, and goes back to sleep. You never have to remember to ask.

**Why it matters:** The highest-leverage use of AI isn't answering your questions.
It's doing the thinking you would have forgotten to do. A scheduled nightly review
that automatically organizes your next day is more valuable than any individual
Claude session.

---

### 6. Prompt & Skill Library — Reusable Intelligence

**The gap:** Everyone rewrites the same prompts. You find a prompt that works
brilliantly for code review. You use it once. Next week you can't find it. You
write it again, slightly differently. Worse: you have no way to share it with
your teammates, or make it available to automated jobs, or update it in one place
and have the update apply everywhere.

**The story:** You spend 20 minutes crafting the perfect prompt for reviewing PRs
against your team's specific standards. It works great. Then you want to use it in
a scheduled job that runs on every new PR. Then you want Cursor to use it when doing
code review. Then a teammate wants it. None of the current tools let you do this —
one prompt, used everywhere, versioned, shareable.

**What ORC does:** A prompt library where every prompt is a file, version-controlled
like code, with template variables that pull in live context (your tasks, your memory,
the current date, the project scope). The same prompt file works in a manual run, a
scheduled job, a Claude Code slash command, and a Codex session. Write once, run
everywhere.

**Why it matters:** The most valuable thing about great prompts is that they encode
judgment. A good code-review prompt encodes your team's standards. A good planning
prompt encodes how you think about priorities. These are worth preserving and reusing
as seriously as you preserve and reuse code.

---

### 7. Session Continuity — No More "What Were We Doing?"

**The gap:** AI sessions have no memory between conversations. Every time a context
window fills up, or you start a new session, or you switch agents, you start from
zero. "We were working on the auth bug, we decided to use a mutex, we had two tests
passing but one failing, and we were about to look at the refresh timeout case" —
none of that survives a reset.

**The story:** You're deep into a complex refactor. The context window fills. Claude
compresses the conversation. When it comes back, it's forgotten the specific decision
you made about error handling 40 messages ago. You spend 10 minutes re-establishing
context. This happens every day, multiple times. Across the whole community of developers
using AI agents, this is millions of wasted hours per week.

**What ORC does:** Every significant action — file edits, decisions made, errors
encountered, tasks updated — gets captured as it happens. When a session is about to
compress, a compact summary snapshot is built from that history. When the session
resumes, the agent gets that snapshot injected and continues exactly where it left off.
When you switch to a different agent entirely, they get the same snapshot.

**Why it matters:** Continuity is the foundation of productive work. You can't
build complex systems in short, amnesiac bursts. Session continuity means the
work accumulates instead of restarting.

---

### 8. Audit Log & Event History — Know What Happened

**The gap:** AI agents work fast and leave little trace. Something changed in your
codebase. Was it the agent? Which one? When? Why? What else changed in the same
session? Currently there's no good answer to these questions. Agent work is a black
box with outputs but no visible reasoning.

**The story:** You come back from a week off and something in production is behaving
differently. You trace it back to a change that happened in an automated job five
days ago. But you don't know why the agent made that change, what it was trying to
accomplish, or what else it changed in the same session. Without that context, the
bug investigation takes hours instead of minutes.

**What ORC does:** Every action flows through a central event log. Every job run
records what happened: what was executed, what the output was, what tasks were updated,
what decisions were made, who approved what. This isn't just for debugging — it's for
understanding the shape of your AI-human workflow over time.

**Why it matters:** You can only improve a process you can observe. The audit log
is how you learn which jobs are actually useful, which prompts are working, which
agents make better decisions on which kinds of tasks. It's also how you recover
when something goes wrong.

---

### 9. Cross-Agent MCP Integration — One Brain, Many Tools

**The gap:** Every agent has its own configuration, its own context, its own memory,
its own way of doing things. Getting three agents to share information requires either
a common file convention everyone agrees on (fragile) or a dedicated integration per
pair (impossible to maintain). There's no neutral ground.

**The story:** You configure Claude Code to remember your architectural decisions.
Two weeks later you start using Cursor for frontend work. Cursor knows nothing about
those decisions. You have to either maintain duplicate memory in both tools, or
accept that Cursor will make choices that contradict what Claude Code already knows.
Neither is acceptable as you add a third agent, a fourth.

**What ORC does:** A single MCP server that any agent can connect to in one
line of configuration. Once connected, the agent can read your tasks, search your
memory, log its actions, and submit work for review — all through the same interface
every other agent uses. You configure ORC once. Every agent you add inherits
the full context immediately.

**Why it matters:** The value of a shared knowledge base compounds with the number
of agents and people using it. Two agents that share memory are four times more
useful than two agents that don't. Adding a third isn't linear — it's exponential.

---

### 10. Obsidian Integration — Human Notes in the Loop

**The gap:** Developers who think carefully write things down. They have Obsidian
vaults, Notion pages, markdown notes full of decisions, research, half-formed ideas.
None of this is accessible to AI agents. The best context your agents could have —
your own thinking — is locked in files no agent can find.

**The story:** You wrote a 3-page note in Obsidian last month about why you chose
your current database architecture. It has context that took you hours to develop
and is directly relevant to a decision Claude is about to make. Claude has no idea
that note exists. It makes a different decision based on incomplete information.

**What ORC does:** Your Obsidian vault becomes part of the shared knowledge
base. Notes you write become memory that agents can search. Work that agents do
gets written back into your vault — task completions, session summaries, daily
digests — so you can read it in the tool you use for thinking.

**Why it matters:** Your notes and your agents' knowledge should be the same
knowledge. The barrier between your thinking environment and your agents' context
is artificial and expensive. Remove it.

---

## How They Combine

These aren't ten separate features. They're one system.

**The loop looks like this:**

You write down a decision in Obsidian. It flows into memory. An agent reads it
before making a related choice. The choice becomes a task. The task goes on the
board. A scheduled job picks it up at 10pm, runs Claude against it, and submits
the result for review. You get a Telegram message on your phone. You approve it.
The task closes. The session summary gets written back to your vault. Tomorrow
morning, your standup job reads the audit log and tells you what happened.

Every feature feeds the next. The scheduler is only powerful because it has access
to your memory and your tasks. The review flow is only trustworthy because it's
backed by an audit log. The Telegram bridge is only useful because it connects to
real state, not just notifications. The session continuity is only possible because
there's a central store all agents write to.

Individually, each of these is a nice feature. Together, they're a workflow.

---

## What We Are Not

ORC is not trying to be OpenClaw, Claude Desktop, or an AI assistant.
It doesn't have a chat interface. It doesn't generate code. It doesn't think.

It's infrastructure. It's the system that makes AI agents more useful in
combination than they are in isolation. It's the layer between your agents
and your working life that holds state, routes approvals, runs jobs, and
keeps a record of everything.

The analogy is a CI/CD system for AI work. CI/CD doesn't write your code.
It makes the code you write more reliable, more visible, and more consistent.
ORC does the same for agent work.

**Lean by design.** One binary. One SQLite file. No cloud dependency. No account.
No subscription. It works on your machine, stays on your machine, and disappears
when you don't need it. The complexity lives in the ecosystem around it —
the agents, the workflows, the skills — not in ORC itself.

---

## The Developer Experience We're Aiming For

You install `sk` in 30 seconds. It's a single binary, no dependencies.

You run `sk init` and answer three questions: where's your projects directory,
what's your Telegram bot token (optional), which agents do you use.

That's it. Within five minutes you have:

- A task board your agents can write to
- A memory store they can search
- A Telegram bot that will notify you about important things
- Hook configs ready to drop into Claude Code, Cursor, or Codex

You add your first scheduled job — a nightly review that asks Claude to organize
your next day — and forget about it. The next morning, you wake up to a Telegram
message with your priorities for the day, organized by your AI, based on your actual
task board and memory.

That's the experience. Not a complex setup, not a steep learning curve, not a
product that requires onboarding. A tool that does one important thing well: keeps
you and your AI agents in sync.

---

## Why Now

A year ago, most developers used one AI agent occasionally. Today, serious developers
use two or three agents daily, often in parallel. In a year, that number will be
five or ten, and some of them will be running autonomously while you sleep.

The coordination problem scales quadratically. Two agents with no shared context
is annoying. Five agents is chaos. Ten autonomous agents with no human visibility
is how you accidentally introduce a subtle security bug and don't find it for a month.

The infrastructure for this kind of work needs to be built before the chaos arrives,
not after. ORC is that infrastructure. Built lean, built open, built for
developers first — so that whatever comes next, you have the foundation to handle it.

---

## The Gap, In One Sentence

**AI agents are getting better at doing work. We're still missing the layer that makes
that work legible, controllable, continuous, and collaborative for the humans
working alongside them.**

That's what ORC is.
