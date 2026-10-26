# Code quality review: api / db / task-service / sdk

Scope: `packages/api` (Hono + @hono/zod-openapi), `packages/db` (bun:sqlite + Drizzle; runtime schema = raw SQL in `setupDb`), `packages/task-service`, SDK generation/usage. Read-only review on branch `feat/pwa` @ 642e52a. All findings below were verified in the source; A-1 and A-3/A-4 were also verified at runtime (in-memory DB via `bun -e`).

## Summary

- **Correctness first.** Every `db.transaction(async (tx) => …)` call site is not a transaction at all. Drizzle's bun-sqlite `transaction()` is synchronous, so awaited statements run after COMMIT and nothing rolls back (verified). That covers job create/update/delete, project delete, webhook create, webhook delivery ("reserves runs atomically" per AGENTS.md), and runner job actions. `tasks batchCreate` uses a raw `BEGIN … await … COMMIT` on the shared connection, so concurrent requests get pulled into, and rolled back with, its transaction.
- **FK errors.** The runtime DB has FKs with `NO ACTION` (schema.ts says `set null`: drift). Combined with non-atomic deletes, late session inserts from the executor, and no `project_id` existence checks, these are the plausible sources of `SQLITE_CONSTRAINT_FOREIGNKEY`. All of them surface as 500 "Internal server error".
- **Performance.** `tasks` has no secondary index at all, and most FK child columns (`job_runs.task_id`, `sessions.job_run_id`, `bridge_messages.*`, `gateway_sessions.task_id`, …) are unindexed. SQLite therefore full-scans every child table for each parent delete and for hot list queries. The live sessions list loads every task whose body contains "session:" on every call. The tasks FTS trigger rewrites the FTS row on every UPDATE (progress, claimed_by, updated_at bumps). The change tracker adds a trigger write per row to a single-row counter on ~45 tables, including `job_run_logs`.
- **Reuse/flow.** Routes mix inline SQL, Drizzle and services; the same `findFirst → NotFoundError`, `{id}` param, `toDto` date mapping and `$client` cast are re-implemented dozens of times. task-service and runner import each other (cycle hidden behind dynamic `import()`). The SDK is mostly hand-typed despite a 12k-line generated `openapi.gen.ts`, and has already drifted (`Task.agent_model` missing).

Quick wins are marked **[QW]**.

## Prioritized findings

| ID | Title | Category | Impact | Effort | Files |
|---|---|---|---|---|---|
| A-1 | Async Drizzle transactions are not atomic | Correctness | High | S | api/routes/jobs.ts, projects.ts, webhooks.ts; runner/job-actions.ts |
| A-2 | `batchCreate` raw BEGIN/COMMIT around awaits on shared connection | Correctness | High | S | api/routes/tasks.ts |
| A-3 | Missing indexes on FK children and hot list columns **[QW]** | Performance | High | S | db/src/client.ts |
| A-4 | FK `NO ACTION` + three different delete implementations; FK-error sources | Correctness | High | M | db/client.ts, db/kb-digest.ts, api/routes/jobs.ts, runner/scheduler.ts, runner/executor.ts |
| A-5 | Task status transitions: TOCTOU, no transaction, N+1 unblock | Correctness/Perf | High | M | task-service/src/transitions.ts, api/routes/tasks.ts |
| A-6 | Live session list scans all task bodies per request | Performance | High | S | api/src/sessions/tasklinks.ts, api/routes/sessions.ts |
| A-7 | `tasks_au` FTS trigger fires on every UPDATE **[QW]** | Performance | Med | S | db/src/client.ts |
| A-8 | Change-tracking write amplification and `prepare` monkey-patching | Performance | Med | M | db/src/changes.ts |
| A-9 | FK/constraint errors become 500; no parent-existence validation **[QW]** | Correctness/API | Med | S | api/src/server.ts, routes/tasks.ts, jobs.ts, sessions.ts |
| A-10 | Tasks list `total` is the page size; no offset/cursor | API/Perf | Med | S | api/routes/tasks.ts |
| A-11 | Route boilerplate (404 lookup, id params, error schemas, DTO dates) | Reuse | Med | M | api/routes/* |
| A-12 | Layering: SQL in routes, `$client` cast re-implemented 7x | Code flow | Med | M | api/routes/*, api/routes/tags.ts |
| A-13 | Circular dependency task-service <-> runner | Code flow | Med | M | task-service/package.json, transitions.ts, runner/* |
| A-14 | SDK mostly hand-typed, drifted, barrel exports | Reuse/Correctness | Med | M | packages/sdk/src/* |
| A-15 | `schema.ts` vs `setupDb` drift | Correctness | Med | M | db/src/schema.ts, db/src/client.ts |
| A-16 | Inconsistent error shapes | API | Low | S | api/routes/gateway.ts, api/routes/mcp.ts |
| A-17 | Web polling duplicates SSE | Performance | Low | S | web/src/hooks/useWebhooks.ts, ArchivedSessions.tsx |
| A-18 | Oversized files (top 15) | Code flow | Low | M-L | see section |
| A-19 | Orphan comments on task delete | Correctness | Low | S | api/routes/tasks.ts |
| A-20 | Minor: non-constant-time token compare, NOCASE lookup, empty catch, console.error | Misc | Low | S | various |

---

## A-1 Async Drizzle transactions are not atomic (High, S)

**Evidence**
- `node_modules/drizzle-orm/bun-sqlite/session.js`, `transaction()`:
  ```js
  const nativeTx = this.client.transaction(() => { result = transaction(tx); });
  nativeTx[config.behavior ?? "deferred"]();
  return result;
  ```
  The native bun:sqlite transaction is synchronous. An `async` callback returns at its first `await`, the native wrapper COMMITs, and the remaining statements run later in autocommit mode. If they throw, nothing is rolled back.
- Runtime check: inside an `async` callback, `sqlite.inTransaction` was `false` at the first statement. After a forced duplicate-key failure on the second insert, the first row remained.
- Affected call sites:
  - `packages/api/src/routes/jobs.ts:371` (create job + `saveJobWebhooks`)
  - `packages/api/src/routes/jobs.ts:433` (update)
  - `packages/api/src/routes/jobs.ts:479` (delete: null referrers, then delete)
  - `packages/api/src/routes/projects.ts:416` (project delete)
  - `packages/api/src/routes/webhooks.ts:200` (create)
  - `packages/api/src/routes/webhooks.ts:411` (delivery/run reservation; AGENTS.md says this "reserves runs atomically")
  - `packages/runner/src/job-actions.ts:30`

**Why it matters:** partial writes on failure (a job without its webhooks; a half-deleted project). Concurrent requests also interleave between statements, so the webhook run reservation can double-reserve. The job-delete case directly feeds the FK errors in A-4.

**Recommendation:** one shared helper in `@orc/db`, sync-only by type, and a lint rule/grep gate against `transaction(async`.

```ts
// packages/db/src/tx.ts
import type { Database } from "bun:sqlite";
import { getDb, getSqlite } from "./client";
type Db = ReturnType<typeof getDb>;

/** Runs fn inside BEGIN IMMEDIATE. fn MUST be synchronous: use .run()/.get()/.all(), never await. */
export function withTx<T>(fn: (db: Db, sqlite: Database) => T extends Promise<unknown> ? never : T): T {
  const sqlite = getSqlite();
  return sqlite.transaction(() => fn(getDb(), sqlite)).immediate();
}
```
Call sites become `withTx((tx) => { tx.insert(jobs).values(v).run(); saveJobWebhooksSync(tx, …); })`. The `never` return type turns an async callback into a compile error. Use `.immediate()` for read-then-write sequences (reservation, delete) so the read and write share one write lock.

## A-2 `batchCreate` raw BEGIN/COMMIT around awaits (High, S)

**Evidence:** `packages/api/src/routes/tasks.ts:624-689` runs `sqlite.exec("BEGIN")`, loops `await db.insert(...)` once per item (plus links), then `COMMIT`, or `ROLLBACK` in catch.

**Why it matters:** there is a single process-wide connection. Each `await` yields to the event loop, so any other request that writes in that window writes inside this transaction. If the batch then fails, the ROLLBACK silently discards the other request's write even though that request already returned 200. Concurrently, a second `BEGIN` from another batch fails with "cannot start a transaction within a transaction". It also does one statement per row.

**Recommendation:** `withTx` (A-1) with sync `.run()` calls and a prepared multi-row insert: `tx.insert(tasks).values(rows).run()`, then `tx.insert(taskLinks).values(links).run()`. Validate all items first (outside the tx) so the transaction body cannot fail on input errors.

## A-3 Missing indexes on FK children and hot list columns (High, S) [QW]

**Evidence (runtime `sqlite_master`, in-memory `createDb`)**
- `tasks`: only `sqlite_autoindex_tasks_1` (PK).
- `sessions`, `bridge_messages`, `bridge_permissions`: PK only.
- `job_runs`: only `job_runs_job_id_idx`.
- `gateway_sessions`: only `gateway_sessions_chat_idx`.

**Query sites without a usable index**

| Query | Location | Needed index |
|---|---|---|
| tasks list `WHERE project_id/status ORDER BY updated_at` | api/routes/tasks.ts:432 | `tasks(project_id, status, updated_at)` |
| project stats `GROUP BY status WHERE project_id` | api/routes/projects.ts:295 | same |
| sessions list `ORDER BY created_at` + `count(*)` | api/routes/sessions.ts:452-477 | `sessions(project_id, created_at)` |
| live sessions `ORDER BY last_activity_at` | api/routes/sessions.ts:376 | `gateway_sessions(chat_id, last_activity_at)` |
| `gateway_sessions WHERE task_id ORDER BY updated_at` | task-service/transitions.ts:206 | `gateway_sessions(task_id, updated_at)` |
| running-count by role/status | runner/flow-runner.ts:1642, 1649 | `gateway_sessions(status, role)` |
| pruneHistory delete by `created_at`; `IN (subquery)` updates | runner/scheduler.ts:70-150 | `job_runs(created_at)`, `bridge_messages(job_run_id)`, `bridge_permissions(job_run_id)` |

Every parent delete also makes SQLite scan each child table that references it, because FK enforcement looks up children by the child column. That affects `job_runs`, `gateway_sessions`, `projects`, `tasks` and `bridge_chats` deletes, and pruneHistory deletes many `job_runs` per tick.

**Recommendation:** append to the `setupDb` migration list (idempotent):
```sql
CREATE INDEX IF NOT EXISTS tasks_project_status_updated_idx ON tasks(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS sessions_project_created_idx ON sessions(project_id, created_at);
CREATE INDEX IF NOT EXISTS sessions_job_run_idx ON sessions(job_run_id);
CREATE INDEX IF NOT EXISTS sessions_agent_idx ON sessions(agent);
CREATE INDEX IF NOT EXISTS gateway_sessions_task_idx ON gateway_sessions(task_id, updated_at);
CREATE INDEX IF NOT EXISTS gateway_sessions_activity_idx ON gateway_sessions(chat_id, last_activity_at);
CREATE INDEX IF NOT EXISTS gateway_sessions_status_role_idx ON gateway_sessions(status, role);
CREATE INDEX IF NOT EXISTS job_runs_task_idx ON job_runs(task_id);
CREATE INDEX IF NOT EXISTS job_runs_created_idx ON job_runs(created_at);
CREATE INDEX IF NOT EXISTS job_runs_status_idx ON job_runs(status);
CREATE INDEX IF NOT EXISTS bridge_messages_chat_idx ON bridge_messages(chat_id);
CREATE INDEX IF NOT EXISTS bridge_messages_run_idx ON bridge_messages(job_run_id);
CREATE INDEX IF NOT EXISTS bridge_messages_gw_idx ON bridge_messages(gateway_session_id);
CREATE INDEX IF NOT EXISTS bridge_permissions_gw_idx ON bridge_permissions(gateway_session_id);
CREATE INDEX IF NOT EXISTS bridge_permissions_run_idx ON bridge_permissions(job_run_id);
CREATE INDEX IF NOT EXISTS flow_node_runs_task_idx ON flow_node_runs(task_id);
CREATE INDEX IF NOT EXISTS flow_node_runs_gw_idx ON flow_node_runs(gateway_session_id);
CREATE INDEX IF NOT EXISTS session_handoffs_live_idx ON session_handoffs(live_session_id);
CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs(project_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_run_idx ON webhook_deliveries(job_run_id);
```
Run `ANALYZE` once after creation. Confirm with `EXPLAIN QUERY PLAN` on the queries above.

## A-4 FK `NO ACTION`, duplicated delete logic, and sources of SQLITE_CONSTRAINT_FOREIGNKEY (High, M)

**Evidence: runtime FKs** (`PRAGMA foreign_key_list`)
- `sessions`: `job_run_id -> job_runs` and `project_id -> projects`, both `NO ACTION`.
- `bridge_messages`: `gateway_session_id`, `job_run_id` and `chat_id`, all `NO ACTION`.
- Also without ON DELETE in `setupDb`:
  - `packages/db/src/client.ts:39` (tasks.project_id)
  - `:136-137` (sessions)
  - `:183/187/188` (bridge_messages)
  - `:198-199` (bridge_permissions)
  - `:362` (jobs.project_id)
  - `:396` (bridge_chats.project_id)
  - `packages/db/src/kb.ts:17`, `:172` (kb_digests.job_id)
  - `packages/db/src/rules.ts:37-45`
- Meanwhile `bridge_chats -> gateway_sessions` cascades. Deleting a chat cascades away its gateway sessions, but the `bridge_messages.gateway_session_id` rows pointing at them are `NO ACTION`, so the delete fails.

**Three hand-written versions of "null referrers then delete job"**
1. `packages/db/src/kb-digest.ts:239` `deleteJobRow(sqlite, jobId)`: correct, sync transaction.
2. `packages/runner/src/scheduler.ts:70-150` pruneHistory: correct, sync transaction.
3. `packages/api/src/routes/jobs.ts:467-502`: reads `runIds` **before/outside** the (non-atomic, A-1) transaction, then nulls `sessions`/`bridge_*` referrers for that snapshot and deletes.

**Plausible FK-error causes (ordered by likelihood)**
1. **Job delete race (jobs.ts:467-502):** a run created after the `runIds` snapshot (trigger route `jobs.ts:504`, a webhook delivery, the scheduler) is cascaded away with the job. Its referrers (session, bridge message) are not nulled, so the delete fails, or a later insert referencing that run fails.
2. **Executor late session insert (`packages/runner/src/executor.ts:212-242`):** inserts `sessions.job_run_id` after a run ends. If the job or run was deleted or pruned meanwhile, the insert fails. It is caught by `msg.includes("FOREIGN KEY")`, which is string matching that hides the root cause.
3. **No parent validation** on `project_id` in task create (`tasks.ts:453-492`), task update, jobs and sessions. A stale or typo'd id produces an FK error, which is returned as a 500 (A-9).
4. **bridge_chats delete** (cascade vs `NO ACTION` above).
5. `kb_digests.job_id` has no ON DELETE; guarded only in the jobs route via `kbDigestKbId`.

**Recommendation**
- Make the runtime schema express intent, so referrers are handled by SQLite rather than by three copies of app code. Use `ON DELETE SET NULL` for `sessions.job_run_id`, `bridge_messages.{job_run_id,gateway_session_id}` and `bridge_permissions.*`; use `SET NULL` or `CASCADE` (decide per table) for `chat_id`, `project_id` and `kb_digests.job_id`. SQLite needs a table rebuild for that; the repo already has the `*_legacy_*` rebuild pattern (`webhooks_legacy_single_job`). This is a data migration, so it needs explicit approval before it runs on a real DB.
- Until then: one `deleteJob(jobId)` in `@orc/db` (promote `deleteJobRow`) used by the route, the scheduler and kb-digest, which collects run ids **inside** an `IMMEDIATE` transaction.
- In the executor, check that the run exists inside the same sync tx as the insert (`INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM job_runs WHERE id=?)`), instead of string-matching the error.

## A-5 Task status transitions: TOCTOU, no transaction, N+1 unblock (High, M)

**Evidence: `packages/task-service/src/transitions.ts`**
- `:64-76` reads the status and validates against `TASK_STATUS_TRANSITIONS`.
- `:111` then runs an unconditional `db.update(tasks).set(updates).where(eq(tasks.id, opts.taskId))`. Two concurrent transitions (flow runner plus a human, or two agents claiming `doing`) both pass validation and the last write wins. `claimed_by` can be overwritten.
- `:113-226`: comment insert, dependents unblock, parent progress/auto-review, and review-round pause are separate autocommit statements. A crash midway leaves a task `done` with its dependents still `blocked`, or a parent not promoted.
- `:139-159`: per dependent there are 2-3 queries (remaining-blockers check, status read, update). That is N+1, and it could be one statement:
  ```sql
  UPDATE tasks SET status='todo', updated_at=unixepoch()
  WHERE status='blocked' AND id IN (/* dependents */) AND NOT EXISTS (/* open blocker */);
  ```
- `:119` re-reads the task only to check `required_review`, which is already on `task` from `:64`. `:249` re-reads again at the end.
- `:124` uses `console.error` while the module has `logger`.
- `packages/api/src/routes/tasks.ts:494-556`: the update route writes non-status fields and calls `updateTaskStatus` as two separate writes.

**Recommendation**
- Guard the write: `UPDATE tasks SET … WHERE id=? AND status=?` (current status) and check `changes === 1`. Otherwise return a 409 `ConflictError`. This needs no transaction and kills the race.
- Wrap the DB side effects (guarded update, comment, unblock, parent progress, review rounds) in `withTx`. Keep the flow notification, `triggerTaskCheck` and `notifyReview` **after** commit.
- Collapse the unblock loop into one set-based UPDATE; compute parent progress in one statement.

## A-6 Live sessions list scans all task bodies per request (High, S)

**Evidence: `packages/api/src/sessions/tasklinks.ts`**
- `:18-22`: `tasksWithSessionLines()` = `findMany({ where: like(tasks.body, "%session:%") })`. A leading-wildcard LIKE is a full scan, and it loads full rows (body, flow_override, …).
- `:24-33`: `bodyLinkIndex()` then regex-parses every body. It is called from `toLiveDtos` (`api/routes/sessions.ts:316`) on every live list and every search.
- `:35-38`: `sessionIdsOfTask(taskId)` loads all matching tasks and then calls `.find(t => t.id === taskId)` instead of `WHERE id = ?`.

**Why it matters:** cost grows with total task-body size and is paid on the most frequently polled/SSE-refreshed screen.

**Recommendation**
- Immediate: `sessionIdsOfTask` becomes `findFirst({ where: eq(tasks.id, taskId), columns: { body: true } })`. In `tasksWithSessionLines`, select only `id, title, status, updated_at, body`.
- Proper: maintain a `task_session_links(task_id, session_id)` table, written when a task body is saved (task create/update in task-service). Live DTOs then join on an index. Alternatively, memoize `bodyLinkIndex` keyed on the `orc_change_versions` value for `tasks` (already tracked by changes.ts), so it is rebuilt only when tasks change.

## A-7 `tasks_au` FTS trigger fires on every UPDATE (Med, S) [QW]

**Evidence:** `packages/db/src/client.ts:308-312` `CREATE TRIGGER tasks_au AFTER UPDATE ON tasks` deletes and reinserts the FTS row. It fires for `progress`, `claimed_by` and `updated_at`-only updates, which the flow runner and transitions code do constantly (`transitions.ts:155, 175, 184`).

**Recommendation:** in a migration, `DROP TRIGGER IF EXISTS tasks_au;` then recreate it as `AFTER UPDATE OF title, body, tags ON tasks`. Each status bump then avoids an FTS delete and reinsert.

## A-8 Change-tracking write amplification (Med, M)

**Evidence: `packages/db/src/changes.ts`**
- Per-row INSERT/UPDATE/DELETE triggers on ~45 tables (`orc_change_tasks_INSERT`, …), each updating the **single** row in `orc_change_versions`. That includes `job_run_logs`, which gets one insert per streamed log line.
- `sqlite.prepare/query/exec/run` are monkey-patched and run a regex against every SQL string.
- An `fs.watch` on the DB directory with a 25ms debounce runs in addition to the triggers.

**Why it matters:** every log line costs two writes (row plus counter update), and every write in the system serializes on the same counter row. A bulk delete of N rows fires N trigger updates. The regex on every `prepare` adds CPU on every hot query.

**Recommendation**
- Drop the triggers on append-only, high-rate tables (`job_run_logs`, `session_events`). Publish those changes from the writer (one `publish("job_runs")` per log batch).
- Use statement-level signalling instead of per-row: bump a per-table in-memory counter in the patched `run` only when the SQL is a write (cache the regex result per SQL string in a `Map`, since statements are reused). Keep the triggers only for cross-process writers if needed, and per table, not one shared row.

## A-9 FK/constraint errors become 500; no parent-existence validation (Med, S) [QW]

**Evidence**
- `packages/api/src/server.ts` `onError` maps `OrcError`, `ZodError` and `HTTPException`; any `SQLiteError` falls to a 500 "Internal server error".
- `tasks.ts:453-492` inserts `project_id: body.project_id` unchecked; the same applies to task update, job create and session create.

**Recommendation:** map `SQLiteError.code`: `SQLITE_CONSTRAINT_FOREIGNKEY` to 422 `{ code: "INVALID_REFERENCE" }`, and `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT_PRIMARYKEY` to 409. Log it with the route. Separately, add `assertExists(projects, id, "project")` (see A-11) before writes, so the user gets "Project X not found" rather than a constraint name.

## A-10 Tasks list `total` and pagination (Med, S)

**Evidence: `packages/api/src/routes/tasks.ts:401-443`**
- Returns `total: rows.length`, which is the page size; clients cannot know more exist.
- No `offset`/cursor; max limit 100.
- The tag filter is `json_each` over all tasks.
- `rawToDto` is duplicated at `tasks.ts:378` and `projects.ts:233`.

**Recommendation:** a shared `pageQuery` schema (`limit`, `offset` or `cursor=updated_at,id`) and a `paged()` helper that runs `COUNT(*)` with the same WHERE. Move `rawToDto` to one `taskRowToDto` in task-service. If tag filtering is common, add a `task_tags(task_id, tag)` table.

## A-11 Route boilerplate (Med, M)

**Evidence (counts across `packages/api/src/routes`)**
- 47 `throw new NotFoundError`; 39 follow `findFirst(...)` then `if (!row) throw`.
- 31 copies of `z.object({ id: z.string() })` for path params.
- No shared `ErrorSchema`, so 4xx responses are absent from the OpenAPI document and the SDK cannot type them.
- 10 `toDto` functions repeating `x.toISOString()` / `x ?? null`.

**Recommendation:** `packages/api/src/lib/route-helpers.ts`:
```ts
export const IdParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
export const ErrorSchema = z.object({ error: z.string(), code: z.string() }).openapi("Error");
export const errorResponses = (...codes: (400|404|409|422)[]) =>
  Object.fromEntries(codes.map((c) => [c, { description: STATUS_TEXT[c], content: { "application/json": { schema: ErrorSchema } } }]));

export async function findOr404<T extends SQLiteTable>(table: T, id: string, label: string) { /* select … where id; throw NotFoundError(`${label} not found: ${id}`) */ }

export function isoDates<R, K extends keyof R>(row: R, keys: K[]): Omit<R, K> & Record<K, string | null>;

export const PageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
export const paged = <T>(items: T[], total: number) => ({ items, total });
```
This removes roughly 150-250 lines and makes error responses typed in the SDK.

## A-12 Layering and the `$client` cast (Med, M)

**Evidence**
- Some routes contain the domain logic and SQL directly: `tasks.ts` (6 raw SQL + 17 Drizzle calls), `jobs.ts` (14), `projects.ts` (6 raw + 18), `sessions.ts`, `webhooks.ts`, `task-links.ts`. In contrast, `knowledge`, `memories`, `rules` and `skills` delegate to services in `@orc/db` or other packages.
- `(db as unknown as { $client: Database }).$client` is re-implemented 7 times (`projects.ts`, `sessions.ts`, …), and `tags.ts` (~line 46) has its own `getSqlite` even though `@orc/db/client` exports `getSqlite()`.

**Recommendation:** replace the casts with `getSqlite()` **[QW]**. Move task, job and project write paths into service modules (`task-service` already exists for tasks; add `jobs` functions next to `deleteJobRow` in `@orc/db`), and keep routes to parse, call the service, then map the DTO. This also lets the CLI/MCP tools share the logic instead of going through HTTP or duplicating it.

## A-13 Circular dependency task-service <-> runner (Med, M)

**Evidence**
- `packages/task-service/package.json` depends on `@orc/runner`; `transitions.ts:236` and `:244` dynamically import `@orc/runner/flow-runner` and `@orc/runner/task-loop`.
- `packages/runner` imports `@orc/task-service` (`flow-runner.ts`, `orc-task-provider.ts`).
- The api uses dynamic `import("@orc/runner")` 9 times.

**Why it matters:** dynamic imports hide the cycle from tooling, defer load errors to runtime, and make the order of module initialization fragile.

**Recommendation:** invert it with a hook registry in task-service:
```ts
// task-service/src/hooks.ts
type TaskHooks = { onExternalStatusChange?(id: string, s: TaskStatus, author?: string): Promise<void>; onTaskSettled?(): void };
export const taskHooks: TaskHooks = {};
export function registerTaskHooks(h: TaskHooks) { Object.assign(taskHooks, h); }
```
The runner registers the hooks at startup, and task-service drops its `@orc/runner` dependency.

## A-14 SDK: mostly hand-typed, drifted, barrel exports (Med, M)

**Evidence**
- Generation: `bun ../api/scripts/dump-openapi.ts openapi.json && openapi-typescript … -o src/openapi.gen.ts` produces 12,158 lines.
- Only 11 types in `packages/sdk/src/types.ts` use `components["schemas"]`; about 79 are hand-written.
- `client.ts` (872 lines) hand-writes every path, with `c<T>` casts.
- Drift: SDK `Task` (`types.ts:70-92`) lacks `agent_model`, which the API returns.
- `packages/sdk/src/index.ts` uses `export *`, which violates the repo convention "No barrel re-exports".
- Consumers include `packages/gateway/src/api.ts:2`.

**Recommendation:** derive every DTO type from `components["schemas"]` (name the zod schemas with `.openapi("Task")` so they appear there). Replace hand-written calls with `openapi-fetch` (`createClient<paths>()`), so path, params and response types come from the spec. Add a CI check that regenerates and diffs `openapi.gen.ts`. Replace `export *` with explicit subpath exports.

## A-15 `schema.ts` vs `setupDb` drift (Med, M)

**Evidence:** `packages/db/src/schema.ts` declares `onDelete: "set null"` (e.g. `:217` sessions.job_run_id, `:259`, `:273`), but the runtime tables (created by raw SQL in `client.ts`) have `NO ACTION` (verified via PRAGMA above). Indexes also differ: schema.ts lists some the runtime lacks, and vice versa.

**Why it matters:** anyone reading `schema.ts` (humans or agents) will assume cascades and indexes that do not exist. That is exactly how A-4's delete paths became necessary and then diverged.

**Recommendation:** pick one source of truth. Cheapest: a test that creates the DB through `setupDb` and asserts that `PRAGMA foreign_key_list` / `index_list` for each table matches what `schema.ts` declares (via `getTableConfig`). Fix drift until it passes, and then the test keeps it that way.

## A-16 Inconsistent error shapes (Low, S)

**Evidence:** `packages/api/src/routes/gateway.ts:62` returns `c.json({ error: "Gateway is not running" }, 503)` with no `code`; `mcp.ts:30` is similar. Elsewhere, `onError` emits `{ error, code }`.

**Recommendation:** throw an `OrcError` subclass (`ServiceUnavailableError`) and let `onError` shape the response; use `ErrorSchema` from A-11.

## A-17 Web polling duplicates SSE (Low, S)

**Evidence**
- `packages/web/src/hooks/useWebhooks.ts:17` refetches deliveries every 3s, although `webhook_deliveries` changes are already published as the `"webhooks"` resource on SSE.
- `ArchivedSessions.tsx:53` polls every 10s because `session_archives` is not in `TABLE_RESOURCES` (changes.ts).
- `TerminalPaneLinks` polls every 60s.
- `useHumanRequests` polls every 15s, which is justified in a comment.

**Recommendation:** drop the 3s poll and rely on SSE invalidation. Add `session_archives` to `TABLE_RESOURCES` and remove the 10s poll.

## A-18 Oversized files (Low, M-L)

| # | File | Lines | Suggested split |
|---|---|---|---|
| 1 | api/src/routes/knowledge.ts | 917 | 49 routes: split by sub-resource (bases, documents, search, digests) |
| 2 | api/src/routes/skills.ts | 885 | ~375 lines of schemas/helpers first; move to `skills/schemas.ts` + `skills/service.ts` |
| 3 | api/src/routes/chat.ts | 852 | move the in-memory run registry + streaming into `chat/run-registry.ts` |
| 4 | api/src/routes/tasks.ts | 697 | DTO/list query to task-service; batch route to its own module |
| 5 | api/src/routes/primitives.ts | 612 | one module per primitive kind |
| 6 | api/src/sessions/archive.ts | 590 | separate archive format I/O from DB writes |
| 7 | db/src/rules.ts | 588 | DDL vs query functions |
| 8 | db/src/client.ts | 580 | `ddl.ts` (CREATE TABLE), `migrations.ts` (ordered list), `client.ts` (open + pragmas) |
| 9 | api/src/routes/jobs.ts | 563 | delete/trigger logic to a jobs service (A-4) |
| 10 | db/src/schema.ts | 533 | per-domain schema files |
| 11 | api/src/routes/projects.ts | 531 | stats + delete to a service |
| 12 | api/src/routes/sessions.ts | 526 | live vs historical sessions |
| 13 | api/src/routes/webhooks.ts | 497 | delivery/reservation to a service (A-1) |
| 14 | api/src/git/github.ts | 480 | API client vs PR-flow logic |
| 15 | db/src/memories.ts | 455 | DDL vs queries |

Next: `terminals.ts` 449, `flows.ts` 438, `skill-history.ts` 428, session-archive route 417, `handoffs/service.ts` 408.

## A-19 Orphan comments on task delete (Low, S)

**Evidence:** `packages/api/src/routes/tasks.ts:558-574` deletes the task. `comments` is polymorphic (`resource_type`, `resource_id`) with no FK, so task comments remain forever.

**Recommendation:** inside the same `withTx`, run `DELETE FROM comments WHERE resource_type='task' AND resource_id=?` (the index `comments_resource_idx` exists). Apply the same rule to other comment-bearing resources.

## A-20 Minor items (Low, S)

- `packages/api/src/middleware/auth.ts`: `auth.slice(7) !== required` is a non-constant-time compare. Use `crypto.timingSafeEqual` on equal-length buffers.
- Project lookup by name uses `name = ? COLLATE NOCASE`, which cannot use `projects_name_idx` (default BINARY collation). Create the index with `COLLATE NOCASE`.
- Session get (`sessions.ts:480-520`) orders by `created_at ASC`, which does not match index `(session_id, priority, created_at DESC)`. Low volume; align when touched.
- `packages/db/src/client.ts:457-462`: seed inserts use an empty `catch {}`. Use `INSERT OR IGNORE` and let real errors throw.
- `client.ts:420-437`: migration errors are swallowed by message matching ("duplicate column", "already exists"). Acceptable, but keep the patterns narrow and log anything else.
- `task-service/src/transitions.ts:124`: `console.error` should be `logger.error`.

## Things that are already good

- Pragmas (`client.ts:496-506`): WAL, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`, `wal_autocheckpoint`, plus a periodic TRUNCATE checkpoint.
- SSE `events.ts` coalesces changes per connection.
- Task list comment counts are batched (`getCommentsCountMap`).
- `deleteJobRow` (kb-digest.ts) and scheduler `pruneHistory` use correct synchronous transactions. They are the model for A-1/A-4.
