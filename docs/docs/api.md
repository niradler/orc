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
| `GET` `POST` | `/webhooks` | List / create webhooks |
| `PATCH` `DELETE` | `/webhooks/{id}` | Update / delete |
| `POST` | `/webhooks/{token}` (no `/api`) | Receive a signed delivery |
| `GET` | `/channels`, `/channels/providers` | Channels and providers |
| `POST` | `/channels/messages` | Send a message |
| `GET` | `/gateway/status` | Gateway adapters and sessions; `POST /gateway/send` sends |

### Sessions, chat and terminals

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/sessions` | Recorded agent sessions |
| `GET` | `/sessions/{id}` | Session detail with events |
| `GET` | `/sessions/live` | Coding-agent sessions seen by the file watcher |
| `PATCH` | `/sessions/live/{id}` | Link a live session to a task |
| `GET` | `/sessions/live/{id}/transcript` | Paged transcript |
| `GET` | `/sessions/live/search` | Search sessions |
| `GET` | `/sessions/archive` | Search archived session passages |
| `POST` | `/session-handoffs` | Start a session handoff |
| `GET` `POST` | `/chat/threads` | Chat threads |
| `POST` | `/chat/stream` | Stream a chat turn |
| `GET` `POST` | `/terminals` | List / start terminals |
| `GET` `PATCH` `DELETE` | `/terminals/{id}` | Read / rename / kill |
| `GET` | `/terminals/{id}/git/status` | Git status of a terminal checkout |
| `GET` | `/git/worktrees` | Checkouts of a repo |

### Human requests, rules and scratchpads

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/human-requests` | List / create |
| `GET` | `/human-requests/{id}` | Read |
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
| `GET` | `/audit` | Knowledge audit log |
| `GET` `POST` | `/integrations/connections` | spec-cli connections |
