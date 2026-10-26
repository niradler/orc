# Code quality review: runtime packages

Scope: `packages/{core,agent-runtime,gateway,runner,knowledge,mcp,cli,desktop}` (non-test sources, about 37k lines). Review date 2026-10-26, at master `642e52a`. This was a read-only review: no source was edited and no servers were started.

## Summary

Four kinds of problem stand out:

1. **Daemon availability bugs that look like performance issues.**
   - One error permanently stalls the task loop (R-3).
   - Telegram handles updates one at a time, so permission buttons can never be answered during a turn (R-1).
   - Telegram has no error handler, so one thrown error stops the bot (R-2).
   - Job timeouts kill `sh` but not its children, so runs hang and keep holding concurrency slots (R-4).
2. **Background work that wastes resources.**
   - Every 60 s, all folder knowledge-base sources are re-read and re-hashed with synchronous I/O (R-7).
   - Each live flow node runs its own 5 s sweep over every flow (R-12).
   - The rule poller re-runs table setup (DDL) every 2 s (R-19).
   - The logger does three synchronous file operations per log line (R-21).
   - Command jobs can buffer up to 200 MB of output in memory (R-5).
3. **Missing shared building blocks, so the same logic is copied and the copies drift.**
   - The event-queue, JSON-lines, stderr and kill code is copied across 7 agent backends, and the copies already differ in behaviour (R-8, R-14, R-15).
   - The "run an agent turn with a timeout" code exists in 3 copies in runner (R-16).
   - The API base-URL resolver exists in 8 or more copies (R-17).
   - CLI commands use 4 different error/output helpers (R-11).
   - MCP has a switch with 60+ cases, and `task_create` duplicates the API handler (R-18).
4. **The #111 hazard is still in the bundled CLI.**
   - Two `import.meta.main` blocks that use top-level await make 18 bundled module initialisers async.
   - In the bundle, the `@orc/mcp` barrel still calls its child initialisers without awaiting them. It only works today because of import order (R-6).
   - CLI startup is about 290 ms, against about 80 ms for a CLI that loads only the task command, because every command eagerly loads api, runner, gateway, knowledge and claude-agent-sdk (R-10).

**Quick wins** (S effort, High or Med impact): R-1, R-2, R-3, R-5, R-6, R-8, R-9, R-12, R-13, R-17, R-19, R-21, R-22, R-26.

## Prioritized findings

| ID | Title | Category | Impact | Effort | Files |
|---|---|---|---|---|---|
| R-1 | Telegram handles updates one at a time, so permission buttons deadlock until timeout | Correctness | High | S ⚡ | gateway/src/telegram.ts, manager.ts, agent-runner.ts |
| R-2 | No `bot.catch`: one thrown error stops the Telegram bot for good | Correctness | High | S ⚡ | gateway/src/telegram.ts |
| R-3 | Task loop stalls permanently if `job_runs` insert throws | Correctness | High | S ⚡ | runner/src/task-loop.ts |
| R-4 | No shared process-tree kill: job timeouts and agent `close()` leave orphans | Perf/Correctness | High | M | runner/src/executor.ts, core/src/exec-host.ts, agent-runtime/*, cli daemon.ts |
| R-5 | Command jobs buffer up to 200 MB, then one giant INSERT | Performance | High | S ⚡ | runner/src/executor.ts |
| R-6 | #111-class async-module hazard still in the bundled CLI | Correctness | High | S ⚡ | mcp/src/index.ts, knowledge/src/parsers/worker.ts, api/src/routes/mcp.ts |
| R-7 | Knowledge-base folder sources fully re-read and re-hashed every 60 s, synchronously | Performance | High | M | knowledge/src/service.ts |
| R-8 | `claude.ts`/`acpx.ts` lose exit/auth errors and report success | Correctness | High | S ⚡ | agent-runtime/src/claude.ts, acpx.ts |
| R-9 | Agent/task text put into Telegram HTML without escaping | Correctness | High | S ⚡ | gateway/src/agent-runner.ts, manager.ts, direct.ts |
| R-10 | CLI startup loads the whole platform for every command | Performance | High | M | cli/src/index.ts, commands/*, agent-runtime/src/claude-sdk.ts |
| R-11 | CLI exits 0 on API errors, `--json` errors print `[object Object]`, 4 helper variants | Reuse/Correctness | High | M | cli/src/commands/*.ts |
| R-12 | Every live flow node starts its own 5 s timeout sweep over all flows | Performance | Med | S ⚡ | runner/src/flow-runner.ts |
| R-13 | Watch jobs: no debounce, no concurrency cap; manual/watch can overlap cron | Perf/Correctness | High | S ⚡ | runner/src/watcher.ts, executor.ts, scheduler.ts |
| R-14 | Session plumbing duplicated across 7 agent backends | Reuse | Med | M | agent-runtime/src/*.ts |
| R-15 | `send()` race: previous turn's cleanup ends the new turn | Correctness | Med | S | agent-runtime/src/claude-sdk.ts, agentapi.ts |
| R-16 | "Agent turn with timeout" copied 3× in runner; DB write per streamed event | Reuse/Perf | Med | M | runner/src/job-actions.ts, kb-digest.ts, flow-runner.ts |
| R-17 | 8+ API base-URL/secret resolvers; SDK ignores `ORC_API_BASE` and breaks on `::` | Reuse/Correctness | High | S ⚡ | sdk/src/client.ts, mcp, core, cli, desktop |
| R-18 | MCP: switch with 60+ cases, unvalidated `args as` casts, `task_create` drifted from API | Reuse/Flow | Med | L | mcp/src/tools.ts, kb-tools.ts |
| R-19 | Rule poller re-runs DDL + PRAGMA every 2 s; rule actions run strictly one at a time | Performance | Med | S ⚡ | runner/src/rule-actions.ts, scheduler.ts |
| R-20 | Gateway session ownership is split: processes orphaned, `activeSessions` leaks | Flow/Leak | Med | M | gateway/src/direct.ts, agent-runner.ts, manager.ts |
| R-21 | Logger does `existsSync` + `statSync` + `appendFileSync` on every log line | Performance | Med | S ⚡ | core/src/logger.ts |
| R-22 | One-shot jobs more than 24.8 days out fire immediately; callback has no try | Correctness | Med | S ⚡ | runner/src/scheduler.ts |
| R-23 | Oversized files (top 15) and suggested splits | Code flow | Med | L | see section |
| R-24 | Package dependency cycles hidden behind dynamic imports | Code flow | Med | M | task-service, runner, mcp, api |
| R-25 | Errors swallowed silently, plus floating promises | Best practice | Med | S | many (listed) |
| R-26 | Desktop overwrites the user's whole `config.json` on a parse error | Correctness | Med | S ⚡ | desktop/src/main.ts |
| R-27 | Smaller correctness items (short IDs, Windows daemon stop, Codex half-start, prompt in argv, chunking) | Correctness | Med | S–M | various |
| R-28 | N+1 queries in drain/reconcile; corpus loaded twice at startup | Performance | Low-Med | S | runner/src/flow-runner.ts, knowledge/src/service.ts |
| R-29 | Type casts on raw SQL; typed `query<Row,Params>` not used | Best practice | Low | S | runner, knowledge |
| R-30 | Compiled binary re-installs embedded skills on every launch | Performance | Low | S | cli/src/bin-entry.ts, core/src/builtin-skills.ts |

⚡ = quick win.

---

## R-1 Telegram handles updates one at a time, so permission buttons deadlock until timeout ⚡

**Evidence**
- grammY processes polled updates one at a time: `node_modules/grammy/out/bot.js:191-195` (`// handle updates sequentially (!)` … `await this.handleUpdate(update)`).
- The message handler awaits the whole agent turn: `telegram.ts:178` `await dispatch(...)` → `manager.ts:402` `await this.runAgentTurnWithPreview` → `agent-runner.ts:213` `await ctx.permissionManager.waitFor(requestId)`.
- The Allow/Deny `callback_query` is the *next* update, so it is only processed after the current turn ends. The turn cannot end until the button is answered, so the permission sits until its 30-minute timeout (`permission-manager.ts:1`) and is then denied.
- Every other chat is blocked meanwhile, and the "still processing" reply (`manager.ts:397`) can never be sent.

**Why it matters:** human-in-the-loop over Telegram does not work for any tool that needs approval.

**Fix:** dispatch without awaiting the turn. Serialise per chat with the existing `SessionLock` instead of per bot: `void dispatch(msg).catch(logError)`. Alternatively use `@grammyjs/runner` with `sequentialize(ctx => ctx.chat?.id)`, which still lets callback queries through.

## R-2 No `bot.catch`: one thrown error stops the Telegram bot for good ⚡

**Evidence**
- `telegram.ts` never registers `bot.catch`. grammY's default error handler (`bot.js:93-99`) logs "No error handler was set!", calls `this.stop()` and rethrows.
- The rethrow lands on `void bot.start(...)` (`telegram.ts:216`) as an unhandled rejection.
- The handlers at `:138` and `:178` don't catch anything (only the callback handler at `:198` does). `handleIncoming` can throw from `sendText`, from `adapter.send(thinkingMsg)` (`manager.ts:442`), or from a failing fallback send (`:552`).

**Fix:** `bot.catch((err) => logger.error("telegram handler", redactObject(err)))`, plus a try/catch inside a shared `safeDispatch()` that both handlers use.

## R-3 Task loop stalls permanently if `job_runs` insert throws ⚡

**Evidence:** `runner/src/task-loop.ts:146-166`.
- `cycleRunning = true` is set at :146. `jobs.findFirst` and `db.insert(job_runs)` then run *before* the `try` at :168.
- `finally { cycleRunning = false }` only covers the `try`.
- If either call throws (for example SQLITE_BUSY), every later cycle hits the guard at :141 and returns, logging only at debug level.

**Why it matters:** no flows start until the daemon restarts, and nothing is visible at info level.

**Fix:** set the flag immediately before `try` and move the lookup and insert inside it.

Related, in the same file: `triggerTaskCheck` (`:236-247`) drops triggers that arrive while a cycle is running, so a status change waits up to `poll_interval_minutes` (default 5). Add a `rerunRequested` flag and run once more from `finally`.

## R-4 No shared process-tree kill: job timeouts and agent `close()` leave orphans

**Evidence**
- `runner/src/executor.ts:121-131` spawns `["sh","-c",job.command]` with `kill: () => local.kill()`.
- It then awaits `Promise.all([readStream(stdout), readStream(stderr), proc.exited])` (`:200-204`). Grandchildren inherit the pipes, so after a timeout kill the readers never finish.
- The run stays `running` and keeps a `max_concurrent_jobs` slot (`rule-actions.ts:330`). A stuck rule action also leaves `draining=true` (`rule-actions.ts:282`), which blocks every later rule action.
- The timeout is set twice: Bun's `timeout`/`killSignal` and a manual `setTimeout`. No `windowsHide`, no `AbortSignal`.
- `core/src/exec-host.ts:832-835`: the local agent kill is `proc.kill()`. Codex runs as `[node, codex.js]` (`codex.ts:39`) and acpx as `[node, cli.js]` (`acpx.ts:234`), so on Windows the real agent survives `close()` and idle reaping.
- `cli/src/commands/daemon.ts:291`: `process.kill(pid,"SIGTERM")` is an immediate terminate on Windows, so the shutdown hooks (`stopGateway`, `stopWatchers`, `removePid`) never run.
- A correct implementation already exists: `api/src/terminals/spawn.ts:22` `killProcessTree` (`taskkill /F /T` on Windows, process group on POSIX).

**Fix:** move it to `@orc/core/process` as one shared helper:

```ts
export async function killTree(proc: Subprocess, graceMs = 5000): Promise<void>
// POSIX: kill(-pid, SIGTERM) → wait graceMs → kill(-pid, SIGKILL)   (spawn with detached/process group)
// win32: taskkill /T /PID → wait → taskkill /F /T /PID
```

- Use it in the executor, `hostSpawn`'s local kill, all backends' `close()`, the knowledge parser registry (`knowledge/src/parsers/registry.ts:129`), and `daemon stop` (send the existing IPC `orc-shutdown` first).
- After a kill, race the stream readers against a short grace period and `reader.cancel()` them.

## R-5 Command jobs buffer up to 200 MB, then one giant INSERT ⚡

**Evidence:** `runner/src/executor.ts:135` `MAX_STREAM_BYTES = … 100 * 1024 * 1024` per stream.
- Each line is kept in `stdoutLines`/`stderrLines` *and* in `logEntries`.
- Everything is written in one call: `db.insert(job_run_logs).values(logEntries)` (`:214`).
- Only 64 KB of stdout is stored on `job_runs` anyway (`:223`).
- With 4 parameters per row, a large run may also exceed SQLite's bound-parameter limit and lose the whole write. This is unconfirmed for Bun's SQLite build; a test would settle it.

**Fix:** flush `job_run_logs` in batches of about 500 rows while streaming. Keep only a capped ring for the tail. Lower the cap to 1–5 MB, configurable.

## R-6 #111-class async-module hazard still in the bundled CLI ⚡

**Evidence**
- `mcp/src/index.ts:5-8` and `knowledge/src/parsers/worker.ts:47` both have `if (import.meta.main) … await …`.
- In the bundle, Bun turns `import.meta.main` into `if (false)` but still marks those modules (and everything that imports them) as async `__esm` initialisers. A test build of the CLI with the package's own build flags shows 18 async initialisers: knowledge, kb-tools, tools, the mcp server and barrel, and the api `mcp`, `mcp-tool`, `rules`, `server` and `runtime` modules.
- The bundled `@orc/mcp` barrel initialiser still runs `init_server3(); init_tools();` **without await**, which is exactly the #111 bug.
- `api/src/routes/mcp.ts:5` still imports that barrel. It only works because `mcp-tool.ts` happens to await `init_tools()` earlier in the same `Promise.all`.
- Related fragile patterns:
  - `cli/src/index.ts:90` and `daemon.ts:275` start the server as a side effect of `await import("@orc/api")`, whose entry is itself a top-level await (`api/src/index.ts:3`).
  - `kb.ts:15` imports the `@orc/knowledge` barrel, which puts a top-level `await init_src6()` into the CLI entry.

**Fix**
- Move both `import.meta.main` blocks into dedicated entry files (`mcp/src/main.ts`, `knowledge/src/parsers/worker-main.ts`) and point `registry.ts:93` at the new one.
- Import `@orc/mcp/server` and `@orc/mcp/meta-tools` directly. AGENTS.md already says "no barrel re-exports", and `index.ts` re-exports with `export *`.
- Replace side-effect imports with an explicit `startApi()` export.
- Add a `validate:package` assertion that fails when the bundle contains `__esm(async`.

## R-7 Knowledge-base folder sources fully re-read and re-hashed every 60 s, synchronously

**Evidence:** `knowledge/src/service.ts:278` runs `setInterval(() => this.maintain(), MAINTENANCE_INTERVAL_MS)` (60 s). `maintain` → `scanAllSources` (`:1960`) → `scanSource` (`:1756`), which does:
- `new Bun.Glob(...).scanSync` (`:1772`)
- `statSync` (`:1801`), `readFileSync` (`:1803`) and `sha256(bytes)` (`:1838`) for up to `MAX_SOURCE_FILES = 5000` files
- `SELECT ${DOC_COLUMNS}`, including `content`, for every known document (`:1762`)

**Why it matters:** this runs on the daemon's event loop, which is shared with the API server and SSE. A large source causes a stall every minute and up to 5000 × `max_upload_bytes` of reads.

**Fix**
- Persist `mtime_ms` and `size` per external document and only read and hash when either changes.
- Use async `Glob.scan()` and `Bun.file().bytes()` with a yield between files.
- Don't select `content` in this query.
- Optionally use chokidar (already a runner dependency) for change events, keeping the periodic scan as a slow reconcile (for example every 15 min).

## R-8 `claude.ts`/`acpx.ts` lose exit/auth errors and report success ⚡

**Evidence**
- `agent-runtime/src/claude.ts:191-195`: `void readLines(stdout, …).then(() => this.handleEof())`. `handleEof` sets `done = true` (`:216`). `watchExit` then returns early at `:303` (`if (this.state.hasReceivedResult || this.done) return;`).
- stdout usually closes before `exited` resolves, so auth errors and non-zero exits are never reported.
- `acpx.ts:333-345` is worse: `handleEof` synthesises an empty `result`, and `watchExit` returns at `:352`.
- `gateway/agent-runner.ts:246` then reports `"(no output)"` as success.
- `claude.ts:284` also ignores `msg.is_error`.
- `codex.ts:262` already does it correctly: `await Promise.all([this.outputDrained, this.errorsDrained])` before deciding.

**Fix:** use the codex pattern in both, ideally via the shared `spawnJsonLines` helper from R-14.

## R-9 Agent/task text put into Telegram HTML without escaping ⚡

**Evidence**
- `gateway/src/agent-runner.ts:193` builds `` `<b>Tool:</b> … <code>${command.slice(0,200)}</code>` `` and sends it with `parseMode:"html"`.
- Same problem at `manager.ts:593` (`input.title`, `summary`) and `direct.ts:213,224,230,305,375,490` (task title/body, job and project names, cwd).
- `escapeHtml` exists (`direct.ts:69`) but is only used for memories. `telegram.ts:38` `_escapeMd` is unused.
- A command like `2>&1` makes Telegram reject the message ("can't parse entities"). The turn throws and the permission is never answered.

**Fix:** move `escapeHtml` into a shared `gateway/src/format.ts` and use it in a small builder (`html\`...\`` tagged template that escapes interpolations). Escape first, then slice, so an entity is never cut in half.

## R-10 CLI startup loads the whole platform for every command

**Evidence**
- `cli/src/index.ts:6-21` statically imports every command module, and those pull in the heavy packages:
  - `daemon.ts:12-23` imports `@orc/api/lifecycle`, `@orc/gateway` and `@orc/runner`.
  - `doctor.ts:1` imports `@orc/agent-runtime`. `agent-runtime/src/claude-sdk.ts:2` statically imports `@anthropic-ai/claude-agent-sdk` (an external), so the bundle cannot even start without it.
  - `kb.ts:15` imports the `@orc/knowledge` barrel for two symbols.
  - `rules.ts:10-12` imports `@orc/db`.
- Measured: the bundle is 7.94 MB and `orc --help` takes about 290 ms. A bundle with only commander and the task command is 0.32 MB and takes about 80 ms. Bare `bun` takes 44 ms.
- Knock-on cost: in the bundled build, each KB parse spawns the full CLI (`knowledge/src/parsers/registry.ts:102`, `[execPath, Bun.main, PARSER_WORKER_COMMAND, …]`), so ingest pays the startup cost per file.

**Fix:** lazy command registration.

```ts
const lazy = (load: () => Promise<{ register(cmd: Command): void }>) => …
program.command("daemon").description(...).action(async (...a) => (await import("./commands/daemon.js")).run(...a));
```

- Keep thin SDK-only commands (task, mem, job, project) static, and dynamic-import `@orc/api`, `@orc/runner`, `@orc/gateway`, `@orc/knowledge` and `@orc/agent-runtime` inside their actions.
- In `claude-sdk.ts`, make `query`/`HOOK_EVENTS` lazy (`:624` already dynamic-imports the SDK).
- Import `@orc/knowledge/worker` (already exported) for the parser worker.
- Give the parser worker its own small entry (see R-6) so it doesn't boot the CLI.

## R-11 CLI exits 0 on API errors, `--json` errors print `[object Object]`, 4 helper variants

**Evidence**
- 64 `return console.error(...)`, 35 `if (error)` and 66 `createOrcClient(` sites across `cli/src/commands/*.ts`.
- `task.ts` and `job.ts` never set `process.exitCode`, so scripts and agents can't detect failure (for example `job.ts:23,147,204`).
- `task.ts:49,128,146,164,191,219,237,254,376` do `jsonErr(String(error))` where `error` is `ApiError {error, code}` (`sdk/src/types.ts:461`), which prints `{"error":"[object Object]"}`.
- Four competing helpers:
  - `mem.ts:20` `unwrap` (exits)
  - `kb.ts:33,38` `fail`/`unwrap`
  - `attention.ts:7` `unwrap` (throws)
  - `rules.ts:16` `output` (throws)
- `isJson()` is checked inline at 103 sites.

**Fix:** one `cli/src/run.ts`.

```ts
export async function run<T>(call: Promise<ApiResult<T>>, render: (d: T) => void, toJson: (d: T) => unknown = (d) => d) {
  const r = await call;
  if (r.error) { isJson() ? jsonErr(r.error) : console.error(`Error: ${r.error.error}`); process.exit(1); }
  isJson() ? jsonOut(toJson(r.data)) : render(r.data);
}
```

Also share a module-level `client()` instead of 66 `createOrcClient()` calls.

## R-12 Every live flow node starts its own 5 s timeout sweep over all flows ⚡

**Evidence**
- `runner/src/flow-runner.ts:1405-1409`: `setInterval(() => void sweepFlowTimeouts()…, 5000)` inside `driveNodeSession`.
- `sweepFlowTimeouts` (`:1882-1929`) selects all running runs, then for each run:
  - one `taskIdForRun` query
  - takes the task lock
  - one `awaiting_human` query
  - one `loadRun` (definition JSON plus 4 state blobs parsed)
- With K live nodes and R running flows, that is about K×R×4 queries and K×R definition parses every 5 s. The sweeps queue behind node reports on the same lock, and there is no reentrancy guard.

**Fix:** one module-level sweeper (`flow/sweeps.ts`), ref-counted on the first and last live session, guarded by an `inFlight` flag. Fetch `SELECT id, task_id, started_at, paused_secs, definition->>'$.limits.execution_timeout_secs'` in a single query and filter overdue runs in SQL before calling `loadRun`.

## R-13 Watch jobs: no debounce, no concurrency cap; manual/watch can overlap cron ⚡

**Evidence**
- `runner/src/watcher.ts:40-41` calls `triggerWatch` → `executeJob` on every `add`/`change` event. `awaitWriteFinish` only waits for each single file to finish writing; it does not merge events.
- `max_concurrent_jobs` is only enforced in `rule-actions.ts:333`. The executor's cron, one-shot, watch and manual paths never check it.
- `Cron({ protect: true })` (`scheduler.ts:187`) only prevents cron-on-cron overlap.
- Copying 1000 files into a watched folder spawns 1000 `sh` processes.

**Fix**
- Per-job debounce (about 1 s), merging paths into `ORC_WATCH_PATHS`.
- A per-job in-flight `Map<jobId, Promise>` with a "one follow-up queued" policy.
- Enforce `runner.max_concurrent_jobs` inside `executeJob`, with one semaphore for all triggers.

## R-14 Session plumbing duplicated across 7 agent backends

**Evidence**

| Concern | Copies |
|---|---|
| Event queue (`eventQueue`/`push`/`resolveNext`/`async *events()`) | `claude.ts:208-212,357-368`, `codex.ts:275-279,296-307`, `claude-sdk.ts:171-175,541-552`, `acpx.ts:309-313,437-446`, `a2a.ts:66-70,194-203`, `agentapi.ts:180-195`, `codex-app.ts:83-87,577-586`. The "set done + wake reader" sequence appears about 20 times, and R-8 and R-15 are bugs in these copies. |
| JSON lines | `claude.ts:191-194` and `codex.ts:184-187` both use `try { handle(JSON.parse(line)) } catch {}`, which also hides exceptions thrown by the handler. `models.ts:117-133` re-implements line splitting instead of using `io.ts` `readLines`. |
| stderr capture | Four different policies: a 200-line ring (`claude.ts:199`), a 100-line ring (`codex.ts:192`), an unbounded string plus one debug log per line (`acpx.ts:424`), and `"ignore"` (`codex-app.ts:406`, so Codex auth errors are never shown). |
| Grace period then kill | 8 s (`claude.ts:375-390`, `codex.ts:313-327`), 3 s (`codex-app.ts:590-597`), immediate (`acpx.ts:459`). |
| Environment allow-list | `buildClaudeEnv` (`claude.ts:60-88`) and `buildCodexEnv` (`codex.ts:48-79`) are near copies. |

**Fix:** add `agent-runtime/src/session-kit.ts`.

```ts
export class EventChannel<T> {            // single owner of queue/resolve/done
  push(e: T): void; end(err?: Error): void; async *iterate(): AsyncGenerator<T>;
  nextGeneration(): number;               // R-15: drop pushes from stale turns
}
export function spawnJsonLines<M>(host: ExecHost, argv: string[], o: {
  onMessage(m: M): void; onBadLine?(l: string, e: unknown): void;
  stderrTail?: number; graceMs?: number; env?: Record<string,string>;
}): { proc; drained: Promise<void>; exit: Promise<{code:number; stderr:string}>; close(): Promise<void> };
export function buildAllowedEnv(allow: string[], prefixes: string[], extra?: Record<string,string>);
```

- `exit` resolves only after both streams have drained, the way `codex.ts:262` does it.
- `close()` uses `killTree` (R-4).
- Each backend then only maps its message types to `AgentEvent`.

## R-15 `send()` race: previous turn's cleanup ends the new turn

**Evidence**
- `claude-sdk.ts:200-208`: `send()` aborts the old controller, resets `done=false` and starts a new `driveQuery`. When the old `driveQuery` unwinds, it sets `this.done = true` (`:506`), which ends the new turn's `events()`. Late events from the old turn go into the new queue.
- `agentapi.ts:71-74` has the same race: its `finally` (`:169-176`) pushes a synthetic `result` into the new turn.

**Fix:** `const gen = channel.nextGeneration()` per turn. `push` and `end` ignore calls from a stale generation (built into `EventChannel` from R-14).

## R-16 "Agent turn with timeout" copied 3× in runner; DB write per streamed event

**Evidence**
- `runner/src/job-actions.ts:82-160` and `runner/src/kb-digest.ts:177-239` are near-identical: an `expired` flag, a timeout promise, `Promise.race([work(), timeout])`, close in `finally`, trace slicing.
- `flow-runner.ts:1387-1495` (`driveNodeSession`) is a third variant.
- `kb-digest.ts:186` closes with `void session?.close()` and no catch.
- `job-actions.ts:110-112` and `kb-digest.ts:206-208` run `UPDATE gateway_sessions SET last_activity_at=…` on **every** event (text deltas arrive many times a second). `flow-runner.ts:43-56` already has a throttled `touchSessionActivity` (5 s).

**Fix:** `runner/src/agent-turn.ts`.

```ts
export async function runAgentTurn(o: { backend; opts; prompt; timeoutMs; sessionId?; signal?: AbortSignal;
  onEvent?(e: AgentEvent): void; onPermission?(...) }): Promise<{ text; trace; timedOut; error? }>
```

It owns the AbortController, the timeout, the throttled activity updates and a safe close. All three callers, and the gateway's `runAgentTurn` (`gateway/src/agent-runner.ts`), can use it.

## R-17 8+ API base-URL/secret resolvers; SDK ignores `ORC_API_BASE` and breaks on `::` ⚡

**Evidence:** independent resolvers in:
- `sdk/src/client.ts:215-216`
- `mcp/src/api-client.ts:5-9,24`
- `mcp/src/tools.ts:940-947`
- `core/src/human-request-client.ts:15`
- `core/src/rule-builtin.ts:24`
- `cli/src/commands/schema.ts:6-27`
- `cli/src/commands/session.ts:38-61,197-201` (`authHeaders()` copy-pasted from schema.ts)
- `agent-runtime/src/orc-mcp.ts:45`
- `desktop/src/main.ts:26-41`, which parses `config.json` itself

They disagree on three things:
- **`ORC_API_BASE`:** `exec-host.ts:247` sets it for SSH-hosted agents to the tunnel address, but the SDK builds `http://${config.api.host}:${config.api.port}` and ignores it. `orc task …` run by a remote agent therefore goes to the wrong port.
- **Bind-address mapping:** the SDK does not map `0.0.0.0`/`::` to loopback (`mcp/src/api-client.ts:7` and `exec-host.ts:168` do), so `host: "::"` gives `http://:::7700`.
- **Secret trimming:** `configuredApiSecret` is used in only some of them.

**Fix:** `@orc/core/api-endpoint.ts` exporting `resolveApiBase(config = loadConfig())`, which handles `ORC_API_BASE`, maps the bind address to loopback and brackets IPv6, plus `resolveApiAuthHeaders()`. Make every site above call it.

## R-18 MCP: switch with 60+ cases, unvalidated `args as` casts, `task_create` drifted from API

**Evidence**
- `mcp/src/tools.ts` has 49 tools and `kb-tools.ts` has 11.
- Dispatch is 6 `if (name === …)` blocks plus a 42-case `switch` (`tools.ts:829-2180`); `kb-tools.ts` adds 21 more cases.
- 35 cases use `args as {...}` (for example `:1025,1149,1207-1232`). They are safe only because `server.ts:120` and `api/routes/mcp-tool.ts:47` validate first.
- `api/src/rule-builtins.ts:124-138` calls `executeTool("context"|"session_snapshot"|…)` directly and skips that validation.
- `task_create` (`tools.ts:1207-1257`) runs its own `db.insert(tasks)` and `triggerTaskCheck`, a copy of `api/src/routes/tasks.ts:452-491`. It has already drifted: the API uses `title: z.string().min(1).max(500)` (`tasks.ts:82`), MCP uses `title: z.string()` (`tools.ts:306`).
- 11 direct `getDb`/`getSqlite` uses in `tools.ts`.
- 8 dynamic imports of static modules (`tools.ts:2006-2168`, for example `await import("@orc/core/flow-service")`). They hide the dependency graph (R-24) and add bundle-ordering risk (R-6).
- The input schemas are already Zod (`server.ts:33`, `meta-tools.ts:67`). The duplication is in validation and handlers, not JSON schema.

**Fix**
- A registry, `defineTool({ name, description, input: z.object(...), run(input: z.infer<…>, ctx) })`, one file per domain (`tools/task.ts`, `tools/memory.ts`, `tools/flow.ts`, `tools/session.ts`, `tools/kb.ts`).
- `executeTool` becomes lookup → `input.parse(args)` → `run`, so validation lives in one place for every transport.
- Move `CreateTaskSchema` and `createTask()` into `@orc/task-service` and derive the MCP input with `.omit({project_id}).extend({project})`.

## R-19 Rule poller re-runs DDL + PRAGMA every 2 s; rule actions run strictly one at a time ⚡

**Evidence**
- `runner/src/scheduler.ts:28-30` runs `setInterval(() => void drainRuleActions(), 2000)`.
- `rule-actions.ts:19` constructs `new RuleStore(db)` on every tick. Its constructor runs `installRules` (`db/src/rules.ts:70-72`): 4 × `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX` and `PRAGMA table_info` (`rules.ts:32-53`).
- `loadConfig()` (`rule-actions.ts:281`) sits outside the try, behind a bare `void`.
- `drainRuleActions` awaits `executeJob` while holding `draining`, so actions run one at a time whatever `max_concurrent_jobs` says.

**Fix**
- Call `installRules` once in `startScheduler`/`reconcileRuleActions` and keep a module-level store.
- Wrap the whole tick in try.
- Claim up to `max_concurrent_jobs - running` actions per tick and run them without awaiting inside the lock.
- Longer term, replace the 2 s poll with a notify from the rule-event producer (in-process `EventEmitter`) and keep the poll at about 30 s as a safety net.

## R-20 Gateway session ownership is split: processes orphaned, `activeSessions` leaks

**Evidence**
- `gateway/src/direct.ts` owns the DB session rows. `agent-runner.ts:56` `activeSessions` owns the live processes.
- `/session stop` (`direct.ts:427-434`) only writes `status:"stopped"`.
- `/agent` and `/session new|switch` never call `closeAgentSession`. Its only caller is the auth-error path (`manager.ts:562`).
- `manager.stop()` (`:157-162`) stops the adapters but not `activeSessions`, so running agents become orphan processes at shutdown.
- `/session mode` (`direct.ts:463`) only changes the DB row; `setPermissionMode` is never called on the live session. The profile wrapper in `agent-runtime/src/session-factory.ts:85-101` doesn't pass it through either.
- `manager.ts:81,199`: `pendingSessionApprove` is only ever added to, never read.
- `manager.ts:455-463`: the typing `setInterval` starts before `await updateGatewaySession` (`:460`) and outside the `try`. If the update throws, the interval runs every 4 s forever.

**Fix:** a `GatewaySessions` class that owns the DB row and the process together, with `open`/`switch`/`stop`/`setMode`/`closeAll`. Direct commands call it, and `manager.stop()` calls `closeAll()`. Start the typing interval inside the `try` and clear it in `finally`. Delete `pendingSessionApprove`.

## R-21 Logger does `existsSync` + `statSync` + `appendFileSync` on every log line ⚡

**Evidence:** `core/src/logger.ts:56-80`. `writeToFile` calls `rotateIfNeeded` on every line: `existsSync(filePath)`, `statSync(filePath).size`, then `appendFileSync`. That is three blocking syscalls per log line on the daemon thread. `acpx.ts:424` logs one debug line per stderr line, so a chatty agent multiplies this.

**Fix**
- Stat once at open and track `bytesWritten` in memory; only re-stat when the count crosses `MAX_FILE_BYTES`.
- Write through a `Bun.file(path).writer()` (FileSink) with periodic `flush()`, flushing on exit.
- Keep `appendFileSync` only for `error` and `fatal`, so they survive a crash.

## R-22 One-shot jobs more than 24.8 days out fire immediately; callback has no try ⚡

**Evidence:** `runner/src/scheduler.ts:226-236` computes `delayMs = Math.max(0, runAt - Date.now())` and calls `setTimeout(async () => …, delayMs)`. Delays above 2³¹−1 ms are clamped to about 1 ms, so the job runs immediately. The callback's `db.query.jobs.findFirst` is outside any try, so a DB error becomes an unhandled rejection.

**Fix:** a `setLongTimeout(fn, ms)` helper that re-arms in steps of at most 2³¹−1 (or a croner one-shot with a `Date`). Wrap the callback body in try/catch.

## R-23 Oversized files (top 15) and suggested splits

| Lines | File | Suggested split |
|---|---|---|
| 2254 | mcp/src/tools.ts | Registry plus one file per domain (R-18) |
| 2091 | runner/src/flow-runner.ts | See below |
| 2075 | knowledge/src/service.ts | See below |
| 1350 | core/src/exec-host.ts | `ssh/argv.ts` (quoting, sshArgv, 196-346), `ssh/master.ts` (ControlMaster lifecycle, 347-691), `host-exec.ts` (hostExec/hostSpawn, 692-906), `host-fs.ts` (read/list/stat/mkdir, 953-1305), `ssh-config.ts` (1309+) |
| 733 | cli/src/commands/kb.ts | `kb/bases.ts`, `kb/docs.ts`, `kb/sources.ts`, `kb/digest.ts`, after R-11 removes the boilerplate |
| 726 | mcp/src/kb-tools.ts | Folds into the registry (R-18) |
| 688 | gateway/src/manager.ts | `GatewaySessions` (R-20), `turn-preview.ts`, `attention-scan.ts` |
| 681 | agent-runtime/src/claude-sdk.ts | Hooks/permissions mapping vs the session driver; shrinks with R-14 |
| 641 | core/src/skill-service.ts | Fine for now |
| 628 | core/src/kb.ts | Fine for now |
| 602 | agent-runtime/src/codex-app.ts | JSON-RPC client (`rpc.ts`) vs session; shrinks with R-14 |
| 562 | gateway/src/direct.ts | One module per command group (`/task`, `/job`, `/session`, `/mem`) behind a command table |
| 555 / 546 | core/src/flow.ts, flow-engine.ts | Pure and well-tested; leave as is |
| 546 | agent-runtime/src/acpx.ts | Shrinks with R-14 |

**`runner/src/flow-runner.ts`.** It already has section banners. Keep `flow-runner.ts` as a re-export so `task-loop.ts` and `api` imports keep working:

| Module | Lines | Contents |
|---|---|---|
| `flow/live-sessions.ts` | 24-73 | |
| `flow/store.ts` | 74-215 | Rows, `loadRun`, `saveState`, `parseJson` |
| `flow/task-lock.ts` | 216-251 | |
| `flow/prompt.ts` | 252-595 | |
| `flow/apply.ts` | 596-878 | |
| `flow/start.ts` | 879-1041 | |
| `flow/advance.ts` | 1042-1201 | Report and infer outcome |
| `flow/node-session.ts` | 1202-1632 | |
| `flow/drain.ts` | 1633-1735 | |
| `flow/interventions.ts` | 1736-1876 | |
| `flow/sweeps.ts` | 1877-1997 | Home for R-12 |
| `flow/views.ts` | 1998-2091 | |

**`knowledge/src/service.ts`.** Keep `KnowledgeService` as a thin facade over:

| Module | Lines |
|---|---|
| `formats.ts` | 87-134, 2016-2075 |
| `authz.ts` | 302-354 |
| `bases.ts` | 355-478 |
| `documents.ts` | 479-915 |
| `comments.ts` | 916-1037 |
| `digests.ts` | 1038-1254 |
| `uploads.ts` | 1255-1438 |
| `maintenance.ts` | 1485-1672, 1977-2015 |
| `sources.ts` (home for R-7) | 1673-1976 |

## R-24 Package dependency cycles hidden behind dynamic imports

**Evidence** (from `package.json` workspace dependencies and the source imports):
- **`@orc/runner` ↔ `@orc/task-service`.**
  - runner imports task-service statically (`flow-runner.ts:20`, `orc-task-provider.ts:9`).
  - task-service declares `@orc/runner` and reaches back with `await import("@orc/runner/flow-runner")` and `import("@orc/runner/task-loop")` (`task-service/src/transitions.ts:236,244`).
  - So the status-transition service needs the flow engine and the flow engine needs the transition service. The dynamic import only hides the cycle from the bundler; it is still an async edge of the kind behind R-6.
- **`@orc/api` ↔ `@orc/mcp`.** api depends on mcp. `mcp/package.json:31` lists `@orc/api` as a devDependency, and only `mcp.test.ts` uses it. That is harmless at runtime but makes workspace builds order-sensitive.
- **Dynamic imports of modules that could be static:** `api/src/routes/flows.ts:352,403,417,433` and `tasks.ts:567` dynamic-import `@orc/runner/flow-runner`, which api already depends on statically. The same applies to `mcp/src/tools.ts:2006-2168` (R-18).

**Fix:** invert the task-service → runner edge with an injected hook.

```ts
// task-service
export const transitionHooks = { onExternalStatus: async (_id, _s, _a) => {}, onTaskFreed: () => {} };
// runner/src/index (at startScheduler/startTaskLoop)
transitionHooks.onExternalStatus = onTaskStatusChangedExternally; transitionHooks.onTaskFreed = triggerTaskCheck;
```

Then remove `@orc/runner` from task-service's dependencies and turn the api/mcp dynamic imports into static ones. Move the mcp test that needs `@orc/api` into `packages/api`.

## R-25 Errors swallowed silently, plus floating promises

| Location | Problem |
|---|---|
| `runner/src/flow-runner.ts:155-161` | `parseJson` returns the fallback on corrupt JSON, so `loadRun` (`:177-180`) treats a corrupt `active`/`joins` as empty. The run later halts as `stalled` with no trace of the cause. Log the row id. `knowledge/src/catalog.ts:102-108` is a duplicate silent `json()`; share one helper in core. |
| `flow-runner.ts:662,850` | `catch { // Unique index … }` swallows *every* error. Match `/UNIQUE constraint/` and rethrow the rest. |
| `knowledge/src/jobs.ts:109` | `this.execute(...).finally(...)` stored without `.catch`. If `finish`/`markFailed` throws (for example `JSON.parse(doc.warnings)` at `:167`), the rejection is unhandled. |
| `gateway/src/slack.ts:219` | `void handleEnvelope(...)` with no catch: bad JSON or a failing listener becomes an unhandled rejection. |
| `agent-runtime/src/orc-mcp.ts:77` | `cleanup: () => void removeHostFile(...)`: an unhandled rejection over SSH. |
| `kb-digest.ts:186` | `void session?.close()` with no catch. |
| `claude.ts:191-194`, `codex.ts:184-187` | `catch {}` around `JSON.parse` *and* the handler, so handler bugs vanish. |
| `gateway/manager.ts:145,160`, `human-requests.ts:55`, `slack.ts:140`, `preview-manager.ts:123`; `watcher.ts:31,54`; `flow-runner.ts:62,1434,1481`; `mcp/tools.ts:1612`; `cli daemon.ts:139,192,205,234`; `core/logger.ts:66,79` | Bare `catch {}` / `.catch(() => {})`. Close paths should at least log at debug level. Errors in the attention scan and in adapter stop should log at warn. |

**Fix:** add `ignoreError(ns, label)` (logs at debug level) and `logRejection(ns, label)` helpers in `@orc/core/logger`. They make intentional swallowing explicit and searchable, and a Biome `noEmptyBlockStatements` rule then catches regressions.

## R-26 Desktop overwrites the user's whole `config.json` on a parse error ⚡

**Evidence:** `desktop/src/main.ts:26-32`. `readConfig()` returns `{}` on any error, and `persistSecret()` (`:43-49`) then writes `{api:{secret}}` over the file. One syntax error in a hand-edited config wipes every setting. `:35` `Number(process.env.ORC_API_PORT)` can also be `NaN`.

**Fix:** return `{}` only on `ENOENT`. On a parse error, back the file up and refuse to write. Read the port through `loadConfig` / `resolveApiBase` (R-17).

## R-27 Smaller correctness items

- **Short task IDs** (`cli/src/commands/task.ts:12`, used 9 times): `tasks.list({limit:100})` then `endsWith`. Older tasks are "not found", API errors are dropped, and an ambiguous suffix silently picks the first match. Resolve on the server, or page through and reject ambiguous matches.
- **Codex app-server half-start** (`agent-runtime/src/codex-app.ts:402-463`): `this.child` is set before `initialize`/`thread/start`. If setup fails, the child keeps running and the next `send()` skips setup (`:366`) with `threadId` undefined. Kill the child and reset it in a catch.
- **Prompt on argv** (`claude.ts:157-158`, `acpx.ts:387`): Windows limits the command line to about 32 KB, so long prompts fail. If the binary resolves to a `.cmd` shim (`acpx.ts:235` fallback), cmd.exe parses the arguments; injection is not confirmed for Bun's `.cmd` handling. Codex already uses stdin (`codex.ts:177-181`); do the same.
- **Message length** (`telegram.ts:228,242,255`; `preview-manager.ts:5,96`): messages are cut at 4096 characters and the final answer at 3000 + "…", so longer replies are lost. Slack ignores `parseMode` (`slack.ts:259-268`) and shows raw `<b>`. Add a shared `formatAndChunk(text, platform)`.
- **No retry on 429:** neither adapter retries sends that hit a rate limit (grammY auto-retry is not installed; `slack.ts:157-174`). Slack's first `connect()` (`:251`) is not covered by its own reconnect backoff (`:234-249`, the only backoff implementation in scope). Add one `withRetry({retries, baseMs, maxMs, retryOn})` in core and use it for both.
- **Unquoted systemd `ExecStart=${bin}`** (`cli/src/commands/daemon.ts:157`): breaks on paths with spaces.
- **Secrets:** the Telegram file URL contains the bot token (`telegram.ts:73`), and fetch errors are logged raw at `:158,171`. `redactSecrets` already matches Telegram tokens (`gateway/src/redact.ts:17`) but is only applied at `manager.ts:107,174`. Redact centrally in the logger's `safeStringify`.

## R-28 N+1 queries in drain/reconcile; corpus loaded twice at startup

- `drainPendingNodesUnlocked` (`flow-runner.ts:1691-1734`) runs, per pending node: `runningWorkerCount()`, `getTask`, `projectMaxWorkers`, `runningWorkerCount(project)`, `loadRun` (a full definition parse) and `runningNodesInFlow`. Join task, project and run in the initial query, count running workers once, and decrement in memory.
- `knowledge/src/service.ts:1599-1609` `reconcile()` selects `content` for every document to check projections of authored ones, and runs twice at daemon start (`knowledge/src/instance.ts:16,30`, `start({maintenance:false})` then `start({maintenance:true})`). Select content only for `origin='authored'`, and make `start` idempotent.

## R-29 Type casts on raw SQL; typed `query<Row,Params>` not used

Plain `as Type` casts: `flow-runner.ts` 42, `knowledge/service.ts` 37, `index-db.ts` 13, `search.ts` 9; almost all are `.get(...) as Row | null`. `bun:sqlite` supports `db.query<Row, Params>()`, already used in `rule-actions.ts`, which also type-checks the bound parameters.

Other notable casts:
- 7 `adapter as GatewayAdapter & Supports*` casts in `gateway/manager.ts` after `"x" in adapter` checks. Replace them with type guards (`hasTyping(a): a is …`).
- Unchecked `JSON.parse(...) as T` in `agentapi.ts:122,139,156`, `slack.ts:80,85,107` and `a2a.ts:116`. Parse these with a small Zod schema.
- `as any`: only 3 in scope, all in `telegram.ts`.

## R-30 Compiled binary re-installs embedded skills on every launch

`cli/src/bin-entry.ts:20-21` calls `installEmbeddedSkills(SKILL_ASSETS)` on every invocation, including `--help`. `core/src/builtin-skills.ts:12-24` base64-decodes, hashes, runs `mkdirSync` and `readFileSync` and compares every file. Check a `.complete` marker keyed by the bundle hash first, or install lazily on the first API or skills use.

---

### Checked and found fine

- Gateway `RateLimiter` and dedupe maps expire entries; `SessionLock` releases in `finally`; `PermissionManager` timers are cleared.
- The task-loop cron is guarded against re-entry. Starting a flow twice for one task is prevented (re-checked under the task lock, `flow-runner.ts:908`). `drainPendingNodes` is serialised, and nodes are claimed with a conditional UPDATE.
- The knowledge job runner claims jobs atomically and backs off; it polls every 10 s when idle.
- `loadConfig()` is cached in memory.
- There is no `shell: true` anywhere in scope, and SSH argv is quoted (`exec-host.ts:196-219`).
- Desktop has no polling apart from a 250 ms startup loop (`desktop/src/daemon.ts:57-76`), and its supervised daemon child exits with its parent (`core/src/process-supervisor.ts:8-11`).
- MCP input schemas are already Zod (`z.toJSONSchema`), not hand-written JSON.
