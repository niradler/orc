# Knowledge learning loop

ORC records short project memories, compiles verified lessons into a wiki, and maintains compact skill instructions. Human KB files are references and are never edited by this loop. Learning is reused through ordinary search and skill reads; startup context is unchanged and the runner does not inject wiki summaries.

## During and after work

A memory is a short project fact (ports, conventions, gotchas, decisions) identified by `(project, name)`, with a description saying when it matters, content up to `memory.max_content_chars` (default 800) and an optional priority 0-100. Agents check `memory_list` before `memory_create` and `memory_update` an existing memory instead of duplicating it; procedures and long guidance become skills. Every create, update, delete and revert is recorded in `memory_changes` (before/after snapshots, reason, author, native session id) and in the central audit log within one transaction. `memory_history` lists the changes and `memory_revert` restores an earlier state.

At work-unit completion, `orc-session` and the worker contract direct the agent to load `orc-memory-review`. It reviews the session's memory changes, keeps each memory short with a description that says when it matters and a priority that reflects its relevance, moves long guidance into skills, merges overlapping memories, and writes a wiki page only for clear root causes or verified procedures. This is agent workflow guidance, not guaranteed review of every session from an external client.

## Ordinary retrieval

- `search` searches wiki summaries first, then memories not absorbed into the visible wiki, and tasks. KB search is a fallback when no wiki/memory result exists; explicitly requesting `knowledge` also includes KB citations. KB failures remain visible without discarding wiki/memory results.
- `wiki_search` and `wiki_index` expose compact results. `wiki_get` loads full content; `wiki_history` loads the retained revisions. `memory_read` still reads an absorbed memory by name.
- `knowledge_search` and `knowledge_get` keep their existing document interface.
- `skill_read` and the API/SDK's ordinary skill reads return effective edited instructions for the selected scope. The runner's existing skill injection uses those same effective reads. There is no new startup wiki index or automatic wiki prompt material.

MCP uses readable `project` names, defaulting to configured activeProject. `scope: "global"` explicitly selects shared pages/instructions. REST uses `project_id`; absent scope is global. A project page hides a global page with the same slug; a project skill instruction edit overrides a global edit. Explicit global reads remain available. Unknown projects fail closed.

## Wiki writes and traceability

`wiki_write` / `POST /api/wiki` require a slug, kind (lesson/procedure/decision/concept), title, short summary, content, sources, change note and `expected_revision` (0 for creation). Stale revisions return a conflict; reload and reconcile rather than overwriting. Cite absorbed memories as `memory:<name>`. Sources identify supporting records; a citation alone does not prove the lesson's claim.

Each write retains author, source session and complete immutable content in revision history. The central audit row points at the revision. `audit_list` / `GET /api/audit` expose knowledge actions; `memory_history` / `GET /api/memories/{name}/history` hold prior memory states. The **Wiki** dashboard opens on **What ORC learned**, with Pages/search and Audit log alongside it. Page details show sources and revision history; reload preserves selection. All Projects/Unassigned show global lessons; select a project for its lessons with global fallback.

## Knowledge dashboard and Markdown editing

The **Knowledge** dashboard includes Search, Memories, and Collections. Memories lists a project's memories by reads, recent activity or priority, with search over name and description, creation, editing, history and revert. Wiki remains a separate view for now.

Markdown uses a shared Read / Edit / Split workspace with readable rendering, source search, word wrap, and expansion. Split view stacks vertically on phones. Skills include file tabs and a mobile file picker. Unsaved drafts are protected when closing or switching files, and saves check the original content or Wiki revision to reject stale overwrites. Human Knowledge files can be edited manually when their registered collection resolves to one unambiguous existing UTF-8 `.md` or `.markdown` source no larger than 2 MiB; symlink and binary sources remain read-only. Successful file saves refresh the collection index. Wiki edits retain revision history and sources, and built-in skill files remain read-only.

## Daily digest

Installation seeds one enabled `orc-knowledge-digest` cron job using the existing Jobs scheduler. Its default expression is `0 3 * * *` (03:00 in the scheduler host's time zone); change it in Jobs like any other cron. Run the source daemon (`bun run --filter orc-ai dev-daemon:start`) to run the scheduler during development; an API-only process does not execute scheduled jobs.

The job checks active projects and global knowledge. A project with no new memory audit entries or session summaries starts no agent. Changed projects run sequentially through the existing agent backend, using the `orc-wiki` skill and a compact input. Full related memory/wiki/KB content is fetched only as needed. Digest sessions are tracked as workers, have a ten-minute deadline within the configured overall job timeout, and get an explicit knowledge-tool allowlist. Unstarted scopes retain their watermarks when the job budget expires. They do not run shell commands or create maintenance tasks.

Per-project watermarks use SQLite row IDs, so changes in the same second are not lost. Claims are leased across processes. Only an authenticated `digest_complete` with the assigned unexpired token advances the captured watermark; failures, missing confirmation and expired tokens retain work for retry. Writes arriving after capture are reviewed on a later run. Input batches are bounded (100 memory actions and 30 session summaries); larger backlogs are processed across runs. Completion/failure is audited. Job failures use the scheduler's normal circuit breaker; inspect/re-enable a failed job after correcting its error.

The digest merges duplicates, compiles useful lessons, flags stale/contradictory/wiki-link issues, references outdated KB files, and updates skills when warranted. This is an agent responsibility; deterministic storage and successful execution do not establish semantic quality or improved performance.

## Edited skills and manual revert

`skill_update` / `PUT /api/skills/{name}/instructions` edit the effective SKILL.md. Supply its full current raw content as `expected_content` to reject stale saves, plus the new content, reason and supporting wiki pages. The frontmatter name must stay unchanged. Edits activate immediately with no evaluation gate or automatic revert.

Instructions are scoped SQLite overlays: original installed SKILL.md, scripts, references and assets stay intact. Native tools reading those original files directly do not receive overlays; ORC API/MCP/SDK/runner skill reads do. Normal upstream file edits do not silently discard a learned instruction overlay.

The Skills dashboard shows **Mutated**, the date and author, before/after history, and a manual restore action with a required reason. Reverting requires the current mutation ID, retains both versions, and creates an audit entry. `orc skill history <name> [--project-id <id>]` and `orc skill revert <name> <change-id> --expected-change-id <id> --reason "..." [--project-id <id>]` provide the same operation. History older than 90 days is pruned during digest maintenance, always retaining the current change and its previous content for revert.

## Validation

Unit/API/MCP tests cover scoping, authentication, conflict/rollback, absorbed-memory retrieval, edit/history/revert, digest claims, expiry, retries and idle skips. Browser tests save/reload/read wiki revisions and manually revert effective skill instructions while preserving supporting files.

Local probe: `bun --env-file .env .claude/scripts/validate-knowledge-loop.ts`. It uses an isolated DB and source API on 7711, triggers the ordinary cron scheduler, runs one actual Claude digest, retains its pages/audit/session report, and verifies an idle run starts no agent. It requires existing Claude credentials and can incur model charges. These checks establish the tested mechanics; sustained learning and better real-world outcomes require observations across normal work.
