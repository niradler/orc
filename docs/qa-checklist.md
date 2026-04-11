# ORC QA Checklist

> **Version tested:** 0.1.14
> **Last run:** 2026-04-12
> **Method:** Manual testing — start API on isolated port, run CLI against it with `--port --secret --db`
> **Test DB:** ephemeral (`/tmp/orc-qa-test.db`), token: `orc-dev`

---

## How to Run

```bash
# 1. Start isolated API
ORC_API_PORT=9742 ORC_API_SECRET=orc-dev ORC_DB_PATH=/tmp/orc-qa-test.db bun run packages/api/src/index.ts &

# 2. CLI alias (all commands below use this)
ORC="bun run packages/cli/src/index.ts --port 9742 --secret orc-dev --db /tmp/orc-qa-test.db"

# 3. Verify
curl -s -H "Authorization: Bearer orc-dev" http://localhost:9742/health
```

---

## Legend

- [x] = PASS
- [ ] = FAIL (see notes)
- [~] = PARTIAL (works with caveats)

---

## 1. Server & Infrastructure

### 1.1 Health & Status
- [x] `GET /health` returns `{"status":"ok","version":"...","uptime":N}`
- [x] `orc status` shows API status, task counts, job counts, memory counts
- [x] `orc home` shows ORC home dir, DB path, config, daemon state
- [x] `orc --version` returns correct version

### 1.2 Authentication
- [x] Request without token returns `401 Unauthorized`
- [x] Request with wrong token returns `401 Unauthorized`
- [x] Request with correct token succeeds
- [ ] `GET /docs` (Swagger UI) requires auth — should be public for dev convenience

### 1.3 OpenAPI Spec
- [x] `GET /openapi.json` returns valid OpenAPI 3.1.0 spec
- [x] Spec includes all route paths

### 1.4 Build Health
- [ ] `bun typecheck` — FAILS: 19 TS errors in `packages/api/src/__tests__/tasks.test.ts` (`'body' is of type 'unknown'`)
- [ ] `bun check` (biome lint) — FAILS: 3 errors, 25 warnings
- [~] `bun test` — 354 pass, **1 fail** (`shell chrome renders tab bar and API status` snapshot mismatch)

---

## 2. Project Management

### 2.1 Project CRUD
- [x] `orc project add <name> -d "desc" --tags "a,b"` creates project
- [x] `orc project list` shows projects with status, task/mem/job counts
- [x] `orc project show <name>` shows project details
- [x] `orc project update <name> -d "..." --status active` updates fields
- [x] `orc project archive <name>` sets status to archived
- [x] `orc project delete <name>` deletes project
- [x] `orc project list -t <tag>` filters by tag
- [x] `orc project list --status <s>` filters by status

### 2.2 Active Project
- [x] `orc project use <name>` sets active project
- [x] `orc project use <name> --clear` clears active project
- [x] Active project scopes task/mem/job commands automatically

### 2.3 Project API
- [x] `GET /projects` lists projects
- [x] `GET /projects/{id}` returns project by ID
- [x] `POST /projects` creates project
- [x] `PATCH /projects/{id}` updates project
- [x] `DELETE /projects/{id}` deletes project
- [x] `GET /projects/by-name/{name}` finds project by name (case-insensitive)
- [x] `GET /projects/{id}/summary` returns task/memory/job counts
- [x] `POST /projects/{id}/comments` adds comment to project
- [x] `GET /projects/{id}/comments` lists project comments

---

## 3. Task Management

### 3.1 Task CRUD
- [x] `orc task add <title> -p <project> --priority high -b "body"` creates task
- [x] `orc task add <title> --no-project` creates unscoped task
- [x] `orc task show <id>` shows full task details (short ID suffix works)
- [x] `orc task update <id> --title/--body/--status/--priority/--progress/--tags` updates fields
- [x] `orc task delete <id>` deletes task
- [x] `orc task list` lists tasks grouped by status
- [x] `orc task list --flat` lists tasks ungrouped
- [x] `orc task list -p <project>` filters by project
- [x] `orc task list -s <status>` filters by status
- [x] `orc task list -t <tag>` filters by tag
- [x] `orc task list --no-project` shows all tasks across projects

### 3.2 Task Status Flow (HITL)
- [x] `todo → doing` via `task update --status doing`
- [x] `doing → review` via `task review <id>`
- [x] `review → changes_requested` via `task reject <id> -r "reason"`
- [x] `changes_requested → doing` via `task update --status doing`
- [x] `doing → review → done` via `task review` then `task approve`
- [x] `task approve -c "comment"` adds approval comment
- [x] Invalid transitions are blocked (e.g. `todo → done` returns error)

### 3.3 Batch Create
- [x] `POST /tasks/batch` with `ref` + `depends_on` creates tasks with links
- [x] Returns mapping of ref → ID

### 3.4 Task Links
- [x] `POST /tasks/{id}/links` creates a link (`blocks` type)
- [x] `GET /tasks/{id}/links` lists links (both directions)
- [x] `DELETE /tasks/{id}/links/{linkId}` removes a link
- [x] Batch-created dependencies appear as links

### 3.5 Task Comments
- [x] `POST /tasks/{id}/comments` with `{"content":"...","author":"..."}` creates comment
- [x] `GET /tasks/{id}/comments` lists comments

### 3.6 Task API
- [x] `GET /tasks` with query params (status, project_id, tag, limit)
- [x] `GET /tasks/{id}` returns task by ID
- [x] `POST /tasks` creates task
- [x] `PATCH /tasks/{id}` updates task
- [x] `DELETE /tasks/{id}` deletes task
- [ ] **No pagination** — `offset` param is silently ignored (no cursor/page support)

---

## 4. Memory Management

### 4.1 Memory CRUD (CLI)
- [x] `orc mem add <content> --type rule --importance high -p <project> -t "tags"` stores memory
- [x] `orc mem add --type decision/event/fact/discovery` all types accepted
- [x] `orc mem list` lists memories with short IDs and age
- [x] `orc mem list -p <project>` filters by project
- [x] `orc mem list --no-project` shows all memories
- [x] `orc mem search <query>` finds matching memories (BM25)
- [ ] **BUG: `orc mem show <id>`** — fails with ZodError (uses `limit: 200` internally, API max is 100)
- [ ] **BUG: `orc mem edit <id>`** — fails with ZodError (same root cause)
- [ ] **BUG: `orc mem delete <id>`** — fails with ZodError (same root cause)
- [ ] `orc mem search ""` (empty query) returns ZodError instead of helpful message

### 4.2 Memory API
- [x] `POST /memories` creates memory
- [x] `GET /memories` lists memories with filtering (scope, type, project_id, limit)
- [x] `GET /memories/search?q=<query>` searches via BM25
- [x] `PATCH /memories/{id}` updates memory fields
- [x] `DELETE /memories/{id}` deletes memory (returns empty 200)
- [ ] **No pagination** — no offset/cursor support

---

## 5. Job Management

### 5.1 Job CRUD
- [x] `orc job add <name> -c "command" --trigger manual -p <project>` creates job
- [x] `orc job add <name> -c "command" --trigger cron --cron "*/30 * * * * *"` creates cron job
- [x] `orc job list` shows jobs with trigger type and run count
- [x] `orc job show <name>` shows full job details
- [x] `orc job update <name> -d "..." --timeout 60` updates job
- [x] `orc job update <name> --disabled` disables job
- [x] `orc job update <name> --enabled` enables job
- [x] `orc job delete <name>` deletes job

### 5.2 Job Execution
- [x] `orc job run <name>` triggers job, returns run ID
- [x] `orc job runs <name>` lists runs with status and duration
- [x] `orc job runs <name> --logs` shows stdout/stderr per run
- [x] `orc job runs <name> --sessions` shows linked agent sessions per run
- [x] Job stdout captured and stored as log lines

### 5.3 Job API
- [x] `GET /jobs` lists jobs
- [x] `GET /jobs/{id}` returns job details
- [x] `POST /jobs` creates job
- [x] `PATCH /jobs/{id}` updates job
- [x] `DELETE /jobs/{id}` deletes job
- [x] `POST /jobs/{id}/trigger` triggers job
- [x] `GET /jobs/{id}/runs` lists runs
- [x] `GET /jobs/{id}/runs/{runId}/logs` returns log lines

---

## 6. Skills

### 6.1 Skill Discovery
- [x] `orc skill list` shows all built-in skills (12 skills)
- [x] `orc skill list -q "orc"` searches by keyword
- [x] `orc skill list --source builtin` filters by source
- [x] `orc skill list --reload` forces cache rebuild
- [x] `orc skill read <name>` shows full skill content + metadata

### 6.2 User Skills
- [ ] **BUG: `orc skill create <name> -c "content"`** — CLI returns "Internal server error" but file IS created on disk at `~/.orc/skills/<name>/SKILL.md`
- [ ] **BUG: User skills not discoverable** — after creation, `skill list --source user` returns "No skills found" and `skill read <user-skill>` returns "not found", even though files exist on disk
- [x] `POST /skills` API creates skill file on disk (returns CONFLICT on duplicate)

### 6.3 Skill API
- [x] `GET /skills` lists skills with optional search/source filter
- [x] `GET /skills/{name}` reads skill content
- [x] `POST /skills` creates user skill

---

## 7. Sessions

### 7.1 Session CLI
- [x] `orc session list` shows recent sessions (ID, agent, when, summary)
- [x] `orc session list -a <agent>` filters by agent name
- [x] `orc session show <id>` shows session detail
- [x] `orc session show <id> -e` shows session events
- [x] `orc session log <summary> -a <agent> --agent-version <v>` logs a session

### 7.2 Session API
- [x] `GET /sessions` lists sessions with agent/job_run filtering
- [x] `GET /sessions/{id}` returns session detail with events

---

## 8. MCP Tool Proxy (`POST /mcp/tool`)

### 8.1 Context & Search
- [x] `context` — returns active tasks + key memories + last session
- [x] `memory_search` with `args.query` — finds matching memories
- [x] `search` (unified) with `args.query` — searches across tasks and memories
- [x] `project_list` — returns all projects

### 8.2 Memory Tools
- [x] `memory_store` — creates memory
- [x] `memory_get` — fetches memory by ID(s)
- [x] `memory_update` — updates memory fields

### 8.3 Task Tools
- [x] `task_create` — creates task
- [x] `task_list` — lists tasks
- [x] `task_get` — fetches task by ID(s)
- [x] `task_update` — updates task with status + comment
- [x] `task_batch_create` — creates tasks with dependencies

### 8.4 Job Tools
- [x] `job_list` — lists jobs
- [x] `job_run` — triggers job by name
- [x] `job_status` — returns run status/exit code

### 8.5 Skill Tools
- [x] `skill_list` — lists skills
- [x] `skill_read` — reads full skill content

### 8.6 Session Tools
- [x] `session_event` — records event
- [x] `session_snapshot` — builds XML snapshot
- [x] `session_restore` — restores session context
- [x] `session_log` — logs session summary

---

## 9. Knowledge

### 9.1 Knowledge API
- [x] `GET /knowledge/status` — returns collections, doc count, dbPath, searchMode
- [x] `GET /knowledge/collections` — lists collections
- [x] `POST /knowledge/collections` with `{"name":"...","path":"..."}` — adds and indexes collection
- [x] `DELETE /knowledge/collections/{name}` — removes collection
- [x] `GET /knowledge/search?q=<query>` — searches documents (BM25)
- [x] `GET /knowledge/documents/{id}` — returns full document by docid
- [ ] **BUG: `POST /knowledge/update`** (re-index) returns 500 Internal Server Error

---

## 10. Tags

- [ ] **BUG: `GET /tags`** returns 500 Internal Server Error — references non-existent `prompts` table in `RESOURCE_TABLES` map

---

## 11. Gateway

- [x] `GET /gateway/status` — returns `{"running":false,"status":"Gateway not running."}`
- [x] `orc gateway status` — shows "Gateway not running"
- [x] `orc gateway send --platform telegram --chat 12345 --text "test"` — returns appropriate error "Gateway is not running"
- [ ] **Not tested:** Live Telegram/Slack integration (requires external setup)

---

## 12. Daemon

- [x] `orc daemon status` — shows "No scheduled jobs" when none defined
- [ ] **Not tested:** `orc daemon start` / `orc daemon stop` (would conflict with running server)

---

## 13. Schema

- [x] `orc schema --list` lists all available schemas (35 schemas)
- [x] `orc schema task` outputs Task schema JSON

---

## 14. CLI Global Options

### 14.1 Global Flags
- [x] `--port <n>` overrides API port
- [x] `--secret <secret>` overrides API secret
- [x] `--db <path>` overrides DB path
- [x] `--json` enables machine-readable JSON output
- [x] `--version` shows version

### 14.2 JSON Output Mode
- [x] `--json task list` returns JSON
- [x] `--json project list` returns JSON
- [x] `--json job list` returns JSON
- [x] `--json mem list` returns JSON

### 14.3 Dry Run Mode
- [ ] **BUG: `--dry-run task add`** — does NOT prevent mutation, creates real task
- [ ] **BUG: `--dry-run mem add`** — does NOT prevent mutation, creates real memory

---

## 15. Error Handling

- [x] Nonexistent task ID returns "Task not found" (not a crash)
- [x] Nonexistent job name returns "Job not found"
- [x] Nonexistent skill returns "Skill not found"
- [x] Invalid status transitions return clear error messages
- [ ] Empty memory search query returns raw ZodError instead of user-friendly message

---

## Bug Summary

| # | Severity | Area | Description |
|---|----------|------|-------------|
| 1 | **HIGH** | CLI/Memory | `mem show`, `mem edit`, `mem delete` all fail with ZodError — use `limit: 200` but API max is 100 |
| 2 | **HIGH** | CLI | `--dry-run` flag does not prevent mutations for `task add` and `mem add` |
| 3 | **HIGH** | Skills | User-created skills not discoverable via `skill list --source user` or `skill read` despite files existing on disk |
| 4 | **HIGH** | Skills | `skill create` CLI returns "Internal server error" despite successfully creating files |
| 5 | **MEDIUM** | Tags API | `GET /tags` returns 500 — references non-existent `prompts` table |
| 6 | **MEDIUM** | Knowledge | `POST /knowledge/update` (re-index) returns 500 Internal Server Error |
| 7 | **LOW** | API | No pagination support (offset/cursor) on `GET /tasks`, `GET /memories` — silently ignores offset param |
| 8 | **LOW** | Build | `bun typecheck` fails: 19 TS errors in `tasks.test.ts` |
| 9 | **LOW** | Build | `bun check` (biome) has 3 errors, 25 warnings |
| 10 | **LOW** | Tests | 1 snapshot test failure: `shell chrome renders tab bar and API status` |
| 11 | **LOW** | UX | Swagger UI (`/docs`) requires auth token — inconvenient for dev |
| 12 | **LOW** | UX | Empty `mem search ""` returns raw ZodError instead of helpful message |

---

## Feature Coverage Summary

| Feature Area | Tests | Pass | Fail | Coverage |
|---|---|---|---|---|
| Health/Status | 4 | 4 | 0 | 100% |
| Auth | 3 | 3 | 0 | 100% |
| Projects | 16 | 16 | 0 | 100% |
| Tasks | 22 | 21 | 1 | 95% |
| Memories | 14 | 10 | 4 | 71% |
| Jobs | 14 | 14 | 0 | 100% |
| Skills | 9 | 5 | 4 | 56% |
| Sessions | 7 | 7 | 0 | 100% |
| MCP Tools | 20 | 20 | 0 | 100% |
| Knowledge | 7 | 6 | 1 | 86% |
| Tags | 1 | 0 | 1 | 0% |
| Gateway | 3 | 3 | 0 | 100% |
| Daemon | 1 | 1 | 0 | 100% |
| Schema | 2 | 2 | 0 | 100% |
| Global Options | 8 | 6 | 2 | 75% |
| Error Handling | 5 | 4 | 1 | 80% |
| **TOTAL** | **136** | **122** | **14** | **90%** |

---

## Not Tested (Requires External Setup)

- [ ] Telegram gateway integration (requires `ORC_TELEGRAM_TOKEN`)
- [ ] Slack gateway integration (requires Slack config)
- [ ] Agent loop / task loop (requires `claude`/`acpx` on PATH)
- [ ] A2A protocol (requires remote agent URL)
- [ ] Daemon start/stop lifecycle
- [ ] TUI (terminal UI) — interactive, requires manual testing
- [ ] MCP server via stdio (`orc mcp`)
- [ ] Cron job actual scheduling (tested create/update only)
- [ ] Watch trigger (file watching)
- [ ] Webhook trigger
- [ ] Multi-backend agent routing
- [ ] Session resume logic
- [ ] Concurrent worker limits
