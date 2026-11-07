# Concepts

This page defines the objects ORC stores and how they relate, one short section each.

## Projects

A project groups tasks, memories, jobs, knowledge bases, skills and scratchpads. It usually maps to one repository.

| Field | Meaning |
| --- | --- |
| `name` | Readable, unique name used by the CLI, MCP and URLs |
| `scope` | Folder on the execution host where the project's work runs |
| `git_remote_url` | Optional HTTPS or SSH remote; metadata only, nothing is cloned |
| `status` | `active`, `paused` or `archived` |
| `max_workers` | Optional per-project cap on concurrent task workers |

```bash
orc project add my-app -d "Main application"
orc project use my-app          # later commands default to my-app
orc task list -p infra          # override for one command
```

Resolution order: `-p <name>`, then `activeProject` from config. MCP tools take `project: "<name>"`, or inherit it from the `/mcp?project=` connection URL.

## Tasks and status flow

A task is one unit of work: title, body, priority (`low`, `normal`, `high`, `critical`), optional skill, agent backend and model, flow, Git branch/worktree, and GitHub issue/PR links. Tasks link to each other as dependencies.

```text
todo → queued → doing → review → done
                  │         │
                  ▼         ▼
               blocked   changes_requested → doing
                  │
                  ▼
                paused                 (any) → cancelled
```

| Status | Meaning |
| --- | --- |
| `todo` | Not started |
| `queued` | Claimed and waiting for a worker slot |
| `doing` | A session is running on it |
| `review` | Agent submitted work; waits for approval |
| `changes_requested` | Sent back with feedback |
| `blocked` | Waiting on a dependency or an external fix |
| `paused` | Stopped, for example after `max_review_rounds` |
| `done` / `cancelled` | Terminal |

`required_review: true` (the default) keeps a task in `review` until you approve. Dependents unblock when their dependencies finish.

## Task flows

Every task runs a flow graph. `orc-default` is plan → build → verify → review with bounded rework; `orc-human-review` adds your sign-off; `orc-review-only` reviews existing work. Flows are nodes (`agent`, `gate`, `human`, `terminal`) joined by declarative edges, with visit limits, budgets and a wall clock so loops always end.

See [Task flows](./task-flows.md).

## Agent backends

A backend is the coding agent that runs a task node, job or chat session.

| Backend | Runs |
| --- | --- |
| `claude` | Claude Agent SDK in-process (default) |
| `claude-cli` | The `claude` binary |
| `codex-cli` | The `codex` binary |
| `acpx` | ACP CLI, which drives 14+ agents (Gemini, Copilot, Cursor, Kiro, ...) |
| `acp` | An explicitly configured direct ACP command with negotiated capabilities |
| `agentapi` | A coder/agentapi server wrapping any local agent |
| `a2a` | A remote A2A endpoint |
| any other name | A configured `agent_loop.acp_commands` entry, otherwise passed to acpx as the agent name |

`orc doctor` reports which backends are usable on the machine. `GET /api/backends` returns the same data.

## Sessions

A session is one coding-agent conversation. ORC tracks two kinds:

- **Managed sessions** that ORC started: task workers, job runs, chat and terminal agents. They record backend, model, execution host, cwd, transcript, tokens and linked task.
- **Live sessions** that you started yourself in Claude Code, Codex, Cursor or Gemini. ORC discovers them from native history and lifecycle hooks and shows them as working, waiting or ended.

The Sessions view lists both, with search, transcripts, **Resume → Terminal** and resume commands. Sessions can also be archived to ORC and handed off to another machine.

See [Live sessions](./live-sessions.md) and [Session handoff](./session-handoff.md).

## Memory

A memory is a short project fact: a port, a convention, a gotcha, a decision. Each has a unique lowercase-hyphenated `name`, a `description` of when it matters, `content` (up to 800 characters by default) and a `priority` from 0 to 100. `context` loads the top memories into every session. Every edit is versioned and revertible.

```bash
orc mem add ulid-ids -d "Check before adding an ID field" -c "All IDs are ULIDs" --priority 90
orc mem history ulid-ids
```

Memories import from and export to Claude Code and Codex native memory folders with `orc mem import|export`.

## Knowledge bases

A knowledge base holds reference documents for agents to search and cite. It belongs to a project or is global. Documents come from uploads (PDF, Office, HTML, CSV, Markdown, text), Markdown written in the dashboard, or registered folders that are copied in and rescanned.

Search combines title matches, SQLite full-text search and, when embeddings are configured, vectors. Results cite passages as `kb:<doc>@<rev>#<n>`. Each knowledge base sets which call sources may edit it (`ui`, `cli`, `api`, `mcp`). A digest is a scheduled agent that maintains a knowledge base from comments, memories and session summaries.

## Scratchpads

A scratchpad is a working file you and agents revise together. Every save is a new revision with its author.

| Kind | Content |
| --- | --- |
| `doc` | Markdown; mermaid blocks render as diagrams |
| `diagram` | Excalidraw JSON |
| `html` | One standalone HTML page |

```bash
orc pad new doc "Auth plan" -f plan.md -p my-app
orc pad pull <id> plan.md
orc pad push <id> plan.md -r <revision>
```

Agents use `pad_create`, `pad_get`, `pad_list` and `pad_update` with `if_revision` to avoid overwriting your edits.

## Jobs

A job separates what runs from when it runs.

| Action | Does |
| --- | --- |
| Run command | Runs a shell command |
| Run agent | Runs an agent with saved instructions, backend and model |
| Create task | Creates a task, optionally starting its flow |

| Trigger | Fires |
| --- | --- |
| `manual` | On `orc job run` or the dashboard |
| `cron` | On a cron schedule |
| `watch` | On file changes |
| `webhook` | On a signed HTTP delivery |
| `one-shot` | Once |

New jobs are disabled until you enable them. Every run keeps status, logs and links to its session or task.

## Webhooks

A webhook source is a reusable signed endpoint that triggers jobs. Generic sources verify `X-Orc-Signature-256`; GitHub sources verify `X-Hub-Signature-256`. One source can drive several jobs, each with its own event and action filters. Delivery history keeps metadata and a payload hash, not the body. The receiver sits outside bearer auth; the per-source HMAC secret is its authentication.

## Channels

Channels connect ORC to Telegram and Slack. In **Settings → Channels** you add a connection, pair approved recipients, and define ordered inbound rules that route messages to agents. Agent replies return to the same conversation. Agents send on their own with `channel_send` or `POST /api/channels/messages`. Attention notifications are a separate opt-in.

The older config-based gateway (`gateway.telegram`, `gateway.slack`) still supports `/status`, `/tasks`, `/approve`, `/reject`, `/jobs`, `/run`, `/mem` and `/agent`.

## Human requests

A human request is a question, approval or command an agent needs you to answer. It appears in the header's **Notifications** menu, can notify you through configured human-request channels and push, and returns your answer to the waiting agent call. Managed agents create them automatically for structured questions and tool approvals; agents can also call `human_request`. Each request shows its execution host.

See [Human requests](./human-requests.md) and [Command requests](./command-requests.md).

## Rules

Rules evaluate coding-agent events before selected tools run and return a deterministic decision (deny, or abstain and let the call proceed), add guidance, rewrite a command through a processor, or enqueue a job after a matching event. Policies are opt-in, scoped to a workspace folder, and versioned. Enable with `rules.enabled: true` or `ORC_RULES_ENABLED=true`.

See [Agent rules](./agent-rules.md).

## Skills and agent profiles

A skill is a `SKILL.md` folder of instructions, scripts and references that agents load with `skill_read`. An agent profile (`.agent.md`) defines a specialist that any backend can run. Packages bundle skills, profiles and instructions. See [Skills](./skills.md) and [Agent packages](./agent-packages.md).

## Audit

ORC keeps a central audit log of knowledge changes and notification, human-request, job-run and task lifecycle events. Read it in Activity → Audit or `GET /api/audit`; `audit_list` also exposes knowledge history over MCP. Audit retention defaults to 90 days, configurable independently from the 30-day notification history. See [Notifications](./notifications.md). Memories and skills also keep their own change history with revert.
