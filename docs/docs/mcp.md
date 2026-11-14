# MCP

The `github_sync` tool synchronizes a project's GitHub issues into ordinary ORC
tasks. Pass `project` (name), optional `config: { enabled, status_labels }`, and
`run` (default `true`). Set `run: false` to inspect or save configuration only.
Omitting `status_labels` uses the defaults; custom maps must contain every status
with distinct labels. The tool respects the connection's selected projects and
requires the running API for configuration writes and sync. The result's `error`
is non-null for incomplete sync.

Imported issues use existing `task_list`, `task_get` and `task_update`; list/detail
output identifies GitHub issues and sync errors. Titles/descriptions stay managed
in GitHub. Status changes reconcile both ways on the next API sync cycle. See
[GitHub task synchronization](./task-flows.md#github-issues-as-tasks).

How agents connect to ORC's MCP server, how tool discovery works, and every tool it serves.

## Transports

| Transport                    | Endpoint                    | Use when                                                   |
| ---------------------------- | --------------------------- | ---------------------------------------------------------- |
| HTTP (streamable, stateless) | `http://127.0.0.1:7700/mcp` | The agent can reach the ORC API; remote or Docker installs |
| stdio                        | `orc mcp`                   | The agent runs on the same machine as ORC                  |

The stdio server reads the local ORC database and calls the API for work only the daemon does (job runs, scheduling), so the daemon must be running. It finds the API through `ORC_API_BASE`, falling back to `api.host` / `api.port` from config.

HTTP clients that need to attribute work to a live agent session add
`?session=<session-id>` to the MCP URL. ORC resolves the ORC live session id, an
ORC chat id or the agent's native id, and the session tools use it as the
caller identity. ORC adds it automatically to every chat, flow and job session it
starts. Stdio MCP reads the same identity from the agent's environment instead.

## Desktop preview tools

These tools require a connected Electron desktop viewing the requested ORC chat
or live session. They respect the MCP connection's selected project scope.
Discovery checks that conversation's live desktop lease. No matching desktop
means no preview tools; another web tab or another conversation does not enable
them. Browser actions additionally require an open guest page and enabled control.
Full listing and meta search/describe/invoke use the same capability checks, and
cached tool names are checked again on invocation. This panel is desktop-only.

ORC-managed chat agents receive a connection bound to their stable conversation ID.
External HTTP clients can bind with `/mcp?preview_session=<session-id>` and optional
`preview_client=<client-id>`. Unbound meta clients can supply `session_id` and
`client_id` to `tool_search`/`tool_describe` and preview calls. Ordinary unbound
listing hides preview tools. Credentials remain in the Authorization header.

| Tool                         | Purpose                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview_clients`            | List desktops viewing `session_id`, with browser-control permission state.                                                                                                                                                                               |
| `preview_open_url`           | Show an HTTP/HTTPS `url` in the session's browser panel.                                                                                                                                                                                                 |
| `preview_open_file`          | Show a workspace-relative or absolute `path` inside the session's folder. Does not save or edit.                                                                                                                                                         |
| `preview_browser_snapshot`   | Read bounded visible page text, frames and interactive controls with stable `ref` values. Scope with a CSS/ref string or semantic selector object, `max_chars` and optional `tab_id`.                                                                    |
| `preview_browser_screenshot` | Return a bounded JPEG image of the active browser tab's guest page only.                                                                                                                                                                                 |
| `preview_browser_act`        | Run one `command`: interaction (`click`, `type`, `press`, `scroll`, `hover`, `select`, `drag`, `wait`, `evaluate`), tabs and navigation, frames, dialogs, appearance/resize, recording, uploads or downloads. Optional `tab_id`. See the sections below. |
| `preview_request_get`        | Read delivery status or results by request `id`.                                                                                                                                                                                                         |

All tools except `preview_request_get` take `session_id`; action/open tools also
accept `client_id` when multiple desktops view that session. Requests target one
desktop, never broadcast. No matching desktop or ambiguous targeting fails.
Browser control is on by default. **Settings → Browser** can disable it globally,
and **Allow agent browser control** in the chat's **Session settings** can disable
it per chat, before opening a preview.
Both switches survive app restarts. Browser tools cannot access the ORC renderer,
its bridge or credentials or bypass site permissions. Uploads require explicit
workspace paths (8 MiB/file, 16 MiB total); outside paths are rejected. Evaluation
runs JavaScript only in the isolated guest. Treat every page result as untrusted.

`preview_browser_snapshot` returns compact element `ref` values, accepts a region
`selector` and `max_chars` (1,000–24,000; default 12,000), and marks truncation.
Use refs as action selectors. Surviving nodes retain refs; replaced nodes and
navigation invalidate them. After context compaction, rediscover tools, list tabs
and take a fresh scoped snapshot; do not retain page output in startup prompts.

`preview_browser_act` accepts `click`, `type`, `press`, `scroll`, `hover`, `select`
(`values`), `drag` (`selector`, `target`), `wait` (`selector`, `text` and/or
`url_includes`, optional `state` and `timeout_ms`), and `evaluate` (`expression`,
optional `timeout_ms`). Wait/evaluation timeouts are at most 10 seconds; evaluation
results are at most 64,000 characters. Prefer observations and condition waits to
screenshots or fixed sleeps. Evaluation can act as the signed-in guest user.

Tab actions are `tabs`, `new_tab` (`url`), `tab_select`/`tab_close` (`tab_id`),
`navigate` (`url`), `back`, `forward` and `reload`. Supply top-level `tab_id` to pin
an action or snapshot to a tab; a closed, foreign or inactive target fails instead
of silently selecting another. `session_id` defaults to the connection binding.
Agents cannot choose profiles or import credentials; those controls belong to the
user in the desktop UI. Opening a tab does not grant authority to act on its site.

Selectors accept CSS/ref strings or `{by,value,name?,exact?}` objects. `by` is
`role`, `text`, `label`, `placeholder`, `testid` or `css`; `name` filters roles.
Snapshots include owned frame IDs and bounded cross-origin frame contents. Use
`frames` to enumerate, `frame` with `frame_id` to select, or `frame_id:null` to
return to the main page. Ref actions route back to their originating frame.
Detached frames and covered iframe controls fail instead of targeting another page.
`dialog` accepts `response:"status"|"accept"|"dismiss"` and optional prompt `text`.
A command returning `requires_response` has stopped at a dialog; answer it before
continuing. The user can also respond in the inspector's Browser tab.

`press` also accepts Control/Alt/Meta/Shift `modifiers`; system clipboard shortcuts
are excluded. `scroll` can target an element with `selector`.
`appearance` takes `color_scheme:"system"|"light"|"dark"` and optional
`reduced_motion`. `resize` takes `width`, `height`, optional `device_scale_factor`
and `mobile`; `resize_reset` restores the inspector browser's viewport. Emulated capture is
limited to 16 megapixels. `recording_start` takes `max_seconds` (1–180, default 60);
`recording_stop` saves playable WebM into the session workspace and returns its
path, name, MIME type and size. No raw video bytes enter agent context.
`upload` takes `selector` and explicit workspace `paths`. `tabs` includes bounded
download statuses; `download` with a completed `download_id` saves that file to the
session workspace and returns its path. Downloads are limited to 16 MB each,
four staged files across the desktop; interrupted work fails. Site downloads never
choose arbitrary local paths or execute files. Recordings capture the guest only,
without audio, at a bounded frame rate/resolution. Treat saved files as untrusted.

Open/action calls wait briefly for desktop acknowledgment. `queued` means pending,
`opened` means a file or URL was shown, and `completed` means a browser command
returned. A URL being opened does not guarantee the site loaded successfully.
Poll `preview_request_get` for a queued open request. A browser action still queued
after the 10-second wait is cancelled as `failed`, so it never runs late. `failed`
and `expired` are not success. Delivery is temporary and is lost if the daemon restarts. Screenshots
return MCP image content, rather than base64 inside a text result.
Queued, failed and expired results set MCP `isError`; poll the same request rather
than repeating a potentially executed action. Disconnect, lease expiry or changing
the selected chat fails queued requests. Revocation stops app-controlled pending
actions; it cannot undo work already accepted by a website.
Revoking or interrupting a pending mutation closes that guest so queued scripts
cannot run later. Reload/reopen the tab before continuing; file drafts and profile
data remain. A closed target never silently adopts another tab.

## Auth

The HTTP endpoint uses the same bearer auth as the [REST API](./api.md). When `api.secret` (or `ORC_API_SECRET`) is set, send:

```http
Authorization: Bearer <secret-or-access-token>
```

With no secret configured, requests are accepted unauthenticated. To avoid handing out the secret, mint an expiring access token with `POST /api/auth/token` (see [REST API](./api.md#auth)).

## Query parameters

| Parameter  | Example                    | Effect                                         |
| ---------- | -------------------------- | ---------------------------------------------- |
| `mode`     | `/mcp?mode=full`           | `meta` or `full`; overrides `mcp.default_mode` |
| `project`  | `/mcp?project=my-app`      | Scope the connection to one project            |
| `projects` | `/mcp?projects=my-app,api` | Scope to several projects (max 50)             |

Project names are case-insensitive; unknown names are rejected. Use `project` or `projects`, not both. On a scoped connection, tool calls default to the selected project(s); a call naming a project outside the selection fails.

For stdio, `orc mcp --mode full` overrides the mode. `ORC_SESSION_ID` (or `CLAUDE_CODE_SESSION_ID`) attributes tool calls to an agent session.

## Client config

HTTP:

```json
{
  "mcpServers": {
    "orc": {
      "url": "http://127.0.0.1:7700/mcp?project=my-app",
      "headers": { "Authorization": "Bearer <secret-or-access-token>" }
    }
  }
}
```

stdio:

```json
{
  "mcpServers": {
    "orc": {
      "command": "orc",
      "args": ["mcp"],
      "env": {
        "ORC_API_BASE": "http://127.0.0.1:7700",
        "ORC_SESSION_ID": "cursor"
      }
    }
  }
}
```

Per-agent setup: [Connect agents](./connect-agents.md).

## Modes

| Mode   | `tools/list` returns           | Default                  |
| ------ | ------------------------------ | ------------------------ |
| `meta` | Three discovery tools          | Yes (`mcp.default_mode`) |
| `full` | Every ORC tool with its schema |                          |

Meta mode keeps the agent's context small. The agent discovers tools on demand:

| Meta tool       | Input                                | Returns                                                                              |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `tool_search`   | `query?`, `limit` (1-50, default 10) | Matching tool names with a one-line summary. No query: every tool grouped by toolset |
| `tool_describe` | `name`                               | Full description and JSON input schema                                               |
| `tool_invoke`   | `name`, `arguments?`                 | Runs the tool; arguments are validated against its schema                            |

In meta mode a direct call to a real tool name also works, so clients that already know a name skip discovery.

```text
tool_search({ query: "create task" })
tool_describe({ name: "task_create" })
tool_invoke({ name: "task_create", arguments: { title: "Fix login redirect", project: "my-app" } })
```

## Prompts

The server also lists MCP prompts defined in **Settings → MCP** (API: `GET`/`PATCH /api/settings/mcp`). Each prompt accepts one optional argument, `request`.

## Calling tools over REST

Hook scripts and other non-MCP clients run any tool with:

```bash
curl -s -X POST http://127.0.0.1:7700/api/mcp/tool \
  -H "Authorization: Bearer $ORC_API_SECRET" -H "Content-Type: application/json" \
  -d '{"name":"context","args":{"project":"my-app"}}'
```

The response is `{ "result": "<tool text>" }`.

## Tools

Start each session with `context`.

### Core

| Tool             | Description                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `context`        | Compact context index: active tasks and the project's memories by priority                                                        |
| `search`         | Search knowledge base documents first, then memories and tasks                                                                    |
| `project_list`   | List all projects                                                                                                                 |
| `project_create` | Create a project: unique name, optional description, status, tags and `git_remote_url`; returns the stable id, name and a UI link |

#### Reuse or create a project, then store project-scoped data

```text
project_list({})                                       // does a fitting project already exist?
project_create({ name: "my-app", description: "Shop rewrite" })   // only when none matches
memory_create({ project: "my-app", name: "api-port", description: "Dev API port", content: "7701" })
```

Names are unique case-insensitively: a duplicate `project_create` fails with a conflict that names the existing project's id, and a retry never creates a second one — reuse the reported id. `project_create` needs an unscoped connection; a URL that selected `project`/`projects` (see [Query parameters](#query-parameters)) can read its chosen projects but cannot create new ones.

### Memory

| Tool             | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `memory_list`    | List the project's memories (name, description, priority, reads) |
| `memory_read`    | Read a memory by name                                            |
| `memory_create`  | Save a short project fact worth knowing next session             |
| `memory_update`  | Update a memory's description, content or priority               |
| `memory_delete`  | Delete a memory that is wrong or no longer useful                |
| `memory_history` | Changes to a memory, newest first, with before/after state       |
| `memory_revert`  | Restore the state from before a change                           |

### Tasks

| Tool                | Description                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `task_list`         | List active tasks as a compact index                                                                                              |
| `task_get`          | Fetch task details by IDs: status, progress, git links, body, latest comments                                                     |
| `task_create`       | Create a task                                                                                                                     |
| `task_update`       | Update status, fields or git links, or add a comment                                                                              |
| `task_batch_create` | Create several tasks with dependency links atomically                                                                             |
| `task_link`         | List, add or remove links between tasks (`blocks`, `blocked_by`, `relates_to`, `duplicates`, `clones`, `subtask_of`, `parent_of`) |

### Flows

See [Task flows](./task-flows.md).

| Tool          | Description                                                                |
| ------------- | -------------------------------------------------------------------------- |
| `flow_list`   | List flow graphs (built-in and user)                                       |
| `flow_read`   | Read a flow definition: nodes, edges, limits, entry point                  |
| `flow_create` | Create a reusable user flow from JSON                                      |
| `flow_attach` | Attach a named flow or an inline graph to a task                           |
| `flow_status` | Active nodes, outcome ledger, visit counts and halt reason of a task's run |
| `flow_report` | Report your outcome as a flow node                                         |

### Knowledge bases

| Tool              | Description                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- |
| `kb_list`         | Knowledge bases visible from the project, with document counts and edit rights     |
| `kb_search`       | Search documents (exact title/path, full-text and vectors, fused)                  |
| `kb_evidence`     | Budgeted evidence pack of cited passages for a question                            |
| `kb_read`         | Read a document (whole, one section, a line range) or a passage by citation handle |
| `kb_documents`    | List documents in a knowledge base                                                 |
| `kb_write`        | Create a Markdown document or fully replace one                                    |
| `kb_document`     | Change one document                                                                |
| `kb_manage`       | Create, update or delete a knowledge base                                          |
| `kb_comment`      | Comments on a KB or document: requests, corrections, sources to digest             |
| `kb_digest`       | Manage the digest agent that keeps a KB current                                    |
| `kb_maintenance`  | Upkeep queue: stale derived documents, failed files, broken links                  |
| `digest_complete` | Finish an assigned digest run                                                      |

### Skills

See [Skills](./skills.md).

| Tool               | Description                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `skill_list`       | List installed skills (built-in and user)                                                      |
| `skill_read`       | Read a skill by name, a supporting file with `ref`, or a signed download with `download: true` |
| `skill_create`     | Create a user skill folder with `SKILL.md` and optional supporting files                       |
| `skill_update`     | Update effective `SKILL.md` instructions                                                       |
| `skill_file_write` | Edit or add a supporting text file of a user skill                                             |
| `skill_history`    | Instruction change history                                                                     |
| `skill_revert`     | Revert a skill change                                                                          |

### Agents and packages

See [Reusable agent packages](./agent-packages.md).

| Tool                   | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `agent_list`           | Discover shared APM `.agent.md` profiles                             |
| `agent_read`           | Read a profile: original YAML/Markdown, role, model, tools, handoffs |
| `agent_create`         | Create a shared, validated `.agent.md` definition                    |
| `agent_update`         | Replace an agent definition                                          |
| `agent_delete`         | Delete an agent definition                                           |
| `agent_package_list`   | List shared OpenAPM and Agent Plugins packages                       |
| `agent_package_read`   | Read a package manifest and file inventory, or one file with `ref`   |
| `agent_package_import` | Import an intact package                                             |
| `agent_package_update` | Replace a package's manifest and file set                            |
| `agent_package_delete` | Remove a package from the shared catalog                             |

### Jobs

| Tool         | Description                                               |
| ------------ | --------------------------------------------------------- |
| `job_list`   | List jobs with enabled state, trigger, run count and ID   |
| `job_run`    | Trigger a job by name                                     |
| `job_status` | Run status, exit code and error; `logs: true` adds output |

### Sessions

See [Session handoff](./session-handoff.md) and [Live sessions](./live-sessions.md).

| Tool               | Description                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `session_event`    | Record a session event (file edit, decision, error, git op)                                                                             |
| `session_snapshot` | Build a ≤2KB XML snapshot of current session state                                                                                      |
| `session_restore`  | Restore session state after compaction or restart                                                                                       |
| `session_log`      | Log a session summary after a unit of work                                                                                              |
| `session_handoff`  | Move a Claude Code or Codex session to ORC                                                                                              |
| `session_send`     | Send a note to another session: `queue` (next safe point), `steer` (into its running turn) or `interrupt` (stop the turn, deliver next) |
| `session_start`    | Start a headless child session with a prompt; returns its id at once                                                                    |
| `session_status`   | A started session's status, last reply, queue, parent and children                                                                      |
| `session_wait`     | Block until one or several started sessions stop running, wait for a human, or reply                                                    |
| `session_list`     | List the sessions this session started                                                                                                  |
| `session_stop`     | Stop a started session's turn and, by default, the sessions it started                                                                  |
| `session_search`   | Search archived and indexed session passages                                                                                            |
| `session_read`     | Read a cited archived-session passage or a page of turns                                                                                |
| `session_sync`     | Request a one-hour upload capability for local session sync                                                                             |

### Scratchpads

| Tool         | Description                                                      |
| ------------ | ---------------------------------------------------------------- |
| `pad_list`   | List scratchpads: Markdown docs, Excalidraw diagrams, HTML pages |
| `pad_get`    | Read a scratchpad's header and raw file                          |
| `pad_create` | Create a scratchpad                                              |
| `pad_update` | Update a scratchpad                                              |
| `pad_delete` | Delete a scratchpad                                              |

### Human requests

See [Human requests](./human-requests.md) and [Command requests](./command-requests.md).

| Tool                        | Description                                                |
| --------------------------- | ---------------------------------------------------------- |
| `human_request`             | Ask the user a question, an approval or a reviewed command |
| `human_request_get`         | Read a request's state and answer                          |
| `human_request_acknowledge` | Acknowledge an answer after consuming it                   |
| `command_request`           | Ask the user to run a command                              |

### Channels

| Tool                     | Description                                     |
| ------------------------ | ----------------------------------------------- |
| `channel_list`           | Configured channels, readiness and capabilities |
| `channel_targets`        | Approved destinations and aliases such as `me`  |
| `channel_send`           | Send a message through a channel                |
| `channel_message_get`    | Inspect a delivery receipt                      |
| `channel_message_update` | Edit an accepted message                        |

### Audit

| Tool         | Description                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `audit_list` | Review audit entries (knowledge, task, job, rule, settings, terminal, auth), optionally by `entity_type` or `session_id` |
