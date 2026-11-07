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

| Transport | Endpoint | Use when |
| --- | --- | --- |
| HTTP (streamable, stateless) | `http://127.0.0.1:7700/mcp` | The agent can reach the ORC API; remote or Docker installs |
| stdio | `orc mcp` | The agent runs on the same machine as ORC |

The stdio server reads the local ORC database and calls the API for work only the daemon does (job runs, scheduling), so the daemon must be running. It finds the API through `ORC_API_BASE`, falling back to `api.host` / `api.port` from config.

## Auth

The HTTP endpoint uses the same bearer auth as the [REST API](./api.md). When `api.secret` (or `ORC_API_SECRET`) is set, send:

```http
Authorization: Bearer <secret-or-access-token>
```

With no secret configured, requests are accepted unauthenticated. To avoid handing out the secret, mint an expiring access token with `POST /api/auth/token` (see [REST API](./api.md#auth)).

## Query parameters

| Parameter | Example | Effect |
| --- | --- | --- |
| `mode` | `/mcp?mode=full` | `meta` or `full`; overrides `mcp.default_mode` |
| `project` | `/mcp?project=my-app` | Scope the connection to one project |
| `projects` | `/mcp?projects=my-app,api` | Scope to several projects (max 50) |

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

| Mode | `tools/list` returns | Default |
| --- | --- | --- |
| `meta` | Three discovery tools | Yes (`mcp.default_mode`) |
| `full` | Every ORC tool with its schema | |

Meta mode keeps the agent's context small. The agent discovers tools on demand:

| Meta tool | Input | Returns |
| --- | --- | --- |
| `tool_search` | `query?`, `limit` (1-50, default 10) | Matching tool names with a one-line summary. No query: every tool grouped by toolset |
| `tool_describe` | `name` | Full description and JSON input schema |
| `tool_invoke` | `name`, `arguments?` | Runs the tool; arguments are validated against its schema |

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

| Tool | Description |
| --- | --- |
| `context` | Compact context index: active tasks and the project's memories by priority |
| `search` | Search knowledge base documents first, then memories and tasks |
| `project_list` | List all projects |

### Memory

| Tool | Description |
| --- | --- |
| `memory_list` | List the project's memories (name, description, priority, reads) |
| `memory_read` | Read a memory by name |
| `memory_create` | Save a short project fact worth knowing next session |
| `memory_update` | Update a memory's description, content or priority |
| `memory_delete` | Delete a memory that is wrong or no longer useful |
| `memory_history` | Changes to a memory, newest first, with before/after state |
| `memory_revert` | Restore the state from before a change |

### Tasks

| Tool | Description |
| --- | --- |
| `task_list` | List active tasks as a compact index |
| `task_get` | Fetch task details by IDs: status, progress, git links, body, latest comments |
| `task_create` | Create a task |
| `task_update` | Update status, fields or git links, or add a comment |
| `task_batch_create` | Create several tasks with dependency links atomically |
| `task_link` | List, add or remove links between tasks (`blocks`, `blocked_by`, `relates_to`, `duplicates`, `clones`, `subtask_of`, `parent_of`) |

### Flows

See [Task flows](./task-flows.md).

| Tool | Description |
| --- | --- |
| `flow_list` | List flow graphs (built-in and user) |
| `flow_read` | Read a flow definition: nodes, edges, limits, entry point |
| `flow_create` | Create a reusable user flow from JSON |
| `flow_attach` | Attach a named flow or an inline graph to a task |
| `flow_status` | Active nodes, outcome ledger, visit counts and halt reason of a task's run |
| `flow_report` | Report your outcome as a flow node |

### Knowledge bases

| Tool | Description |
| --- | --- |
| `kb_list` | Knowledge bases visible from the project, with document counts and edit rights |
| `kb_search` | Search documents (exact title/path, full-text and vectors, fused) |
| `kb_evidence` | Budgeted evidence pack of cited passages for a question |
| `kb_read` | Read a document (whole, one section, a line range) or a passage by citation handle |
| `kb_documents` | List documents in a knowledge base |
| `kb_write` | Create a Markdown document or fully replace one |
| `kb_document` | Change one document |
| `kb_manage` | Create, update or delete a knowledge base |
| `kb_comment` | Comments on a KB or document: requests, corrections, sources to digest |
| `kb_digest` | Manage the digest agent that keeps a KB current |
| `kb_maintenance` | Upkeep queue: stale derived documents, failed files, broken links |
| `digest_complete` | Finish an assigned digest run |

### Skills

See [Skills](./skills.md).

| Tool | Description |
| --- | --- |
| `skill_list` | List installed skills (built-in and user) |
| `skill_read` | Read a skill by name, a supporting file with `ref`, or a signed download with `download: true` |
| `skill_create` | Create a user skill folder with `SKILL.md` and optional supporting files |
| `skill_update` | Update effective `SKILL.md` instructions |
| `skill_file_write` | Edit or add a supporting text file of a user skill |
| `skill_history` | Instruction change history |
| `skill_revert` | Revert a skill change |

### Agents and packages

See [Reusable agent packages](./agent-packages.md).

| Tool | Description |
| --- | --- |
| `agent_list` | Discover shared APM `.agent.md` profiles |
| `agent_read` | Read a profile: original YAML/Markdown, role, model, tools, handoffs |
| `agent_create` | Create a shared, validated `.agent.md` definition |
| `agent_update` | Replace an agent definition |
| `agent_delete` | Delete an agent definition |
| `agent_package_list` | List shared OpenAPM and Agent Plugins packages |
| `agent_package_read` | Read a package manifest and file inventory, or one file with `ref` |
| `agent_package_import` | Import an intact package |
| `agent_package_update` | Replace a package's manifest and file set |
| `agent_package_delete` | Remove a package from the shared catalog |

### Jobs

| Tool | Description |
| --- | --- |
| `job_list` | List jobs with enabled state, trigger, run count and ID |
| `job_run` | Trigger a job by name |
| `job_status` | Run status, exit code and error; `logs: true` adds output |

### Sessions

See [Session handoff](./session-handoff.md) and [Live sessions](./live-sessions.md).

| Tool | Description |
| --- | --- |
| `session_event` | Record a session event (file edit, decision, error, git op) |
| `session_snapshot` | Build a ≤2KB XML snapshot of current session state |
| `session_restore` | Restore session state after compaction or restart |
| `session_log` | Log a session summary after a unit of work |
| `session_handoff` | Move a Claude Code or Codex session to ORC |
| `session_search` | Search archived and indexed session passages |
| `session_read` | Read a cited archived-session passage or a page of turns |
| `session_sync` | Request a one-hour upload capability for local session sync |

### Scratchpads

| Tool | Description |
| --- | --- |
| `pad_list` | List scratchpads: Markdown docs, Excalidraw diagrams, HTML pages |
| `pad_get` | Read a scratchpad's header and raw file |
| `pad_create` | Create a scratchpad |
| `pad_update` | Update a scratchpad |
| `pad_delete` | Delete a scratchpad |

### Human requests

See [Human requests](./human-requests.md) and [Command requests](./command-requests.md).

| Tool | Description |
| --- | --- |
| `human_request` | Ask the user a question, an approval or a reviewed command |
| `human_request_get` | Read a request's state and answer |
| `human_request_acknowledge` | Acknowledge an answer after consuming it |
| `command_request` | Ask the user to run a command |

### Channels

| Tool | Description |
| --- | --- |
| `channel_list` | Configured channels, readiness and capabilities |
| `channel_targets` | Approved destinations and aliases such as `me` |
| `channel_send` | Send a message through a channel |
| `channel_message_get` | Inspect a delivery receipt |
| `channel_message_update` | Edit an accepted message |

### Audit

| Tool | Description |
| --- | --- |
| `audit_list` | Review knowledge audit entries, optionally by `session_id` |
