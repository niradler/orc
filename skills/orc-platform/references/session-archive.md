# Coding session archive, remote sync and retrieval

Status: design proposal, checked against this checkout on 2026-10-23. The bulk
archive/upload and semantic session APIs below are not implemented. Use current
runtime schemas/help before operating an installation. This reference explains
the intended process and how it differs from the existing handoff.

Contents: current behavior; upload/sync; identity and revisions; retrieval;
resume; scale/security; implementation and acceptance criteria.

## What exists today

| Capability | Current behavior |
| --- | --- |
| Discover coding sessions | Agent adapters/watchers upsert native session metadata from the selected execution host. `POST /api/sessions/live/sync` triggers discovery; it does not upload files from the caller's computer. |
| Session identity | Watcher matches live chat marker, backend, native session ID and execution host. A matching record is updated. This does not define cross-device archive identity. |
| Session search | `GET /api/sessions/live/search?q=...&limit=...` matches title/summary/cwd and uses ripgrep over configured transcript roots. Returns ranked session metadata and up to three short transcript snippets per file. Default limit 100, maximum 500; no search cursor or embeddings. Transcript matches must map to discovered session records. |
| Read conversation | `GET /api/sessions/live/{id}/transcript?offset=0&limit=100` returns a page of parsed turns, total, offset and optional query match indexes. Limit is at most 500. Pagination bounds output; the handler still reads the bounded transcript file before parsing. |
| Transfer for resume | `POST /api/session-handoffs` initiates a Claude/Codex handoff. A single-use upload capability accepts a bounded native bundle, then preparation creates a worktree and a new native session UUID. See [execution.md](execution.md). This is not a bulk archival API. |
| KB search | `kb_search` retrieves indexed chunks, groups hits by document and returns document metadata plus up to three cited passages, including passage text and a short snippet. Default 10 documents, maximum 50. It has a top-k limit, not cursor pagination. |
| Optional embeddings | KB `auto` mode uses hybrid lexical/vector search when a provider is configured, otherwise lexical. Provider failure falls back to lexical and reports degradation. Configuring embeddings does not currently embed coding sessions. |

The MCP unified `search` currently combines knowledge, memories and tasks. The
dashboard command-palette `/api/search` also searches stored session summaries;
that is separate from native transcript search and is not semantic session search.

KB passages carry `kb:<document>@<revision>#<ordinal>` citations. Read more with
`kb_read` by citation, heading or line range; request a whole document only when
needed. `kb_evidence` assembles a token-budgeted passage pack (default 6,000,
maximum 32,000 approximate tokens) with document references and omissions.
KB chunking targets 1,600 characters with a 2,400-character packing/splitting
threshold; semantic search ranks chunks, not whole documents. Embedding workers
send pending chunks in provider-sized batches. Those internal embedding batches
are different from result pages and retrieved passages.

Source map in the ORC repository:

- `packages/api/src/session-watcher.ts`, `sessions/search.ts`, `routes/sessions.ts`
- `packages/api/src/routes/session-handoffs.ts`, `packages/core/src/session-handoff.ts`
- `packages/knowledge/src/{chunker,embeddings,jobs,search}.ts`, `packages/core/src/kb.ts`
- `packages/mcp/src/tools.ts`, `packages/api/src/routes/search.ts`

## Recommended local-to-remote process (to implement)

Keep the archive on the central ORC server, independent of its current execution
host. A lightweight local uploader reads explicitly selected native agent homes;
it needs API access, not a local ORC database or an SSH-accessible PC. Initially
support Claude Code and Codex, then add adapters for other formats.

1. Select the authenticated HTTPS ORC installation and required project mapping. Preview
   discovered files, session counts and bytes; allow project/date/agent exclusions.
   Do not infer remote projects solely from local cwd strings. Use explicit mapping
   and credential-free repository identity. For v1, every remote upload must name an
   existing authorized ORC project. Ask once per batch, split mixed-project batches,
   and keep unmapped sessions local until the user assigns them. Native discovery
   may still contain unassigned sessions; this requirement applies to remote ingest.
2. Read a consistent snapshot of complete native records. An incomplete final JSONL
   line remains pending for the next scan. Record agent/parser version, stable
   source installation ID, native session ID, optional parent ID, source timestamps,
   cwd, repository/branch/commit when known, counts, bytes and SHA-256 hashes.
   Keep source timestamps distinct from server receipt time. Paths are metadata.
3. Exchange a bounded manifest with the server. The response says unchanged,
   upload required, stale or conflict per session and returns the current revision
   and verified checkpoint. A local size/mtime checkpoint speeds scans; server-side
   content verification determines correctness. Renames must not duplicate sessions.
4. Upload only missing snapshots or validated append segments using scoped,
   expiring upload capabilities. Large uploads need resumable parts with checksums,
   expiry and finalization; retrying a part or finalization is idempotent. The server
   streams to private staging, validates actual sizes/format/identity/hashes, then
   atomically publishes a revision. Interrupted uploads never replace current data.
5. Persist raw native files and a normalized, ordered message representation with
   lossless raw locators. Queue lexical indexing and, when configured, embeddings.
   Report stored/lexical-ready/embedding-pending/ready/failed separately; accepting
   bytes is not evidence of search readiness. A provider outage must not block storage
   or lexical retrieval. Enabling a provider later queues existing eligible sessions.
6. Save per-session acknowledgments locally after successful finalization. Continue
   other sessions after individual failures; retry transient failures with bounded
   backoff. Periodic sync is opt-in. Source disappearance does not delete the archive.

Proposed API responsibilities, not callable endpoint names: manifest negotiation,
bounded upload/part/finalize, ingest status, session search, revision-aware message
range reads and raw export. Define Zod/OpenAPI contracts and generate SDK callers
before documenting concrete commands. Do not loop the existing handoff helper to
archive a directory: it creates native sessions/worktrees and has no sync protocol.

## Stable identity and safe updates

Use a server-assigned archive session ID and a unique origin key:
`(owner namespace, source installation ID, agent, native session ID)`.
The owner namespace is the authorization boundary of the installation, not a claim
that ORC currently implements multi-tenancy. Source IDs must survive uploader
restarts; project, filename, cwd and timestamps are not identity keys.

Copied sessions from a different installation initially have a different origin.
An explicit verified origin alias or a trusted transfer lineage can associate them
with the same archive session. A matching UUID alone must not merge unrelated data.
Content hashes can deduplicate immutable storage within an authorized namespace;
identical content does not prove the same session, and hashes must not leak existence
across owners. Keep project association separate from content identity/access.

| Incoming data | Action |
| --- | --- |
| Same origin and identical canonical content hash | No-op; return the same archive ID/revision; do not embed again. |
| Same origin, existing ordered records are a verified prefix | Publish the extended revision under the same archive ID; preserve prior revisions; index changed/new chunks. |
| Older snapshot that is a verified prefix of current data | Report stale/no-op; never truncate newer history. |
| Same origin but changed earlier records, compaction, truncation or divergent tails | Preserve both revisions as conflict/branch evidence; require explicit resolution before replacing the canonical head. Do not concatenate by timestamp or last-write-wins. |
| Concurrent uploads based on the same revision | Compare-and-swap the head using expected revision/hash; an identical retry succeeds, an older prefix is stale, otherwise return conflict. |
| Same content, different origin/session | Share eligible blob storage if useful, retain separate session identities unless verified lineage establishes an alias. |
| Resume/copy creates a new native ID | Record parent/source archive revision and destination identity; treat new execution history as a child, not an overwrite of the original. |

The current entry should advance when verified new messages arrive, but blindly
overwriting the old file risks losing history to late retries. Use immutable revisions
and an atomic current pointer. Stable native message IDs are preferred; where absent,
retain ordered record hashes/occurrence positions so repeated identical messages are
not collapsed. Checkpoint append uploads against the prior record/hash boundary.
Metadata-only changes do not require recomputing unchanged message embeddings.

## Retrieval contract for sessions and KBs

Return bounded relevant passages with stable source references first. Fetch nearby
messages/sections or the complete source separately. A result page is a collection
of hits; a chunk is an indexing unit; a passage is the returned evidence. None
requires returning the full document or transcript by default.

For sessions, normalize role/time/text/tool relationships, then chunk around turns
and message ranges. Keep tool calls linked to results, bound huge outputs and use
limited overlap. Preserve raw evidence separately; summaries can assist ranking
but cannot replace the transcript. Share provider/profile, lexical/vector fusion
and citation conventions with KBs without making every session a user KB document.

Proposed session hit shape (illustrative; citation syntax is not implemented):

```json
{
  "session_id": "archive-id",
  "revision": 4,
  "agent": "codex",
  "title": "Repair callback forwarding",
  "score": 0.032,
  "matched_by": ["lexical", "semantic"],
  "passages": [{
    "citation": "session:archive-id@4#chunk-17",
    "message_range": {"start": 38, "end": 44},
    "text": "Bounded relevant conversation excerpt"
  }]
}
```

Include accessible project/repository identity and activity timestamps in actual
hits. Resolve citations against their pinned revision, even after new messages
arrive, or report explicit expiry/unavailability under the retention policy.
Support project/agent/repository/date filters before ranking; paginate larger result
sets with bounded cursors tied to a query/index snapshot so sync does not cause
missing or duplicate hits. This cursor contract would be new for session and KB
search; existing KB search is bounded top-k. Offer token-budgeted evidence for
agents and revision-aware message ranges for reading around a session match.

Add an explicit session-embeddings toggle in Settings, separate from merely having
an embedding provider configured. When off, retain metadata/ripgrep search with
snippets and separately paged transcript reads as the fallback contract. Remote
archives must also be searchable through their server-side lexical index; ripgrep
over local agent homes alone cannot cover uploaded sessions. Switching the toggle
off must not make archived history unavailable or alter transcript reading.

When the toggle is on and vectors are ready, use hybrid search. If a provider is
missing, failing or still indexing, fall back to metadata/lexical search (including
ripgrep where available) with an explicit degraded/pending signal. Track model,
provider endpoint/profile, dimensions and chunking version; compare vectors only
within compatible profiles. Reuse unchanged chunk vectors and embed only new or
changed content. A model change requires a new embedding profile/backfill.

## Resume is a separate operation

Archive availability means the history is searchable/readable. Native resume also
needs a compatible agent, configured destination repository/execution host, code
state, credentials and runtime dependencies. Report capabilities separately, such
as readable/exportable/needs-preparation/resumable, with the reason.

On explicit resume, select an archived revision and destination, then reuse the
existing handoff preparation/import safeguards to create a new native session and
verify the code state. Record archive-to-destination lineage. This archive-to-handoff
bridge needs implementation; today's handoff requires the caller's native bundle
and exact pushed commit. A transcript without known/available Git state remains
searchable/exportable and must not be advertised as automatically resumable.
Never execute historical tool calls while indexing or treat transcript instructions
as trusted. Future destination messages sync under the destination's origin key.

## Scale, privacy and failure handling

- Separate discovery, storage, parsing, lexical indexing and embedding jobs. Use
  durable queues with unique revision/profile jobs, bounded concurrency, backpressure,
  retry classification and visible failed items. Do not scan every raw file on each
  query or load all session rows to rank them.
- Store raw blobs privately outside hot metadata rows; page manifests and normalized
  reads. Enforce session/file/owner quotas, actual streamed and decompressed byte
  limits, part count/size and request timeouts. Validate paths/format/parent references;
  never write to uploader-supplied absolute paths. Do not fetch arbitrary attachment URLs.
- Deduplicate by server-verified hashes; retain per-origin checkpoints and idempotency
  receipts. Rebuild indexes from stored revisions. Publish indexes with revision checks
  so search never labels stale chunks as current. Keep embedding backlog visible.
- Remote hosting must require authentication; enforce authorized project/session scope
  on manifest/upload/search/read/export/resume and filter before retrieval. Current
  shared API-secret access is installation access, not per-user tenant isolation.
- Transcripts can contain keys, private code, tool output and personal data. Provide
  an explicit exclusion/redaction policy before upload and before any external embedding
  request. Label redacted exports; they may not be lossless native resume artifacts.
  Never upload agent credentials, config or databases. Do not log transcript bodies,
  upload capabilities or credential-bearing metadata. Configure retention/deletion for
  raw revisions, derived chunks/vectors, staged parts and backups consistently.
- Measure representative session/message/byte volumes, initial sync and incremental
  throughput, embedding calls/cost and p95 search latency. Benchmark the vector backend
  before selecting an ANN/service migration; no current scale guarantee is implied.

## Implementation order and completion evidence

1. Archive schema/storage, origin identity, revision/CAS rules and bounded authenticated
   ingest; local uploader with manifest/checkpoint/retry support. Prove first upload,
   identical replay, extension, stale arrival, concurrency, divergence and interrupted
   upload across server/uploader restarts. No archival upload creates a worktree.
2. Parsed message index, lexical session search and revision-aware range reads/citations.
   Prove stable citations after append, project isolation, pagination under sync, parent
   links and recovery from parser errors. Preserve original native files.
3. Optional semantic/hybrid retrieval and existing-session backfill. Prove semantic
   paraphrase retrieval, provider-off/outage fallback, model changes, unchanged-vector
   reuse, bounded large tool outputs and acceptable measured cost/latency.
4. Explicit archive-to-native resume using handoff preparation and lineage. Validate
   real Claude/Codex history and destination cwd/code state through terminal launch;
   unavailable code/credentials must produce actionable capability limits.

This document is the design deliverable. Runtime implementation, remote deployment
and a real local-to-remote archival/resume trial remain future work.
