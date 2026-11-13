# REST API

The ORC HTTP API: base URL, auth, the OpenAPI spec, the TypeScript SDK and the route groups.

## Base URL

| Item | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:7700` (`api.host` / `api.port`, or `ORC_API_HOST` / `ORC_API_PORT`) |
| Route prefix | `/api` |
| OpenAPI 3.1 spec | `GET /openapi.json` |
| Swagger UI | `GET /docs` |
| Health (no auth) | `GET /api/health` |
| MCP endpoint | `/mcp` (see [MCP](./mcp.md)) |

Errors return `{ "error": "<message>", "code": "<CODE>" }` with a matching status, for example `VALIDATION_ERROR` (400).

## Auth

When `api.secret` (or `ORC_API_SECRET`) is set, every `/api/*` route, `/openapi.json` and `/docs` require one of:

| Credential | How |
| --- | --- |
| API secret | `Authorization: Bearer <secret>` |
| Access token | `Authorization: Bearer <token>` from `POST /api/auth/token` |
| Browser session | Cookie set by `POST /api/auth/session` (web dashboard) |

With no secret, the API is open. ORC logs a security warning when it binds a non-loopback host without a secret.

Create an access token:

```bash
curl -s -X POST http://127.0.0.1:7700/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"secret":"'"$ORC_API_SECRET"'","expires_at":1767225600}'
```

`expires_at` is Unix seconds; it defaults to `api.session_days` from now and is capped at 365 days.

Unauthenticated exceptions: `GET /api/health`, the sign-in routes, `POST /webhooks/{token}` (signed deliveries), and signed short-lived capability URLs (skill downloads, scratchpad content, session uploads).

## Usage

### Desktop preview

The desktop panel uses authenticated `/api/desktop-preview/*` routes:
`GET session?session_id=…` resolves a trusted session; `GET file?session_id=…&target=…`
reads bounded workspace text/images; `PUT file` saves text using
`{session_id,target,content,original}` and returns 409 if disk content changed.
Paths are constrained to that session's working folder and execution host.

`POST clients` registers `{client_id,session_id,agent_access,browser_ready}` and returns a
private lease. Renewal, `GET clients/{id}/requests`, `POST clients/{id}/close` and
`POST requests/{id}/ack` require `X-Preview-Lease` as well as normal API auth.
`GET clients?session_id=…` lists targets (`agent_access`, `browser_ready`) without
exposing leases. `POST requests` queues `{session_id,client_id?,kind:"url"|"file",target}`;
`POST browser` queues `{session_id,client_id?,command,tab_id?}` only for an opted-in
target with an open browser page (`browser_ready`), otherwise it returns 409.
`GET requests/{id}` reports `queued`, `opened`, `completed`, `failed` or `expired`.
`POST requests/{id}/cancel` fails a still-queued request so it never runs late; the
MCP server calls it when a browser action is still queued after its 10-second wait.
Queued work expires; it is not persisted across daemon restarts.

Browser files stay inside the session workspace: `POST artifact?session_id=…&name=…`
saves a browser download (octet-stream body), `POST recording?session_id=…` saves a
WebM recording, and `GET upload?session_id=…&target=…` returns a workspace file as
base64 for a browser upload. Artifact and recording bodies are capped at 16 MB.
See [MCP preview tools](./mcp.md#desktop-preview-tools) for browser commands and
permission behavior.

`GET /api/sessions/live/{id}/cache` returns numeric prompt-cache evidence from a
stored native session transcript: `latest` (including optional recorded time and
a conservative `may_be_cold_after` hint) and `totals`. Missing or unsupported
evidence is `null`. No prompt text, credentials or transcript paths are returned.
The route uses normal API authentication and the session's stored execution host;
clients cannot supply a file path. The SDK exposes `orc.sessions.cacheUsage(id)`.

`GET /api/usage/history?days=30` returns imported session lifetime token totals,
grouped by agent and UTC session start date. `days` accepts `7`, `30` (default),
`90`, or `0` for all time. Totals include session count, recorded tokens, unknown
counts and estimated counts; these are session cohorts, not daily billed usage.

`GET /api/usage/quotas` returns local Codex and Claude quota windows with percentage
used, reset timestamps, availability and check time. Requests share a 60-second
cache. Neither route returns credentials. Both use normal API authentication.
See [Usage in Settings](./configuration.md#usage-in-settings) for account support
and history limits. The SDK exposes `orc.usage.history("30")` and
`orc.usage.quotas()`.

## Pagination

`GET /api/projects`, `GET /api/jobs` and `GET /api/skills` take `limit` and `offset` and return `next_offset`; follow it until it is `null`. Projects and jobs default to 50 per page (max 100); skills default to 30 (max 500).

## Examples

```bash
H="Authorization: Bearer $ORC_API_SECRET"

curl -s -H "$H" http://127.0.0.1:7700/api/projects/by-name/my-app
curl -s -H "$H" "http://127.0.0.1:7700/api/tasks?status=doing&limit=20"
curl -s -H "$H" -X POST "http://127.0.0.1:7700/api/jobs/<job-id>/trigger?sync=true"
curl -s -H "$H" -H "Content-Type: application/json" -X POST http://127.0.0.1:7700/api/kb/search \
  -d '{"query":"rollback procedure"}'
```

## TypeScript SDK

`@orc/sdk` (`packages/sdk`) wraps the API. It reads `ORC_API_BASE` (or the configured host and port) and `api.secret` unless you pass them.

```ts
import { createOrcClient } from "@orc/sdk";

const orc = createOrcClient({ baseUrl: "http://127.0.0.1:7700", secret: process.env.ORC_API_SECRET });
const { data, error } = await orc.tasks.list({ status: "doing" });
```

| Option | Purpose |
| --- | --- |
| `baseUrl` | API origin, without `/api` |
| `secret` | Bearer secret or access token |
| `project_id` | Active project for knowledge scope |
| `actor` | `{ name, session_id }` attribution for knowledge reads and writes |
| `source` | Call source for knowledge edit rights (`api` by default) |

Every method returns `{ data, error }`; `error` is `{ error, code }` and never throws. Types generated from the OpenAPI spec live in `packages/sdk/src/openapi.gen.ts` (regenerate with `bun run generate` in `packages/sdk`).

## Route groups

All paths below are under `/api` unless shown otherwise. `GET /openapi.json` lists every route with its schema.

### Projects, tasks and flows

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/projects` | List (`status`, `tag`, `limit`, `offset`) / create |
| `GET` `PATCH` `DELETE` | `/projects/{id}` | Read / update / delete |
| `GET` | `/projects/by-name/{name}` | Look up by name (case-insensitive) |
| `GET` | `/projects/{id}/summary` | Task, memory and job counts |
| `GET` `POST` | `/projects/{id}/comments` | Project comments |
| `GET` | `/workspaces` | Prepared workspaces (`project_id`, `path`) |
| `GET` `POST` | `/tasks` | List (`project_id`, `status`, `tag`, `limit`) / create |
| `POST` | `/tasks/batch` | Create tasks with dependency links atomically |
| `GET` `PATCH` `DELETE` | `/tasks/{id}` | Read / update / delete |
| `GET` `POST` | `/tasks/{id}/comments` | Task comments |
| `GET` `POST` | `/tasks/{id}/links` | Task links, both directions |
| `DELETE` | `/tasks/{id}/links/{linkId}` | Remove a link |
| `GET` `POST` | `/flows` | List / create flow graphs |
| `GET` | `/flows/{name}` | Read a flow |
| `POST` | `/flows/validate` | Validate without saving |
| `GET` `POST` | `/tasks/{id}/flow` | Get a task's run / attach a flow |
| `POST` | `/tasks/{id}/flow/resume` | Resolve a human node |
| `POST` | `/tasks/{id}/flow/halt` | Stop a running flow |
| `GET` | `/tags` | Unique tags across resources |
| `GET` | `/search` | Search all projects and resources |

Projects accept an optional `workspace` object with `setup_script`, `dev_script`,
`setup_timeout_secs`, `port_base`, `port_count` and `env`. `env` is the same
`{ name, value, secret }` array as job environments: secret values are encrypted
at rest, read back as `value: null`, and retained when that saved `null`
placeholder is sent again. Omitting `workspace` on update preserves it; sending
one without a stored secret's value returns 400. An invalid or missing stored
value falls back to defaults: no scripts, a 900-second setup timeout, ten ports
starting from 3100, and no variables.

`GET /workspaces` returns workspace records with `setup_status`, `setup_output`,
the allocated `port_base`/`port_count` block, `preview_url` and the owning
project. Filter by `project_id`, or pass `path` for exactly one folder. Setup runs
once per managed worktree; a project's main checkout gets a port block but no
setup.

### Memory

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/memories` | List (`project_id`, `q`, `sort`, `limit`) / create |
| `GET` `PATCH` `DELETE` | `/memories/{name}` | Read / update / delete |
| `GET` | `/memories/{name}/history` | Change history |
| `POST` | `/memories/{name}/revert` | Revert a change |
| `GET` | `/memory-limits` | Size limits |
| `GET` | `/memory-transfer/sources` | Native memory folders |
| `POST` | `/memory-transfer/import`, `/memory-transfer/export` (+ `/preview`) | Import / export native memory files |

### Knowledge bases

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/kb/bases` | List / create knowledge bases |
| `GET` `PATCH` `DELETE` | `/kb/bases/{id}` | Read / update / delete |
| `GET` `POST` | `/kb/bases/{id}/documents` | List / create Markdown documents |
| `POST` | `/kb/bases/{id}/upload` | Upload a file |
| `GET` `PATCH` `DELETE` | `/kb/documents/{id}` | Read / update / delete a document |
| `POST` | `/kb/documents/{id}/edit` | Partial edit against `expected_revision` |
| `GET` | `/kb/documents/{id}/revisions` | Revision history |
| `POST` | `/kb/search` | Search (exact, full-text, vector, fused) |
| `POST` | `/kb/evidence` | Budgeted evidence pack with citations |
| `GET` | `/kb/citations/{handle}` | Resolve `kb:<doc>@<rev>#<n>` |
| `GET` `POST` | `/kb/bases/{id}/comments` | Comments |
| `GET` `PUT` `DELETE` | `/kb/bases/{id}/digest` | Digest agent; `POST .../digest/run` starts one |
| `GET` `POST` | `/kb/bases/{id}/sources` | Synced local folders |
| `GET` `PATCH` | `/kb/settings` | Parser and embedding settings |
| `GET` | `/kb/status` | Counts, jobs, embeddings, parsers |

### Skills, agents and packages

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/skills` | List (`q`, `project_id`, `source`, `limit`, `offset`, `include_hidden`) / create |
| `GET` `DELETE` | `/skills/{name}` | Read / delete |
| `PUT` | `/skills/{name}/instructions` | Audited instruction edit |
| `PUT` | `/skills/{name}/file` | Edit or add a supporting file |
| `GET` | `/skills/{name}/history` | Instruction history; `POST .../revert` reverts |
| `GET` `PUT` | `/skills/{name}/projects` | Project assignments |
| `POST` | `/skills/{name}/download` | Mint a ten-minute signed file download |
| `POST` | `/skills/discover`, `/skills/import` | Discover / import GitHub skills |
| `POST` | `/skills/{name}/sync` | Sync an imported skill |
| `GET` | `/skills/local-agents` | Skills in local agent folders; `POST .../import` copies them in |
| `POST` | `/skills/export` (+ `/preview`) | Export as native skill folders |
| `GET` `PUT` | `/skills/settings/visibility` | Discovery visibility |
| `GET` `POST` | `/agents` | List / create agent profiles |
| `GET` `PUT` `DELETE` | `/agents/{id}` | Read / update / delete |
| `GET` `POST` | `/agent-packages` | List / import packages |
| `GET` `PUT` `DELETE` | `/agent-packages/{name}` | Read / update / delete |
| `POST` | `/agent-packages/{name}/export` | Export a package |

### Jobs, webhooks and channels

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/jobs` | List (`enabled`, `project_id`, `limit`, `offset`) / create |
| `GET` `PATCH` `DELETE` | `/jobs/{id}` | Read / update / delete |
| `POST` | `/jobs/{id}/trigger` | Run now; `?sync=true` waits and returns output |
| `GET` | `/jobs/{id}/runs` | Run history |
| `GET` | `/jobs/{id}/runs/{runId}/logs` | Run logs |
| `GET` | `/jobs/{id}/runs/{runId}/session` | Resolve this run's native conversation; returns `{ session_id }` for Sessions, or `null` if unavailable |
| `GET` `POST` | `/webhooks` | List / create webhooks |
| `PATCH` `DELETE` | `/webhooks/{id}` | Update / delete |
| `POST` | `/webhooks/{token}` (no `/api`) | Receive a signed delivery |
| `GET` | `/channels`, `/channels/providers` | Channels and providers |
| `POST` | `/channels/messages` | Send a message |
| `GET` `PUT` | `/channels/notification-policy` | Read/save global forwarding opt-in and ORC link origin |
| `POST` | `/channels/notification-preview` | Test draft type/category/severity/outcome/project filters without sending |
| `GET` | `/channels/notification-deliveries` | Recent delivery status and safe errors; `limit` 1–100 |
| `GET` | `/gateway/status` | Gateway adapters and sessions; `POST /gateway/send` sends |

Jobs accept optional `settings` and `environment` in create/update requests.
`settings` is replaced as a whole when supplied: `host` is an SSH alias, `null`
pins the local host, and omission follows the selected execution host; `timezone`
is an IANA timezone for cron. `shell` is `{ executable, args }`, with the script
appended as the final argument. `workspace` is
`{ mode: "directory" | "worktree", base_ref, cleanup_on_success }` for agent jobs.
Legacy jobs without settings retain their previous shell and directory behavior.
`inherit_project_directory: false` preserves a command job’s host working directory
when adding settings to a legacy job; new jobs otherwise inherit their project path.
The Jobs response includes `working_dir`, `settings`, `schedule_timezone` and a
timezone-aware `next_run_at` for enabled cron jobs.

`environment` is an array of `{ name, value, secret }`. Secret values are encrypted
at rest and read back as `value: null`; submitting that saved name with `secret: true`
and `value: null` retains its value. Omitting the array preserves all entries;
supplying an array replaces it, and an empty array clears it. Names are unique
(case-insensitive), `ORC_` names are reserved, and values are single-line. Exact
secret values are redacted from job logs and saved agent summaries. Legacy `env_vars`
inputs remain supported as nonsecret values; reads expose them through `environment`.
Do not supply both forms in one write. Agent `action.options` accepts the shared
validated launch-options contract for its backend; automatic approval requires
`action.auto_approve: true`.

Job runs expose `session_id` for the audit record and `native_session_id` for the
provider identity. The run-session resolver checks run ownership and discovers only
that native conversation on its recorded execution host. It does not switch the
global execution host. Existing authentication protects both endpoints.

`GET /chat/models` also accepts optional `host` and `cwd` for a job destination.
Omit `host` to follow the selected host, use `__local__` to pin local, or supply an
SSH alias. An existing `threadId` owns its host/directory and rejects these overrides.

### Sessions, chat and terminals

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/sessions` | Recorded agent sessions |
| `GET` | `/sessions/{id}` | Session detail with events |
| `GET` | `/sessions/live` | Coding-agent sessions seen by the file watcher |
| `PATCH` | `/sessions/live/{id}` | Link a live session to a task |
| `GET` | `/sessions/live/{id}/transcript` | Paged transcript |
| `GET` `POST` | `/sessions/live/{id}/messages` | Read or queue a message for a live session |
| `POST` | `/session-messages` | Queue a message from an agent session (`X-ORC-Session`) |
| `POST` | `/session-messages/{id}/cancel` | Cancel a queued message |
| `POST` | `/session-messages/{id}/move` | Reorder a queued message |
| `GET` | `/sessions/live/search` | Search sessions |
| `GET` | `/sessions/archive` | Search archived session passages |
| `POST` | `/session-handoffs` | Start a session handoff |
| `GET` `POST` | `/chat/threads` | Chat threads |
| `GET` | `/chat/threads/by-message/{id}` | Find the thread holding a user message id (send recovery) |
| `POST` | `/chat/stream` | Stream a chat turn |
| `GET` `POST` | `/terminals` | List / start terminals |
| `GET` `PATCH` `DELETE` | `/terminals/{id}` | Read / rename / kill |
| `GET` | `/terminals/{id}/git/status` | Git status of a terminal checkout |
| `GET` | `/git/worktrees` | Checkouts of a repo |

Chat streams include `turn` events with `startedAt` (Unix milliseconds), followed
at completion by `finishedAt`, `durationMs` and `outcome` (`completed`, `stopped`,
or `failed`). The same optional `turn` object is persisted on assistant messages.
`durationMs` prefers the backend's reported duration and otherwise uses server
elapsed time. Replay includes the original start; legacy messages may omit `turn`.
Before a tool call, a `narration` event moves accumulated prose out of the current
reply and into its folded activity. Its `text` preserves that prose for expansion.

A turn opens with a `thread` event carrying the conversation metadata and only
that turn's user message; the full transcript is read from `GET /chat/threads/{id}`.
`POST /chat/stream` accepts an optional `clientMessageId` (UUID) and stores it as
the user message id, rejecting a repeat with `409`. If a first send's response is
lost, poll `GET /chat/threads/by-message/{clientMessageId}` — `404` until the
server stores the message, then the full thread — and attach to
`/chat/threads/{id}/live` instead of sending the message again.

First sends reserve `clientMessageId` before agent and workspace preparation.
Repeating that ID without a thread returns `409` with code `CHAT_MESSAGE_EXISTS`,
including while preparation is pending. Recover the original thread by message ID;
retrying the same queued message does not start another turn. The web client bounds
recovery requests and backoff to 15 seconds, or 60 seconds after a server error,
header timeout or `CHAT_MESSAGE_EXISTS`, then pauses the message in its queue.

`POST /terminals` accepts `project_id` to use that project's workspace environment
and ports, and `dev: true` to run its dev script in a shell terminal. A dev
terminal rejects an agent `kind` or `providerId`, and fails when the project has no
dev script. Terminal responses include `project_id`, `worktree_path`, `dev` and
`preview_url`. For a dev terminal, the first printed `http(s)` URL becomes
`preview_url` and stays until that terminal exits.

### Human requests, rules and scratchpads

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/human-requests` | List / create |
| `GET` | `/human-requests/{id}` | Agent read; marks an answered response seen |
| `GET` | `/human-requests/{id}/view` | Human review without delivery/read side effects |
| `POST` | `/human-requests/{id}/respond`, `/acknowledge`, `/cancel` | Answer and close |
| `GET` | `/rules` | Active policy |
| `GET` | `/rules/catalog` | Rule templates |
| `POST` | `/rules/check`, `/rules/activate`, `/rules/revert` | Validate / activate / revert |
| `GET` `POST` | `/scratchpads` | List / create |
| `GET` `PATCH` `DELETE` | `/scratchpads/{id}` | Read / update / delete |

### System

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health, version, uptime (no auth) |
| `POST` | `/auth/token` | Create an access token |
| `GET` `POST` `DELETE` | `/auth/session` | Web UI sign-in |
| `GET` `PATCH` | `/settings` | Workspace preferences |
| `GET` `PATCH` | `/settings/mcp` | MCP defaults and prompts |
| `GET` | `/backends` | Agent backends and whether each can run |
| `GET` | `/events` | Resource-change event stream |
| `GET` `PUT` | `/ssh` | SSH execution host |
| `GET` | `/system/about` | Server version, platform, runtime, data folder, start time |
| `POST` | `/system/restart` | Restart ORC |
| `POST` | `/mcp/tool` | Run any MCP tool: `{ "name", "args" }` |
| `GET` | `/audit` | Central lifecycle and knowledge audit log |
| `GET` `POST` | `/integrations/connections` | spec-cli connections |


### Notifications and audit

All paths below use the `/api` prefix and the normal API authentication.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/notifications` | Current history, shared unread count and `has_more`; optional `project_id` (or `unassigned`) scopes both |
| `PATCH` | `/notifications/{id}` | Shared `{read?: boolean, dismissed?: boolean}` |
| `POST` | `/notifications/read` | Mark current notifications read; optional `project_id` (or `unassigned`) scopes it |

Listing accepts `limit` (1–100, default50), `offset` (default0) and
`unread=true|false` (defaultfalse). Each notification includes a generic `type`,
`source_id`, `title`, `body`, `level` (`needs-you` or `done`), nullable `project_id`,
internal `path`, `requires_action`, and millisecond timestamps `created_at`,
`expires_at`, `read_at`, `dismissed_at` (the last two nullable).
Expiry and dismissal do not mutate the source request. SDK methods are
`client.notifications.list`, `.update` and `.markAllRead`.

`GET /audit` accepts `entity_type` (`notification`, `human_request`, `job_run`,
`task`, `settings`, `job`, `rule`, `terminal`, `auth`, `memory`, `skill`, `kb`), `session_id`, `since` (Unix seconds),
`limit` (1–100, default50), and `project_id` or `scope=global|all`.
`scope=all` includes project and global entries. `snapshot=preview` substitutes
a bounded marker for snapshots larger than4096 bytes; default `full` preserves
the original snapshot. The Audit UI uses previews and displays the latest100
matching events. Audit timestamps use Unix seconds. Both notification and audit
reads enforce their configured retention periods; see [Notifications](./notifications.md).

### Agent capabilities and steering

`GET /backends` includes a versioned `capabilities` object for each integration.
`GET /chat/capabilities?agent=<id>&threadId=<optional-thread-uuid>` returns
`{ backend, capabilities }` without starting a provider. Capability flags describe
resume, model selection, image input, tool output, approvals, questions, live
permissions, native interruption, steering, MCP, fork and rollback. `source` is
`adapter`, `negotiated` or `unknown`; unsupported and unknown operations are false.
Chat SSE emits `capabilities` events and persists negotiated values with the thread.

`POST /chat/runs/{id}/steer` takes `{ "requestId": "<uuid>", "input": "Focus on the failing test" }` and
returns the updated conversation after the active native turn accepts it. It
requires a live steering-capable session; stale and unsupported runs return `409`.
It keeps the original native thread and turn. Empty input is invalid. These routes
use the same authentication as the rest of the API. The SDK exposes
`client.chat.capabilities(agent, threadId?)` and `client.chat.steer(runId, input, requestId?)`.
Reuse the same request ID and input when retrying. A duplicate ID with different
content returns `409`; a live run accepts at most 32 distinct steering requests.
The intent is saved before native delivery. An initial save failure sends nothing.
Unconfirmed delivery is retained in history and cannot be resent with the same ID;
a delivery-status save failure reports a warning while keeping the saved intent.
