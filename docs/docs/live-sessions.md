# Live agent sessions

The Sessions view uses the same working, waiting and ended states, task links, search and conversation viewer for all agents. Waiting sessions stay in the active view; inactivity alone does not end a registered session.

Opening a linked task keeps you on that task even while a session search is updating.

Sessions without a title use a readable folder name, including Windows extended
paths, network shares, file URLs and POSIX paths. For example,
`\\?\C:\Projects\orc` displays as `orc` rather than the full path in session and
notification titles. Named sessions keep their titles; execution uses the original
folder path. Codex uses the first prompt when its native title is only the folder.

Activity and full-width session history share compact title/provider/state rows.
An ORC terminal agent without observed session activity shows **Unknown**, rather
than assuming it is idle. A session's working folder decides its project: the most
specific project folder wins, and a worktree resolves to its shared checkout even
when it lives outside the project's folder. Opening a session from the session
list adopts its project in the workspace header, so the session list and
notification inbox follow the project you are actually working in. The mapping is
re-evaluated when project folders change, and live sessions and their
notifications move with them; a session whose project folder was moved away stops
claiming the old project. Each project has one folder scope. Worktrees resolve to
their shared checkout, and a project without a scope takes the repository roots of
its known sessions as derived folders, so no second folder list is stored.
OpenCode's session store is watched alongside the other agent stores, so its new
sessions appear without waiting for another agent's activity.

![Compact Activity session rows with demo data](/screens/activity-session-rows.png)

Open a Codex or Claude session to see its last reported cached-input percentage.
Expand that compact row for input, cached reads, cache writes when reported, and
recorded session totals. Cached input is a share of **input** tokens, not output
or total billed cost. Claude input includes uncached input plus cache reads and
writes; Codex reports input with its cache reads already included. Claude totals
deduplicate repeated messages; Codex totals use the provider's cumulative snapshot.

When Claude records a cache-write lifetime and activity timestamp, the indicator
can change to **Cache may need rebuilding** after that lifetime has elapsed
since the recorded activity. This is a conservative hint, not an exact expiry or
a guarantee about the next request: request generation time, prompt changes and
other requests can affect reuse. Missing cache metrics or timing are omitted;
there is no expiry-unavailable message. Codex does not currently provide timing
evidence here. Other backends omit the indicator until native cache metrics are
supported. Metrics refresh every 15 seconds while an active session's details
are open; opening an ended session reads its recorded data once.

![Session cache details with demo data](/screens/session-cache.png)

Codex uses its native writer locks and latest turn status. A held lock identifies an open session; a completed turn is waiting, and a turn in progress is working. A released lock ends the session. Older Codex versions without a writer-lock directory retain the legacy activity fallback.

Cursor IDE history, Cursor CLI (`agent` / `cursor-agent`) history and Gemini conversations are discovered separately. CLI and IDE Cursor histories are separate stores: only Cursor CLI records offer a CLI resume command. Gemini and Cursor CLI support Resume in a terminal, Copy resume command, and Copy terminal link alongside Claude and Codex.

OpenCode sessions are read from its SQLite store (`~/.local/share/opencode/opencode.db`) on the local machine or the selected SSH host. Top-level sessions appear with their folder, title and token count; the conversation viewer shows messages, reasoning and tool calls with their output. OpenCode has no lifecycle hooks, so its sessions are listed as ended. Resume opens `opencode --session <id>` in a terminal, and ended OpenCode sessions also appear in the chat history list, where opening one imports its transcript and continues the same session in chat.

Pi 1.5.2+ sessions are discovered from the native `~/.pi/agent/sessions` JSONL store on the selected execution host. Absolute `PI_CODING_AGENT_DIR` paths in Pi provider environment settings (and the local server environment) are also scanned under their `sessions` directory. The viewer follows the active branch and context edits and shows text, reasoning, tool calls/results and image placeholders. Native names and recorded token totals are retained. External Pi sessions appear as ended because Pi has no lifecycle hook registration. Close the native Pi conversation before resuming it in ORC to avoid concurrent writers.

Resume in chat imports the visible history and continues the original Pi UUID in its original folder and execution host. It uses the enabled default Pi provider, the enabled built-in Pi provider, or the sole enabled Pi provider, in that order. If several named Pi providers are enabled, choose the intended one as the default first. Native history is not replayed as a new prompt. Terminal resume uses `pi --session <uuid>`. Custom `--session-dir` stores outside these directories, older session formats, cross-host handoff and embedding/archive ingestion are not supported for Pi.

A Claude permission prompt, Claude question, or Gemini tool-permission prompt sets that session to **Waiting for you** within a few seconds of the hook firing. ORC sends one browser push on the attention topic for that transition. Answering the prompt, or the turn ending, clears the flag. A session that stays waiting does not send another push. Codex questions continue to come from its transcript. OpenCode chat questions use the same question card and waiting state even though discovered OpenCode sessions still show as ended. Cursor's installed hooks do not include a permission event, so Cursor waits are unchanged.

Install lifecycle hooks for Claude, Cursor and Gemini from this checkout:

```powershell
bun scripts/install-session-hooks.ts
```

The installer preserves existing hook entries and other settings, makes dated backups, and adds lifecycle events to `~/.claude/settings.json`, `~/.cursor/hooks.json` and `~/.gemini/settings.json`. Claude gains permission, notification, question and stop hooks. Gemini gains the notification hook beside its existing lifecycle events. New/resumed sessions register their owner PID in `~/.orc/live-sessions/`. Start, prompt, response, tool and stop hooks update the shared state; session-end hooks and dead owner processes end it. Existing sessions may need to resume or reload hooks once before they register. Hook-captured conversations begin when hooks are installed; old native history is retained when its transcript exists.

Hooks need Bun on the installation machine. They run a bounded owner lookup, write private local registry/transcript files, and never grant tool permissions or inject prompts. Native agent transcripts remain read-only. Full prompt/tool content belongs to the local conversation history and is not sent to external services by these hooks.

Other local agents can use `LiveRegistration`, `readRegistrations` and `writeRegistration` from `@orc/core/live-session` to participate in the same PID-backed lifecycle. Native discovery/resume commands still require a supported adapter; the dashboard automatically includes registered backend names in its filter.

## Sending a message to a session

Open a session and use **Send message** to queue a note for it. ORC delivers
queued notes at the session's next safe point: before a tool call, at a prompt
submit or stop hook, or when the agent reports session start. For an ended
session, ORC resumes it with a bounded turn. Messages wait in a compact queue
you can reorder or cancel until delivery starts. A delivered message records
whether it arrived through a native hook (`hook`), an ORC chat turn (`chat`), a
resume (`resume`) or native steering into a running chat turn (`steer`).

Live sessions of agents without a context-capable hook (for example Cursor or
OpenCode) cannot receive a message while they are running; queue it after the
session ends. Claude, Codex and Gemini sessions accept messages through their
installed hooks and the ORC-managed Claude SDK hook.

Delivery is not approval. ORC tells the recipient the message came from another
session or a human relay, that it cannot approve a tool, permission, plan or
configuration change, and that configuration must be changed by a human. An
agent-to-agent message chain ends after three hops, and one agent session may
queue at most 20 messages per target in a rolling hour. Pass a stable
`request_id` when retrying the same send. Messages still delivering when ORC
restarts become `interrupted` and are never retried; queued messages remain
queued.

The same queue is available to agents through the `session_send` MCP tool
(bind the connection with `?session=<session id>` or run stdio MCP inside the
agent) and to chat channels with `/send <session id> <message>`.

```text
/send                  list live sessions
/send <id>            choose a target
/send <id> Fix the failing test
```

## Delegating to other sessions

An agent can start and drive other sessions, the way Claude Code drives its
subagents:

| MCP tool                          | Does                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `session_start`                   | Starts a headless ORC chat with a prompt and returns its `session_id` immediately                  |
| `session_send`                    | Messages it: `queue`, `steer` or `interrupt`                                                       |
| `session_status` / `session_list` | Status (`queued`, `running`, `waiting`, `idle`, `failed`, `stopped`), last reply, queue, parent and children |
| `session_wait` | Blocks until it stops running, waits for a human, or replies (`until: message`); `session_ids` with `mode: all` or `any` waits on several children |
| `session_stop` | Stops its current turn and, by default (`cascade`), every session it started; queued children are cancelled; messages queued for a stopped session wait until a human sends it a message; sessions stay resumable |

`session_start` takes `workspace`:

| `workspace`      | Same project                                                                   | Another project (`project`)               |
| ---------------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| `same` (default) | The caller's folder, sharing uncommitted edits                                 | Refused                                   |
| `worktree` | A new git worktree under `.orc/worktrees/` on a new branch cut from the caller's committed HEAD (uncommitted edits stay behind) | A new worktree of that project's checkout |
| `project`        | The project's main checkout                                                    | That project's main checkout              |

Another project must be inside the caller's MCP project scope.

When all four chat workers are busy, `session_start` still returns at once: the child is `queued` and starts when a worker frees, even across an ORC restart.

With `notify` (default on), ORC tells the parent when the child finishes, fails,
is stopped or waits for a human. If the parent is mid-turn on an agent with
native steering (Claude through the Agent SDK, Pi, Codex) the note is steered
into that turn; otherwise it is queued for the parent's next safe point, or
starts the parent's next chat turn when it is idle. Each note starts with a header line,
`[orc child-session id=<id> outcome=<outcome>]`, so the parent can tell it from human text. The same delivery path
carries human messages and channel relays.

Guardrails:

- Only a session's parent, or an ancestor of the parent, can `steer`, `interrupt`
  or stop it. Any other session can only `queue`.
- A child inherits its parent chat's permission mode, agent options and tool
  allowlist; a child of any other session starts in the default permission mode.
  A child's permission prompt or question goes to a human, never to the parent.
- A child's notifications to its parent count toward the 20-messages-per-hour cap
  for that pair.
- A chain of started sessions stops at three levels, and a session can start
  at most ten sessions an hour.

Chat and the session detail show the lineage: **Started by** links the parent,
and **Started N sessions** lists the children, including the worker sessions
of tasks the agent created with `task_create`.

![Lineage on a parent chat](/screens/session-lineage-desktop.png)

[Phone layout of a child chat](/screens/session-lineage-phone.png)
