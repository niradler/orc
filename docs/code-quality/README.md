# ORC Code Quality Roadmap

Consolidated from three read-only reviews on branch `feat/pwa` (master `642e52a`). Finding IDs are kept so you can jump to the evidence:

- Web dashboard: [code-quality/web.md](web.md) (W-1..W-24)
- API / DB / task-service / SDK: [code-quality/api-db.md](api-db.md) (A-1..A-20)
- Runtime packages (core, agent-runtime, gateway, runner, knowledge, mcp, cli, desktop): [code-quality/runtime.md](runtime.md) (R-1..R-30)

Effort: S = under a day, M = 1-3 days, L = a week or more. Items the detail docs flag as uncertain keep that label.

---

## 1. Fix first: correctness bugs

### Data integrity (api / db)

| ID | What | Where | Fix | Size |
|---|---|---|---|---|
| A-1 | Every `db.transaction(async ...)` is not a transaction: Drizzle's bun-sqlite transaction is synchronous, so awaited statements run after COMMIT and nothing rolls back (verified at runtime). Covers job create/update/delete, project delete, webhook create, webhook run reservation, runner job actions | `api/routes/jobs.ts:371,433,479`, `projects.ts:416`, `webhooks.ts:200,411`, `runner/job-actions.ts:30` | Shared sync-only `withTx` in `@orc/db` (async callback becomes a compile error); grep/lint gate on `transaction(async` | S |
| A-2 | `batchCreate` does raw `BEGIN ... await ... COMMIT` on the one shared connection; concurrent writes get pulled into it and rolled back with it | `api/routes/tasks.ts:624-689` | `withTx` plus one multi-row insert; validate all items before the tx | S |
| A-5 | Task status transitions have a TOCTOU race (last write wins, `claimed_by` can be overwritten), side effects are separate autocommits, and unblock is N+1 | `task-service/src/transitions.ts:64-226` | `UPDATE ... WHERE id=? AND status=?` and 409 on 0 changes; wrap DB side effects in `withTx`; one set-based unblock UPDATE | M |
| A-4 | FKs are `NO ACTION` at runtime, with three hand-written "null referrers then delete job" copies. The route copy reads run ids outside its (non-atomic) tx. Plausible source of `SQLITE_CONSTRAINT_FOREIGNKEY` | `db/client.ts`, `api/routes/jobs.ts:467-502`, `runner/executor.ts:212-242` | Interim: one `deleteJob` in `@orc/db` (promote `deleteJobRow`) with an IMMEDIATE tx; executor inserts guarded by `WHERE EXISTS`. Real fix is a table-rebuild migration and needs your explicit approval | M |
| A-9 | FK/unique constraint errors surface as 500; no parent-existence checks on `project_id` | `api/server.ts` `onError`, `routes/tasks.ts`, `jobs.ts`, `sessions.ts` | Map `SQLITE_CONSTRAINT_*` to 422/409; add `assertExists` before writes | S |
| A-19 | Task delete leaves its comments forever (polymorphic, no FK) | `api/routes/tasks.ts:558-574` | Delete comments inside the same `withTx` | S |

### Daemon availability (runtime)

| ID | What | Where | Fix | Size |
|---|---|---|---|---|
| R-1 | Telegram processes updates sequentially and the handler awaits the whole turn, so Allow/Deny buttons can't be handled until the 30-min permission timeout | `gateway/telegram.ts:178`, `manager.ts:402`, `agent-runner.ts:213` | Don't await the turn; serialise per chat with `SessionLock` (or grammY `sequentialize`) | S |
| R-2 | No `bot.catch`: one thrown handler error stops the bot for good | `gateway/telegram.ts` | `bot.catch` plus a shared `safeDispatch()` | S |
| R-9 | Agent/task text interpolated into Telegram HTML unescaped (e.g. `2>&1` makes Telegram reject the message and the permission is never answered) | `gateway/agent-runner.ts:193`, `manager.ts:593`, `direct.ts` | Shared `escapeHtml` / escaping `html` template; escape, then slice | S |
| R-3 | Task loop wedges permanently if the `job_runs` insert or job lookup throws (flag set before the `try`) | `runner/task-loop.ts:146-166` | Move lookup and insert inside the `try`. Also add a `rerunRequested` flag for dropped `triggerTaskCheck` calls | S |
| R-4 | Job timeout kills `sh` but not grandchildren; stream readers never finish, the run stays `running` and holds a concurrency slot; `daemon stop` on Windows skips shutdown hooks | `runner/executor.ts:121-204`, `core/exec-host.ts:832`, `cli/daemon.ts:291` | Shared `killTree` in `@orc/core` (reuse `api/terminals/spawn.ts:22`); cancel readers after a grace period | M |
| R-6 | Bundled CLI still has async-module initialisers (18); the `@orc/mcp` barrel calls child inits without await, working only by import order (the #111 class) | `mcp/src/index.ts`, `knowledge/parsers/worker.ts:47`, `api/routes/mcp.ts:5` | Move the `import.meta.main` blocks to entry files; import `@orc/mcp/server` directly; add a `validate:package` check for `__esm(async` | S |
| R-8 | `claude.ts` and `acpx.ts` lose exit/auth errors on EOF and report success (`"(no output)"`) | `agent-runtime/claude.ts:191-303`, `acpx.ts:333-352` | Use the codex pattern: await stdout and stderr drained before deciding | S |
| R-15 | `send()` race: the previous turn's cleanup ends the new turn | `claude-sdk.ts:200-208`, `agentapi.ts:71-176` | Per-turn generation in a shared event channel (see R-14 below) | S |
| R-22 | One-shot jobs more than 24.8 days out fire immediately (setTimeout clamp); callback has no try | `runner/scheduler.ts:226-236` | `setLongTimeout` helper; wrap the callback | S |
| R-26 | Desktop overwrites the whole `config.json` when it fails to parse | `desktop/src/main.ts:26-49` | Treat only ENOENT as empty; back up and refuse to write on parse error | S |
| R-11 | CLI exits 0 on API errors; `--json` errors print `[object Object]`; 4 different helpers | `cli/src/commands/task.ts`, `job.ts` | One `run()` helper (see section 5) | M |
| R-17 | SDK ignores `ORC_API_BASE`, so remote-agent `orc task ...` hits the wrong port; `host: "::"` yields `http://:::7700` | `sdk/src/client.ts:215` | Single resolver (see section 5) | S |
| R-27 | Smaller items: short task IDs resolve through `list({limit:100})` and pick first ambiguous match; Codex app-server half-start; prompt on argv (Windows ~32 KB limit); replies truncated at 4096; secrets possibly in logs | various | See R-27 for the list | S-M |

### Web

| ID | What | Where | Fix | Size |
|---|---|---|---|---|
| W-22 | `KnowledgeSettings` form resets on every refetch, wiping in-progress edits (worse with W-8) | `KnowledgeSettings.tsx:77` | Initialise once per entity version (`key=dataUpdatedAt` child) or a dirty flag | S |
| W-21 | `req()` parses JSON before checking `res.ok`/content type (proxy 502 HTML becomes `SyntaxError`); `getApiUrl` reads `localStorage` unguarded | `web/api/client.ts:179,484-525` | Check content type first, export `ApiError{status}`; use the safe storage helper from `api-credentials.ts` | S |
| W-10 | `ResizeObserver` never disconnected per terminal dispose (leak) | `lib/terminal-runtime.ts:~497,607` | `.disconnect()` in unmount and dispose | S |

---

## 2. Quick wins

Only items the detail docs mark as quick wins (QW / lightning) or that are small and low-risk.

| ID | Change | Impact | Effort |
|---|---|---|---|
| W-2 | Move `isMarkdownFile` to a no-import `lib/file-kind.ts` so CodeMirror leaves main (about -550 KB) | High | S |
| W-3 | Move `CreateProjectDialog` out of `views/Projects.tsx`; lazy-load dialogs from palette/picker; lint guard against `components/*` importing `@/views/*` | High | S |
| A-3 | Add the listed `CREATE INDEX IF NOT EXISTS` set in `setupDb` (tasks has no secondary index; FK children unindexed), then `ANALYZE` | High | S |
| A-7 | Recreate `tasks_au` as `AFTER UPDATE OF title, body, tags` | Med | S |
| A-9 | Map `SQLITE_CONSTRAINT_*` in `onError` | Med | S |
| A-12 (part) | Replace the 7 `$client` casts with `getSqlite()` | Low | S |
| R-1, R-2 | Telegram: non-blocking dispatch, `bot.catch` | High | S |
| R-3 | Task loop try/finally scope | High | S |
| R-5 | Flush `job_run_logs` in batches of about 500; cap buffers at 1-5 MB (bound-parameter limit is unconfirmed, a test would settle it) | High | S |
| R-6 | Move async-module entry blocks; bundle assertion | High | S |
| R-8 | Await stream drain before deciding the result | High | S |
| R-9 | Shared Telegram HTML escaping | High | S |
| R-12 | One ref-counted flow timeout sweeper instead of one per live node | Med | S |
| R-13 | Watch jobs: per-job debounce, in-flight map, global `max_concurrent_jobs` | High | S |
| R-17 | One API base resolver | High | S |
| R-19 | Call `installRules` once; wrap the 2 s tick in try; run actions concurrently up to the cap | Med | S |
| R-21 | Logger: track bytes in memory, stop stat/exists per line | Med | S |
| R-22, R-26 | Long timeout helper; desktop config safety | Med | S |
| W-10 | Disconnect `ResizeObserver` | Med | S |
| W-11 | Remove the 3 s webhook-delivery poll (also A-17: drop the 10 s `ArchivedSessions` poll after adding `session_archives` to `TABLE_RESOURCES`) | Med | S |
| W-12 | By-id lookup instead of fetching 5,000 sessions in `ChatContinueInTerminal` | Med | S |
| W-16 | One `useResumeInChat` for the two duplicated resume flows | Low | S |
| W-17 | Replace the 8 `window.confirm` calls with a promise-based `useConfirm()` on `ConfirmDialog` | Low | S |
| W-18 | `<SkeletonRows>` plus `lib/status-colors.ts` | Low | S |
| W-20 | Delete 9 dead files and 2 unused deps (check with the PWA/mobile work before removing `MobileChatFab` / `MobileTopBar`) | Low | S |
| A-16, A-20 | Consistent `{error, code}` shapes; constant-time token compare; `NOCASE` index; `INSERT OR IGNORE` for seeds; `console.error` to `logger` | Low | S |

---

## 3. Performance

### Mobile / PWA first load (web)

| ID | Issue | Expected effect |
|---|---|---|
| W-1 | ghostty-web (624 KB) eagerly in main via root `TerminalsProvider`; dynamic-import it and move constants to `terminal-config.ts` | -624 KB (M) |
| W-2 | CodeMirror languages in main through a one-line regex helper | -550 KB (S) |
| W-3 | Palette/picker statically pull Projects, TaskDetailSheet, FlowRunPanel | about -65 KB source, breaks the W-2 chain (S) |
| W-4 | assistant-ui (~350 KB) eager at root, plus a fetch and live stream per stored chat thread on every start; split `ChatShell` (eager) and `ChatRuntime` (lazy) | Smaller main, fewer startup requests (M) |
| W-13 | Always-mounted 628-line `CommandPalette` builds its entries while closed; shell plus lazy dialog | Less idle work (M) |
| W-24 | Rules chunk includes `re2js` (141 KB); import only latin font subsets (68 font files emitted). Keep big lazy chunks (mermaid, shiki, ...) out of the PWA precache | Minor (S) |

Target from W-1..W-4: main under about 800 KB raw (from 2,395 KB / 750 KB gzip).

### Refetch storms and re-renders (web, mobile CPU and data)

| ID | Issue | Fix direction |
|---|---|---|
| W-6 | Each `sessions` SSE event refetches `limit: 5000` lists at 4 call sites and re-downloads transcripts | Ids in events, throttle per root, server-side pagination, separate transcript root |
| W-7 | Transcript fetched in full via sequential 500-turn pages and rendered unvirtualized | `useInfiniteQuery` newest-first plus `@tanstack/react-virtual` |
| W-8 | About 2 refetches per mutation; `refetchOnMount: "always"` redundant with SSE | Pick one freshness mechanism |
| W-5 | Chat context value changes on every streamed token and re-renders every session row's `ResumeActions` | Split stable actions context from state context |
| W-9 | Terminals context churn re-renders 12 consumers on any connection/font change | Per-id `useSyncExternalStore` |
| W-10 | Terminal sockets stay open off-screen and in background tabs | Close hidden sockets, pause reconnect timers |

### Database (PC / daemon)

- A-3 missing indexes (full child-table scan on every parent delete and hot list query).
- A-6 live sessions list scans every task body containing `session:` per request (S for the immediate fix, memoize or link table for the proper one).
- A-7 FTS trigger on every UPDATE; A-8 change-tracking triggers write a counter row per row on about 45 tables, including `job_run_logs` (M).
- A-10 tasks list `total` is the page size and there is no offset or cursor (S).

### Background loops and daemon (PC)

| ID | Issue | Effort |
|---|---|---|
| R-7 | KB folder sources re-read and re-hashed synchronously every 60 s (up to 5,000 files); store mtime and size, drop `content` from the select | M |
| R-12 | Per-node 5 s sweeps over every flow (about K x R x 4 queries) | S |
| R-19 | Rule poller re-runs DDL and PRAGMA every 2 s | S |
| R-21 | Logger: three sync syscalls per line | S |
| R-5 | Up to 200 MB buffered per command job | S |
| R-16 | `UPDATE gateway_sessions` on every streamed event in two places (flow-runner already throttles) | M |
| R-28 | N+1 in flow drain; KB corpus loaded twice at startup | S |
| R-30 | Compiled binary reinstalls embedded skills on every launch, including `--help` | S |

### CLI startup

R-10: `orc --help` takes about 290 ms (7.94 MB bundle) versus about 80 ms for a command-only bundle. Fix: lazy command registration; keep SDK-only commands (task, mem, job, project) static; dynamic-import api, runner, gateway, knowledge and agent-runtime inside actions; make the claude-agent-sdk import lazy; give the parser worker its own entry (also pays per KB parse today). Effort M.

---

## 4. Reusability / shared helpers

Overlapping proposals across the three docs, merged.

| Helper | Where it lives | Replaces | Source IDs |
|---|---|---|---|
| `withTx` (sync-only, IMMEDIATE) | `@orc/db` | Async drizzle transactions, raw BEGIN in batchCreate, three `deleteJob` variants (promote `deleteJobRow`) | A-1, A-2, A-4, A-5, A-19 |
| `findOr404`, `IdParam`, `ErrorSchema`/`errorResponses`, `isoDates`, `PageQuery`/`paged`, `taskRowToDto` | `api/src/lib/route-helpers.ts` | 39 find-then-throw sites, 31 id param schemas, 10 `toDto` date mappers, duplicated `rawToDto`; makes 4xx typed in the SDK | A-11, A-10, A-16 |
| Service layer for task/job/project writes | `task-service`, `@orc/db` | SQL in routes; `task_create` in MCP duplicating the API handler | A-12, R-18 |
| `errorMessage`, `useAction`, `Field`, `ErrorLine`, `FormDialog` | `web/lib/errors.ts`, `components/form/` | 38 `instanceof Error` copies, 73 `setError(`; existing `kb/KbDialogs` helpers promoted app-wide | W-14, W-15, W-23 |
| `useConfirm` on `ConfirmDialog` | web | 8 `window.confirm` calls | W-17 |
| `useResumeInChat`, `SkeletonRows`, `statusTone` | web | Duplicated resume flow, 8 skeleton lists, scattered status color maps | W-16, W-18 |
| `killTree` | `@orc/core/process` (from `api/terminals/spawn.ts:22`) | Executor kill, `hostSpawn` kill, backend `close()`, parser registry, `daemon stop` | R-4 |
| `resolveApiBase` / `resolveApiAuthHeaders` | `@orc/core/api-endpoint.ts` | 8+ resolvers across sdk, mcp, core, cli, agent-runtime, desktop; honours `ORC_API_BASE`, maps `0.0.0.0`/`::` to loopback | R-17, R-26 |
| `session-kit.ts` (`EventChannel`, `spawnJsonLines`, `buildAllowedEnv`) | `agent-runtime` | Event queue copied in 7 backends, 4 stderr policies, 3 kill grace periods, near-duplicate env builders; fixes R-8 and R-15 as a side effect | R-14, R-8, R-15 |
| `runAgentTurn` | `runner/src/agent-turn.ts` | 3 runner copies (job-actions, kb-digest, flow-runner) with throttled activity updates; gateway can reuse | R-16 |
| CLI `run()` and shared `client()` | `cli/src/run.ts` | 4 helper variants, 66 `createOrcClient()` calls, 103 inline `isJson()` checks | R-11 |
| `defineTool` registry | `mcp` | 60+ case switch, unvalidated `args as` casts | R-18 |
| `ignoreError` / `logRejection`, `withRetry`, shared Telegram `formatAndChunk` | `@orc/core`, `gateway` | Silent `catch {}` and floating promises; 429 retries; message truncation | R-25, R-27 |
| `GatewaySessions` | `gateway` | Split ownership of DB rows and live processes; orphaned agents on shutdown | R-20 |

---

## 5. Code flow / structure

### Package cycles

- **task-service and runner** form a cycle hidden behind dynamic `import()` (`transitions.ts:236,244`). Invert with an injected hook registry in task-service that the runner registers at startup, then drop the `@orc/runner` dependency (A-13, R-24, M).
- api and mcp: `@orc/api` is a devDependency of mcp only for one test; move that test to `packages/api` (R-24).
- Turn dynamic imports of already-depended modules into static ones (`api/routes/flows.ts`, `tasks.ts:567`, `mcp/tools.ts:2006-2168`) (R-24, R-18).

### Oversized files, top few

Splits only; do them alongside feature work. Full lists: A-18, W-19, R-23.

| File | Lines | Split |
|---|---|---|
| `mcp/src/tools.ts` | 2254 | Registry plus per-domain files (R-18) |
| `runner/src/flow-runner.ts` | 2091 | `flow/*` modules (store, prompt, apply, start, advance, node-session, drain, sweeps, views) behind a re-export (R-23) |
| `knowledge/src/service.ts` | 2075 | Thin facade over formats, authz, bases, documents, comments, digests, uploads, maintenance, sources (R-23) |
| `core/src/exec-host.ts` | 1350 | ssh argv, master, host-exec, host-fs, ssh-config (R-23) |
| `web/api/client.ts` | 1232 | Per-domain modules behind one barrel, with generated types (W-19, W-21) |
| `web/kb/KbDialogs.tsx`, `views/Skills.tsx`, `views/Jobs.tsx`, `EventRuleEditor.tsx` (796-line component, 29 `useState`) | 800-1020 | W-14/W-15 first, then per-dialog / reducer-based splits |
| `api/routes/knowledge.ts`, `skills.ts`, `chat.ts`, `tasks.ts` | 700-920 | By sub-resource; services (A-18) |
| `db/src/client.ts`, `schema.ts` | 580 / 533 | `ddl.ts` / `migrations.ts` / `client.ts`; per-domain schema (A-18) |

### Schema and SDK drift

- **Hand-typed clients vs OpenAPI (A-14 and W-21, merged).** The SDK has about 79 hand-written types versus 11 from `components["schemas"]` and has already drifted (`Task.agent_model` missing); the web `api/client.ts` has about 24 hand-written response interfaces that duplicate `openapi.gen.ts` and casts every response `as T`. Fix once: name the zod schemas with `.openapi("X")`, derive SDK and web types from `components["schemas"]`, consider `openapi-fetch`, add a CI check that regenerates and diffs `openapi.gen.ts`, replace the SDK's `export *` with explicit subpath exports (repo rule: no barrel re-exports). The same drift applies to R-18 (MCP `task_create` validation differs from the API).
- **`schema.ts` vs `setupDb` (A-15).** `schema.ts` declares `ON DELETE SET NULL` and indexes the runtime tables don't have. Cheapest fix: a test that builds the DB through `setupDb` and compares `PRAGMA foreign_key_list` / `index_list` with `getTableConfig`.
- **Layering (A-12).** Move task/job/project write paths from routes into services so CLI and MCP can share them.

---

## 6. Suggested order (PR-sized batches)

1. **Daemon bug-fix batch (S, runtime):** R-3, R-1, R-2, R-9, R-8, R-22, R-26, R-6 (move entry blocks plus bundle assertion), R-17 (single base resolver). Mostly independent small fixes with tests.
2. **Data integrity (S-M, db/api):** `withTx` (A-1), `batchCreate` (A-2), A-9 error mapping, A-19, then A-5 status-transition guard. Add the A-3 indexes and A-7 trigger in the same or an adjacent PR. A-4's FK-rebuild migration is separate and needs your approval.
3. **Process control (M):** shared `killTree` (R-4), then R-5 batching, R-13 watch debounce and cap, R-12 and R-19 loop fixes, R-21 logger.
4. **Web bundle (S then M):** W-2, W-3 (about -600 KB), then W-1, W-4, W-13; re-measure main via the sourcemap, target under about 800 KB. Include W-20 dead-file cleanup and the W-10 leak fix.
5. **Web data flow (M):** W-11, W-12, W-8, W-6 (with A-10 and server pagination), W-7, then W-5 and W-9. Add W-22 (KnowledgeSettings) and W-21 error handling early in this batch.
6. **Shared helpers (M):** A-11 route helpers and A-12 `$client` swap; web `useAction`/`errorMessage`/`useConfirm` (W-14, W-17, W-16, W-18); `runAgentTurn` (R-16); CLI `run()` and exit codes (R-11).
7. **Agent backends and CLI startup (M):** `session-kit` (R-14, R-15), then R-10 lazy CLI commands and R-30; R-7 KB scan rework.
8. **Structure (M-L, incremental):** task-service/runner hook inversion (A-13/R-24), SDK/web OpenAPI-derived types plus CI diff (A-14/W-21), `schema.ts` vs `setupDb` test (A-15), MCP `defineTool` registry (R-18), then the oversized-file splits as feature work touches them.
