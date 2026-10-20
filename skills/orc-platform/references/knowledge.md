# Memory, knowledge, embeddings and Markdown

Contents: where information belongs; recall/edit; embeddings; repository docs.
Sources: [Knowledge learning](https://github.com/niradler/orc/blob/master/docs/knowledge-loop.md),
[Knowledge bases](https://github.com/niradler/orc/blob/master/README.md#knowledge-bases).

## Choose the store and read narrowly

| Material | Place |
| --- | --- |
| Short durable fact, decision or gotcha | Project memory |
| Reference document, cited lesson or procedure | Knowledge base |
| Reusable instructions that guide agent behavior | Skill |
| Source-owned README, design or usage documentation | Repository Markdown |
| Current progress, attempts or next action | Task/session/handoff |

Length alone does not turn a document into a skill. Keep facts where they are
maintained; do not duplicate code, README content or ongoing progress in memory.
Use the readable project name explicitly. Global scope is for shared material;
cross-project searches need an actual reason.

`context` gives compact project context. Read relevant memories with `memory_read`;
`memory_list({q})` searches names/descriptions. `search` spans tasks, memories and
KBs. For document questions, `kb_search` returns cited passages and `kb_evidence`
returns a bounded evidence pack. Read a `kb:` citation, heading or numbered line
range with `kb_read` before requesting a whole document. Cite the returned
`kb:<document>@<revision>#<passage>` handles. Derived summaries are not independent
corroboration; verify important claims against source documents or current code.

For short fact recall/create/update/history/undo and cross-agent attribution, use
`memory.md`. This reference owns documents and maintained learning.

## Create, ingest and verify a knowledge base

Select the project before creating a KB; global is only for shared material.
Use `kb_manage` action `create` for an authored KB, or these CLI operations for
file intake (replace names/paths with the intended project and source):

```sh
orc kb create Runbooks --project my-app
orc kb add Runbooks ./docs/runbook.md
orc kb sources add Runbooks ./handbook
orc kb docs Runbooks
orc kb status
orc kb search "a known phrase from the runbook"
```

Choose upload for a snapshot, a folder source for periodically refreshed copies,
or `kb_write` for authored Markdown. Verify parsing/index jobs, document identity
and a citation that resolves to expected content. A successful upload is not
proof of indexing or useful search. Inspect source scans and failed jobs before
re-uploading duplicates. CLI file operations use the CLI's filesystem; registered
folders must be reachable on the server/execution host selected by that operation.

The basic parser works without a separate install. For PDFs/images needing richer
layout/OCR, inspect `orc kb docling status`; within scope install through Settings
or `orc kb docling install`, verify readiness, select the appropriate parser and
reparse a representative document. This is a substantial optional download, not
a default prerequisite for Markdown search. Use current help/settings for parser
overrides; inspect extracted text/tables and search results, not just parser exit status.

## Maintain documents

Use `kb_list`/`kb_documents` to identify the intended KB, document and permissions.
`editable_by` applies to the actual call source. Read-only over MCP means comment
for the owner/digest, not retry through another interface to bypass the restriction.

- New authored document: `kb_write` with KB, title, content and a meaningful note.
- Small change: read current numbered lines, then `kb_document` action `edit`
  with exact-text or line edits and `expected_revision`.
- Full rewrite: `kb_write` with `document_id`, current `expected_revision`, content
  and note. Preserve metadata and unrelated content.
- On revision conflict, reread and reconcile; never blindly replay an old write.
- Add `session_id` when supplied and evidence sources for lessons. Do not list
  the document being rewritten as its own derivation source.
- Metadata/path/labels: `kb_document` action `update`; revisions: action `history`;
  restoration: action `restore` with the chosen revision and current
  `expected_revision`. Read the target revision first. Deletes/restores require
  the user's scope and project destructive-operation rules, not an automatic cleanup.

Use `kb_comment` for a correction request or material needing editorial judgment.
Resolve/dismiss with a reply explaining the result. `kb_maintenance` identifies
failed files, stale derived documents and missing links. A KB digest is a scheduled
agent applying that KB's instructions; its full maintenance loop is below.

Folder sources are copies: ORC does not write back to the registered source folder.
An ORC edit detaches that copy from automatic source updates. Choose whether the
user wants the original Markdown changed or only its ORC copy before editing.

## Maintain a living Learnings KB

Recall -> execute/record evidence -> correct short memory facts -> contribute a
cited lesson/comment -> digest consolidates -> next agent retrieves and verifies.
Keep task progress in tasks/sessions, not a second KB task board. Lessons need
sources, conditions and uncertainty; derived summaries are not new corroboration.
Prefer updating the existing lesson to creating overlapping documents. Reconcile
contradictions against current evidence and preserve historical decisions where
conditions differ. No durable learning means no forced document or memory write.

1. Inspect the project's Learnings KB, its `editable_by` and current digest with
   `kb_digest` action `get` / `orc kb digest show Learnings`. Active projects get
   a starter KB/digest, but verify what exists; do not recreate one the user removed.
2. For authorized setup, obtain `kb_digest` action `template`, adapt ownership,
   sources and maintenance instructions, then action `set` with KB, backend and
   manual/cron schedule. CLI: `orc kb digest template`, then
   `orc kb digest set Learnings --backend <backend> --manual --instructions <file>`.
   Choose cron only when recurring agent work is intended; inspect backend readiness
   and use the scheduler host's timezone. An API-only process does not run the scheduler.
3. Within scope use action `run` / `orc kb digest run Learnings`, then action `runs`
   / `orc kb digest runs Learnings`. Scheduled runs can skip when nothing new has
   happened since completion; manual runs always run. Inspect logs/session evidence,
   comments resolved, actual document revisions and `kb_maintenance` stale/failed items.
4. The **assigned digest agent** handles open comments first, stays within its KB,
   attributes writes to its run session and calls `digest_complete` with the supplied
   token and `applied` or `no_change`. A timeout/error/missing completion fails the run
   without advancing its watermark, so the next run repeats input. Ordinary workers
   never invent this token or use digest completion instead of `flow_report`.
5. Diagnose unavailable backend/auth, scheduler, permissions, revision conflict or
   missing completion from the recorded failure. Correct the cause before retrying;
   do not create duplicate schedules or mark undigested evidence complete manually.

The digest has bounded tools; KB settings/permissions and other agents' activation
are not granted by learning instructions. Read-only KBs receive comments for an
authorized maintainer/digest. Keep the same ORC endpoint/project across coding
agents so the next one can retrieve the cited lesson. Verify that retrieval after
maintenance. Persistence, a successful run or a schedule alone does not establish
semantic quality, real-time synchronization or that every native chat was captured.

## Configure and verify embeddings

Embeddings are optional: provider `none` leaves full-text search available.
Supported adapters are `ollama` and `openai` (an OpenAI-compatible embedding API).
Do not confuse the embedding model with the backend used for agent sessions.

1. Inspect `orc kb settings` and `orc kb status`, or Knowledge settings in the
   dashboard. Record provider, model, base URL, pending work and vector-backend
   status, without printing keys. Inspect `env_overrides`: environment wins over
   saved values. Settings changes use the dashboard, CLI or authenticated API;
   MCP deliberately cannot change knowledge settings.
2. Choose an endpoint reachable **from the ORC server**, not merely the browser.
   In Docker, loopback refers to that container. For Ollama ensure the selected
   embedding model is installed and the service is reachable. For a compatible
   API obtain its embedding-capable model and API base URL from its configuration.
3. Save provider, URL and model together. For example, using values already
   verified for that installation:

   ```sh
   orc kb settings --embedding-provider ollama --embedding-url http://127.0.0.1:11434 --embedding-model <installed-embedding-model>
   orc kb settings --embedding-provider openai --embedding-url <provider-api-base-url> --embedding-model <embedding-model>
   ```

   Enter credentials through the dashboard's secret field or a private settings
   request (`PATCH /api/kb/settings`, `embedding.api_key`). The CLI also supports
   `--embedding-key`, but literal keys can leak into shell history/process arguments.
   Never embed credentials in the URL, docs or example commands. Saved keys are
   encrypted; reads report `api_key_set`. Omit a key to retain it; API `null` clears it.
4. Saving a new embedding profile queues re-embedding. Wait for relevant indexing
   jobs, then check `orc kb status`: readiness, pending chunks and actionable errors.
   Upload or use a known document, search a phrase and a semantic paraphrase, and
   verify the returned citation resolves to the expected passage. A saved form or
   successful full-text fallback alone does not prove vectors work.

Failures: `401` suggests provider credentials; `404` suggests API base/model mismatch;
connection errors suggest server-side reachability. Check vector-backend detail and
profile dimensions on mismatch. Inspect failed jobs/parser results if there are no
chunks to embed. Do not repeatedly switch models or wipe the index to hide a failure.
Use current help/schema for tuning batch size, dimensions or timeout only when needed.

## Read and maintain README / Markdown

Find the source-owned document before creating another: README for installation and
quick use, `docs/` for detailed product behavior, project instructions for conventions,
and the existing handoff for ongoing work. Search headings/terms, then read only the
relevant section. In an ORC checkout, prefer local docs matching the code version;
installed skills can use the linked upstream docs but must check runtime compatibility.

Make the smallest complete edit: preserve the document's structure and user-owned
material, update commands/examples and affected links together, and distinguish
implemented behavior from a proposal. Validate referenced paths and CLI/API examples
against current source or help. Reopen the saved file and inspect its diff; run the
repository's Markdown/link checks when present. Do not copy the full README into a
skill or create a new document for every small topic.

For a KB Markdown document use revision-aware KB operations above. For a filesystem
README use filesystem tools in the correct checkout. A KB index is not an editable
mount of the repository, and a skill read does not authorize editing its source.
