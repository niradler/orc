# Coding session archive, remote sync and retrieval

Status: implemented in this feature checkout; use the selected installation's
schemas/help to confirm its version includes these operations. Archive sync and
native continuation are two separate user outcomes. The design rationale below
also records limits and future improvements; it is not permission to deploy.

## Sync local histories for offline retrieval

Use this when asked to upload this project's sessions, all Claude sessions or a
selected collection to remote ORC. The completed outcome is searchable history in
**Sessions → Archived sessions**, available while the PC is offline. **Show ended
is selected by default**; explicitly hiding ended sessions also hides the archive.
Archival creates neither a native agent process nor a worktree.

1. Select the intended ORC installation and existing project(s). Call
   `session_sync({projects:["my-app"]})` for one/more requested projects, or
   `session_sync({})` for an all-project history request. It returns a private,
   one-hour sync grant with covered projects. Pass the result to the helper via
   `--grant-stdin` or a private JSON file with `--grant-file`; do not print its URL,
   put it in argv/history or commit the grant file. The main API secret is not needed.
   For hosted ORC behind a TLS proxy, preserve the external `Host` and set
   `X-Forwarded-Proto: https`; grants and signed script downloads then use the
   externally reachable HTTPS origin. Do not expose the internal API port publicly.
   For a single project, use
   its readable name and the local cwd. For an all-agent/history request, discover
   remote projects and use their configured Git remote identities or a small
   explicit cwd/repository-to-project JSON map. Unmapped histories stay local and
   are reported; do not guess a project from a directory basename.
2. Use trusted `scripts/sync-sessions.py` from the orc-platform root. Do not read
   its full source. If absent locally, call
   `skill_read({name:"orc-platform",ref:"scripts/sync-sessions.py",download:true,project})`,
   download the signed bytes privately and verify the supplied SHA-256/size. Run
   `python scripts/sync-sessions.py --help` for current flags. Downloading does not
   execute the script. A configured standalone client may alternatively use
   `ORC_API_BASE` and `ORC_API_SECRET` from its secure environment, never literal argv.
3. Preview with `--dry-run`, then sync the requested scope. Examples using the
   private grant JSON returned to the connected agent:

   ```sh
   python scripts/sync-sessions.py --grant-file /private/sync-grant.json --project my-app --cwd /local/repo --dry-run
   python scripts/sync-sessions.py --grant-file /private/sync-grant.json --project my-app --cwd /local/repo
   python scripts/sync-sessions.py --grant-file /private/sync-grant.json --agent claude --project-map /local/project-map.json
   python scripts/sync-sessions.py --grant-file /private/sync-grant.json --agent codex --project my-app --session-file /local/rollout.jsonl
   ```

   For Windows, quote a cwd such as `"C:\Projects\my-app"`. A map is an object
   such as `{"C:\\Projects\\my-app":"my-app","https://github.com/org/repo":"another-app"}`.
   `--project` explicitly assigns every selected session to that project; combine
   it with `--cwd` for a project-only request. For collections spanning projects,
   prefer remote matching/mapping. `--root` overrides a native root for one agent;
   `--exclude` is repeatable. Default Claude discovery uses `CLAUDE_CONFIG_DIR/projects`;
   Codex uses `CODEX_HOME/sessions` and `archived_sessions`, with normal home fallbacks.
4. Inspect per-session outcomes and final counts. Nonzero exit means failed,
   unmapped or conflicting items need attention; successful items remain stored.
   Repeat the command after correcting those items. The script persists a stable
   source UUID and receipts under `~/.orc`, verifies unchanged receipts against the
   remote manifest, retries transient requests and uploads changed snapshots only.
   It extracts native identity, parent/version, cwd, available repository/branch/commit
   and timestamps; it does not invent a historical commit from today's checkout.
   A changing file is retried later, and an unfinished last JSONL line is held back.
5. Verify Sessions for the selected project, search a known transcript phrase and
   open the saved history. The archive API exposes lexical index revision, pending
   embedding chunks and errors separately. Use `--reindex` to resend a snapshot and
   retry its index without duplicating the archive session. No local ORC database
   or SSH connection from the server to the PC is required.

Native bundles are bounded to 64 MiB per encoded request and 128 files. Claude
subagent sidecars are included; configuration, credentials, SQLite databases and
repository files are not uploaded. Large collections use bounded concurrency and
per-session checkpoints; a single file over the limit is reported, not split into
an invalid native session. Resumable multipart uploads are future work.

## Move a session and continue on ORC

Use this when the user wants to close the PC and continue the work on the ORC
execution host. The outcome is a **running resumed terminal**, not just stored
history or a Ready badge. Keep the source idle during the final transfer.

- For a currently local session, follow [execution.md](execution.md)'s handoff:
  within the user's Git authorization commit/push the intended code, verify its
  exact remote SHA, call `session_handoff`, then use trusted
  `scripts/upload-session.py` with the single-use upload URL. Use its instructions
  and `--help`; full script inspection is for debugging/untrusted code.
- For an already archived session, use its **Prepare and resume in terminal**
  action. Supply/verify the pushed repository, branch and commit where history
  lacks them. The server uses the existing handoff import/checks and keeps the
  archive revision and handoff link. Preparation copies history to a new native ID
  and pinned worktree; the source archive remains intact.
- After status is `ready`, an agent completing a move-and-continue request calls
  authenticated `POST /api/terminals` with `{kind:"claude"|"codex",live_session_id}`
  and verifies the returned terminal/cwd/host. The UI action performs this launch
  automatically. Do not stop at upload acceptance or Ready when continuation was
  requested. Destination agent credentials/dependencies must already be available;
  ignored files and running local processes are not transferred.

## Settings and retrieval APIs

Settings → Knowledge has **Search coding sessions with embeddings**, off by
default. It uses the existing configured embedding provider. Enabling also indexes
discovered Claude/Codex sessions already assigned to projects on the selected host;
**Index discovered sessions** can index those histories manually without vectors.
The existing native metadata/ripgrep search and paged transcripts remain available.
Uploads additionally have a persistent server-side keyword index, so fallback
does not depend on the original PC. Provider failures/pending vectors are visible.

| Operation | API |
| --- | --- |
| Mint scoped connected-agent sync grant | `POST /api/sessions/archive/sync` |
| Upload one snapshot | `POST /api/sessions/archive/upload` |
| Compare up to 100 origins | `POST /api/sessions/archive/manifest` |
| List/search bounded hits | `GET /api/sessions/archive?q=...&project_id=...&limit=20&offset=0` |
| Index discovered project histories | `POST /api/sessions/archive/index` |
| Metadata, revisions and handoff links | `GET /api/sessions/archive/{id}` |
| Pinned conversation page | `GET /api/sessions/archive/{id}/transcript?revision=1&offset=0&limit=100` |
| Resolve a passage | `GET /api/sessions/archive/{id}/passage?revision=1&ordinal=0` |
| Original native bundle | `GET /api/sessions/archive/{id}/export?revision=1` |
| Prepare native continuation | `POST /api/sessions/archive/{id}/resume` |

Normal installation API authentication applies. Remote hosting must configure a
secret and HTTPS. The grant's private `/api/session-sync/<token>` base permits only
its scoped project listing, manifest checks and uploads; it cannot read transcripts,
mint grants or launch terminals. An expired grant needs a new `session_sync` call;
reruns retain the local origin/receipts and do not duplicate acknowledged history.
Upload includes required readable `project`, stable `source_id`,
`agent`, native `session_id`, `title`, `metadata` and the existing version-1 native
`bundle`. Optional `expected_revision` rejects stale writers; verified identical or
older prefixes remain no-ops. A conflict returns HTTP409 with its retained revision;
it never replaces current history. Do not blindly retry divergence as an overwrite.

MCP `session_sync` supplies the uploader capability. `session_search` returns bounded cited passages; `session_read` fetches a pinned
passage or message page. Citations are `session:<archive-id>@<revision>#<ordinal>`.
The SDK provides archive search/upload/index/read/passage/resume under `sessions`.
Search returns at most three passages per session; no whole history is included.
Current archive list/search pagination uses limit/offset, not snapshot cursors.

The remaining sections explain the architecture and future scale decisions.

## Identity, updates and retrieval guarantees

The origin key is (source installation ID, agent, native session UUID), independent
of filename, cwd and project labels. The uploader persists its installation UUID;
reinstallations should retain it. A copy from another PC has a different origin
unless the operator explicitly uses the same source ID. A native ID alone never
merges unrelated sessions. Original native files remain untouched.

- Identical canonical records: return the same archive ID/revision; no re-embedding.
- Verified extension of every existing file's ordered records: advance the same
  archive to a new immutable revision and reuse unchanged chunk embeddings.
- Older verified prefix: stale/no-op; never truncate current history.
- Divergence, rewritten records, missing earlier sidecars or an incompatible
  expected revision: retain the conflicting snapshot, return HTTP409 and leave
  the canonical head intact. Conflicting replay is idempotent. Resolve explicitly;
  no timestamp-based concatenation or last-write-wins.
- Native continuation creates a new session ID; an archive-to-handoff relation
  preserves its source revision. It never rewrites the archived original.

Each revision records raw native files in private blob storage alongside the
knowledge root. Metadata/revision pointers live in orc.db. Lexical chunks and
vectors use a separate rebuildable session index, sharing the existing KB index
implementation and provider/profile cache. Lost indexes rebuild from originals;
unfinished embedding work resumes from durable pending chunks. Indexing and
search never execute historical tool calls or trust transcript instructions.

Passages are turn-aware, split at 1,600 characters after the existing bounded
transcript normalization, and include Claude sidecar locators. Raw exports retain
the uploaded native text rather than the bounded display projection. Search groups at most three cited passages
per session, with separate pinned revision/message-page reads. Model/profile
changes backfill compatible vectors; provider failure preserves keyword results.
Embedding batches are internal provider requests, not whole-document results.

Native metadata/ripgrep search remains available alongside archive retrieval.
KB search still returns document metadata and cited passages, with kb_read for
more context and kb_evidence for token-budgeted evidence. It is also top-k,
not cursor-paginated. Archive pagination currently uses bounded limit/offset;
concurrent updates can reorder pages. Snapshot cursors, resumable part uploads,
retention/garbage collection and interactive conflict-resolution tooling are
future improvements, not claims about the current implementation.

## Operational boundaries

Require HTTPS and configured API authentication for remote hosting. Existing
shared API-secret access is installation access, not per-user tenant isolation.
Select explicit project scope for retrieval. Session text can contain private
code or secrets: exclude/redact at the source as needed, and enable external
embeddings only with a provider approved for that text. Credentials/config and
agent databases are never selected as native session inputs.

Uploads count actual streamed bytes, enforce format/identity/path limits, and
never write to uploader-supplied filesystem destinations. Failed network retries
and stale snapshots cannot replace current data. Check storage/index/provider
states separately. A searchable archive without available code or destination
credentials remains readable/exportable; it is not automatically resumable.

Verify both outcomes proportionally: repeat/increment/conflict/recovery tests for
archive sync; then a real browser flow from saved history through pinned Git
preparation to a terminal with the expected host/cwd and native session. Local
isolated E2E evidence does not establish a hosted production deployment or a
successful paid model turn.
