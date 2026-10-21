# Knowledge learning loop

ORC records short project memories, keeps knowledge bases (KBs) current with digests, and maintains compact skill instructions. Learning is reused through ordinary search and skill reads; startup context is unchanged and the runner does not inject KB content.

## During and after work

A memory is a short project fact (ports, conventions, gotchas, decisions) identified by `(project, name)`, with a description saying when it matters, content up to `memory.max_content_chars` (default 800) and an optional priority 0-100. Agents check `memory_list` before `memory_create` and `memory_update` an existing memory instead of duplicating it; procedures and long guidance become skills. Every create, update, delete and revert is recorded in `memory_changes` (before/after snapshots, reason, author, native session id) and in the central audit log within one transaction. `memory_history` lists the changes and `memory_revert` restores an earlier state.

At work-unit completion, `orc-sdlc` directs the agent to the delivery section of `references/review-and-delivery.md`. It reviews actual memory changes, corrects contradictions within scope, and records verified reusable lessons in the relevant KB or maintained documentation. No durable learning means no new write. `orc-platform` supplies memory operations in `references/memory.md` and knowledge, embedding and document operations in `references/knowledge.md`. This is agent workflow guidance, not guaranteed review of every session from an external client.

## Ordinary retrieval

- `search` searches KB documents first, then memories and tasks. A KB failure is reported without discarding memory and task results.
- `kb_search`, `kb_evidence` and `kb_read` search and read KBs with `kb:<doc>@<rev>#<n>` citations. `kb_read` also returns one heading's section or a numbered line range.
- `skill_read` and the API/SDK's ordinary skill reads return effective edited instructions for the selected scope. The runner's existing skill injection uses those same effective reads.

MCP uses readable `project` names, defaulting to configured activeProject. `scope: "global"` explicitly selects shared instructions. REST uses `project_id`; absent scope is global. A project skill instruction edit overrides a global edit. Unknown projects fail closed.

## Knowledge base writes and comments

Agents change documents with `kb_write` (create or full rewrite) and `kb_document` (partial edits by exact text or line range, metadata, history, restore, delete), and manage KBs with `kb_manage`, only in KBs whose `editable_by` includes `mcp`. KB access settings cannot be changed over MCP. Every write is a revision with its author, source and session; a stale `expected_revision` is a conflict to reread and reconcile. The central audit log records KB actions; `audit_list` / `GET /api/audit` expose them.

`kb_write` and `kb_document` use `document_id` to target a document. `kb_document` also accepts the legacy `id` alias; if both are supplied they must match. For a new document, omit `path` to generate it from the title, or supply a relative Markdown path ending in `.md` or `.markdown` (case-insensitive).

Comments on a KB or one of its documents ask for a change: a correction, a source to digest, a lesson to record. Anyone may add one (`kb_comment`, `orc kb comment add`, the dashboard). Each comment has an author and source, a status (open, resolved, dismissed) and one closing reply saying what was done or why not.

## Knowledge dashboard and Markdown editing

The **Knowledge** dashboard has Knowledge base and Memories. Memories lists a project's memories by reads, recent activity or priority, with search over name and description, creation, editing, history and revert.

Markdown uses a shared Read / Edit / Split workspace with readable rendering, source search, word wrap, and expansion. Split view stacks vertically on phones. Skills include file tabs and a mobile file picker. Unsaved drafts are protected when closing or switching files, and saves check the original content or document revision to reject stale overwrites. Markdown documents in a KB can be edited in place, including copies of Markdown files from a registered folder; ORC never writes the folder, and an edited copy stops following its file. Uploaded PDFs and Office files are read-only parsed text; replace the file to change them. Built-in skill files remain read-only.

## Digests

Any KB can have a digest: instructions stored with the KB, an agent backend (Claude, Codex, ...) and a schedule. The schedule is an ordinary ORC job (`__orc_kb_digest__:<kbId>`, cron or manual) with normal run history. Set it up in the dashboard with **Add digest**, which starts from a generic template, or with `kb_digest` / `orc kb digest set`. **Run now** (`kb_digest run`, `orc kb digest run`) always runs.

Each active project gets a starter **Learnings** KB with the template, the default backend and a daily `0 3 * * *` digest (03:00 in the scheduler host's time zone). A starter KB the user deleted is not recreated. Run the source daemon (`bun run --filter orc-ai dev-daemon:start`) to run the scheduler during development; an API-only process does not execute scheduled jobs.

A scheduled run is skipped when the digest has completed before and nothing new happened since: no open comments, no memory audit entries and no session summaries in the KB's project. A run claims the KB (one run at a time), opens the backend with an explicit tool allowlist (KB reads and writes, comments, read-only memory, audit and task history, `WebFetch`), and sends the digest's instructions plus up to 100 open comments and the 30 most recent session summaries since the last completed run. Open comments come first. The agent cannot run shell commands, change KB settings or start other digests.

Only `digest_complete` with the run's token marks the run completed and moves the "since" point; a timeout, agent error or missing confirmation fails the run, and the next run repeats the work. Each run is recorded as a worker session with its trace, and completion or failure is audited. Job failures use the scheduler's normal circuit breaker.

What the digest changes is the agent's responsibility; deterministic storage and successful execution do not establish semantic quality or improved performance.

## Edited skills and manual revert

`skill_update` / `PUT /api/skills/{name}/instructions` edit the effective SKILL.md. Supply its full current raw content as `expected_content` to reject stale saves, plus the new content and reason. The frontmatter name must stay unchanged. Edits activate immediately with no evaluation gate or automatic revert.

Instructions are scoped SQLite overlays: original installed SKILL.md, scripts, references and assets stay intact. Native tools reading those original files directly do not receive overlays; ORC API/MCP/SDK/runner skill reads do. Normal upstream file edits do not silently discard a learned instruction overlay.

The two entry points keep learning operational: `orc-platform` covers scoped memory,
KB intake/edit/search, digest setup/results/recovery and cross-agent retrieval;
`orc-sdlc` places recall, task/session evidence and knowledge reconciliation throughout
requirements, implementation, review/rework and delivery. A schedule is not proof of
useful learning: inspect resulting revisions and verify the next agent can retrieve
the cited lesson. Ordinary workers do not call a digest run's completion token.

Retired authored instructions remain stored under their original names. Effective
canonical reads index applicable scoped legacy guidance; managed nodes receive only
their role's authored worker/coder or reviewer supplements plus knowledge review.
Unmodified retired playbooks are not reinjected. New/global/project edits retain
their own identity/revision; conflicts require reconciliation, not a silent rewrite.

The Skills dashboard shows **Mutated**, the date and author, before/after history, and a manual restore action with a required reason. Reverting requires the current mutation ID, retains both versions, and creates an audit entry. `orc skill history <name> [--project-id <id>]` and `orc skill revert <name> <change-id> --expected-change-id <id> --reason "..." [--project-id <id>]` provide the same operation. History older than 90 days is pruned during scheduler maintenance, always retaining the current change and its previous content for revert.

## Validation

Unit/API/MCP tests cover scoping, authentication, conflicts, partial edits, comments, digest claims, completion tokens, failures and idle skips, and skill edit/history/revert. Browser tests cover KB documents and manual revert of effective skill instructions while preserving supporting files. These checks establish the tested mechanics; sustained learning and better real-world outcomes require observations across normal work.
