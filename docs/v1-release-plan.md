# ORC Release Plan — v0.0.1

Target version: `v0.0.1` (unstable, local-only, not production-ready)

> A local-first task, memory, and job hub for AI agents, with a typed API, CLI, and MCP server.

---

## What Exists Today

### Implemented and working

- SQLite-backed core data model: tasks, task notes, memories, jobs, runs, sessions, bridge chats/messages/permissions, webhooks, prompts.
- Config loader and shared core utilities.
- REST API:
  - `GET /health`
  - `GET|POST|PATCH|DELETE /projects` — create and manage projects; tasks link via `project_id`
  - `GET|POST|PATCH|DELETE /tasks` + `GET|POST /tasks/:id/notes` + `POST|GET /tasks/:id/review`
  - `GET|POST|DELETE /memories` + `GET /memories/search`
  - `GET|POST /jobs` + `GET /jobs/:id` + `GET /jobs/:id/runs` + `POST /jobs/:id/trigger` (now actually executes)
  - `GET|POST|PATCH|DELETE /prompts` + `POST /prompts/:id/render` (variable interpolation, version tracking)
- SDK client covering all of the above.
- CLI commands:
  - `orc api`, `orc mcp`, `orc status`
  - `orc task list|add|done|review|approve|reject` — `approve`/`reject` complete the HITL loop from terminal
  - `orc mem list|add|search`
  - `orc job list|add|run|runs`
- MCP server with memory, task, job, context, and session tools.
- Job executor: `Bun.spawn()`, stdout/stderr streamed line-by-line into `job_run_logs`, exit code and capped buffers persisted.
- Cron, repeat, and file-watch scheduler code.
- Telegram bridge: auth, basic commands, inline approve/deny callbacks, direct and `job:<name>` modes.
- TUI shell (React/opentui) with task board, job monitor, memory browser.
- `bun run typecheck` passes across the workspace.

### Implemented but not release-ready

- Scheduler, file watcher, and bridge have no unified daemon command — they exist as separate modules but nothing launches them together.
- HITL task review works in API and CLI, but `review` state does not push a Telegram notification automatically.
- Hook scripts post to `/mcp/tool`, but that route does not exist in the server — hooks are broken.
- Session continuity tables (`session_events`, `session_snapshots`) are created via raw SQL in `client.ts`, not in the Drizzle schema — no migrations cover them.
- TUI is an early shell, not release-tested.

---

## v0.0.1 Release Scope

### In scope

1. Core local data layer — SQLite auto-created, stable schema, config file.
2. Projects — create, list, update, archive.
3. Tasks — full status machine, notes, HITL approve/reject from API and CLI.
4. Memories — store, list, FTS5 search, delete.
5. Jobs — create, trigger (executes immediately), run history, log lines.
6. Prompts/Skills — CRUD, version tracking on every update, render with `{{var}}` interpolation.
7. MCP server — memory, task, job, and context tools.
8. CLI — all commands above.

### Explicitly out of scope for v0.0.1

- Telegram HITL notifications (scaffolding exists, not wired end-to-end).
- Scheduled / cron / watch job triggers as a supported user flow (code exists, no daemon command).
- `/mcp/tool` hook endpoint (hooks are currently broken).
- Session continuity as a headline feature.
- TUI as a primary interface.
- Obsidian sync.
- Vector search / embeddings.
- Discord or other bridge targets.

---

## Remaining Work Checklist

### Phase 1 — Build pipeline (blocker)

- [ ] Add missing `tsconfig.build.json` in `packages/sdk`, `packages/db`, `packages/runner`, `packages/bridge` or switch build scripts to avoid them.
- [ ] `bun run build` passes from workspace root.
- [ ] CLI binary builds and runs on target platform.

### Phase 2 — End-to-end flows (blocker)

- [x] `POST /jobs/:id/trigger` executes the job (done — wired to `executeJob` in background).
- [ ] `orc job run <name>` in the CLI also executes end-to-end, not just enqueues.
- [ ] Job logs are visible in CLI or API (route `GET /jobs/:id/runs/:runId/logs` or similar).
- [ ] Review workflow is consistent: `POST /tasks/:id/review` (agent submit) → `orc task approve/reject` (human) → status resolved. ✓ API and CLI done; MCP tools should reflect same states.

### Phase 3 — MCP and API consistency

- [ ] Audit every MCP tool against actual schema — remove or fix stubs relying on incomplete internals.
- [ ] Fix or replace hook scripts that call `/mcp/tool` (route does not exist).
- [ ] Session tools should not claim behavior that is not wired.

### Phase 4 — Minimum automated tests

- [ ] API: task CRUD, task review round-trip, memory search, job trigger → run.
- [ ] Runner: successful command, failing command, log line persistence.
- [ ] MCP: memory search, task create/update, job run/status.
- [ ] `bun run test` passes.

### Phase 5 — Docs and packaging

- [ ] README scoped to v0.0.1 behavior, no promises about unshipped features.
- [ ] Quick-start path that works without Telegram.
- [ ] MCP setup example.
- [ ] Known limitations documented.

---

## Publish Readiness Gate

`v0.0.1` ships when all four of these work on a clean machine without direct DB access or workarounds:

1. Start as a local service (`orc api`).
2. Persist and search shared memory.
3. Track tasks through the full review cycle.
4. Execute a job from CLI or MCP and inspect the run log.

---

## After v0.0.1

Once v0.0.1 is tagged, next priorities in order:

1. Unified background daemon (`orc daemon` or similar) that starts scheduler, watchers, and bridge together.
2. Telegram push notifications for task review and permission events.
3. Session continuity — move `session_events`/`session_snapshots` into the Drizzle schema with migrations.
4. Scheduled / cron / watch job triggers as a documented user-facing feature.
5. TUI and Obsidian as secondary interfaces.
