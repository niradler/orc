# Evolving wiki and shared retrieval

ORC maintains a project wiki from cited session evidence. Knowledge now includes a
SQLite FTS5 passage index alongside the existing QMD document interface. Passage
retrieval works without models, credentials, downloads, or a search service.

## Retrieval

`POST /api/knowledge/passages/search` accepts `query`, an explicit `project_id`
(null means unassigned), optional `kinds`, `tags_any`, `tags_all`, `topic_tags`,
`limit`, and `token_budget`. Exact tags constrain candidates; topic tags supply a
bounded soft ranking signal. Untagged legacy records remain eligible. New memory
writes normalize supplied tags; the wiki workflow requires meaningful topic tags.

Results include source identity, SHA-256 source version, location, heading ancestry,
character offsets into the original text, passage identity, and original content.
Oversized code/table fragments carry separate structural context. Offsets are UTF-16
string offsets, not byte offsets. The budget uses a character-based token estimate;
it is not an exact tokenizer count. Passage expansion is bounded to three neighbors
per side within the same current source version and project.
`POST /api/knowledge/passages/get` takes up to twenty explicit citation IDs and a
project ID to inspect immutable evidence, including retired versions. Historical
fetches do not restore expired sources to search. Wiki evidence buttons open these originals.

Only current, active, unexpired sources enter candidate selection. Explicit original
memory reads and retained versions support historical evidence. API/MCP memory writes
capture revisions; deleting a memory retires its search entry. Existing memories are
backfilled on first passage search. QMD collection add/update mirrors original documents
into the shared index; collection removal retires entries. Existing collections need
an update before their documents appear in passage retrieval. QMD remains the compatible
document engine; this change neither upgrades nor replaces its dependency.

CLI: `orc wiki list --project orc` and `orc wiki search "join_deadlock" --project orc`.
MCP: `evidence_search`, `evidence_index`, `evidence_get`, `evidence_expand`, `wiki_read`, and `wiki_apply`.
Startup context and maintenance reads (`context`, `wiki_read`, `skill_history`, `skill_baseline`) accept a readable
`project` name or an explicit `project_id`. Explicit IDs take precedence; null selects
unassigned even when the installation has a default project. Unknown IDs fail closed.
The dashboard exposes **Knowledge → Wiki & evidence**. The all-project selector shows
unassigned evidence in this workspace; choose a project to inspect its wiki.

Collection patterns are bounded before indexing or persistence: at most 1,024
characters, eight nested brace/parenthesis levels, and 256 brace alternatives or
range expansions. Normal patterns such as `**/*.{md,txt}` remain supported. Updating
a legacy collection with an unsafe pattern fails validation before indexing.

## Optional embeddings

Configure `knowledge.embeddings` explicitly in ORC's config:

```json
{
  "knowledge": {
    "embeddings": {
      "endpoint": "http://127.0.0.1:8080/v1/embeddings",
      "model": "your-local-model",
      "dimensions": 768,
      "timeout_ms": 10000
    }
  }
}
```

The endpoint uses the OpenAI-compatible input/data embedding shape. Call
`POST /api/knowledge/passages/embed` with a source kind, ID, and project ID to generate vectors.
Vectors are keyed by passage and model. Search fuses lexical and semantic ranks.
Provider failure preserves lexical retrieval and reports `semantic: degraded`;
no provider reports `off`. Hosted endpoints require explicit `allow_hosted: true`.
Credentials are read from the environment variable named by `secret_env`; redirects
are rejected. No source text is sent to a hosted provider implicitly.

The initial semantic implementation scans at most 5,000 eligible vectors and uses
cosine similarity. This is a bounded starting point, not an ANN scalability claim.
Actual model quality and native model packaging are not established by controlled-vector tests.

## Session contributions and maintenance

`session_log` signals a completed work unit and captures its summary plus recorded
events as immutable versioned evidence. Repeated identical inputs enqueue once.
Stopped/error live sessions and runner completions contribute lifecycle summaries.
These are separate signals; session logging is not a universal session-end event.
Lifecycle summaries may lack full transcripts and must not imply verified outcomes.

The existing agent loop schedules one `orc-wiki` maintenance task at a time, using
its normal worker capacity and flow safeguards. Contributions and skill evaluations
share FIFO ordering by creation time and ID, so new sessions cannot starve older
evaluations. The maintenance scheduler enforces a single task per dispatch. Each contribution gets at most three
attempts. Failure and no-change outcomes remain recorded; wiki tasks do not recursively
contribute to more wiki tasks. If the agent loop is disabled, contributions remain queued.
Cancelled/halted maintenance tasks retain a failure record and release the queue for
bounded retries.
Wiki reads include the most recent 300 processing attempts for the selected project.
The dashboard's contribution history and MCP `wiki_read` retain earlier failure reasons
alongside a later applied/no-change result; successful consolidation does not erase the ledger.

`wiki_apply` atomically writes up to five page edits using expected revisions and
same-project passage IDs, or records `no_change`/`failed`. Conflicting edits require a
reload. Pages retain their revision history; source evidence remains distinct from
maintained interpretation. Contradictions and superseded decisions belong in cited
page content rather than silently rewriting original evidence.
Link maintained pages in the same project with `[[page-slug]]`. The dashboard resolves
existing page links locally; missing targets stay text and code examples stay literal.

## Automatic skill evolution and human revert

Skill candidates retain rationale, source evidence, training case IDs, and the hash
of the active installed package. `skill_baseline` supplies the raw entry point and
package identity. Proposals change SKILL.md instructions; supporting files are preserved.
`skill_history` exposes retained rejections, evaluation failures and change history to agents.
Proposals automatically queue an evaluation-only `orc-wiki` task through the existing
agent loop. Evaluation and consolidation share a single maintenance slot; evaluations
receive at most three attempts. A missing representative executable suite is a recorded
failure, never fabricated success. Paired results finish the evaluation job even when
they show no gain. Rejected proposals are retained and excluded from scheduling.

`skill_evaluate` records paired baseline/candidate success outcomes on unique held-out
cases. Automatic promotion initially requires validation passed, at least ten cases,
at least ten percentage points of success gain, zero observed regressions, valid candidate
frontmatter, and an unchanged package baseline. Tune `wiki.min_evaluation_cases` and
`wiki.min_success_gain` through normal configuration. These initial thresholds have not
been calibrated as statistical guarantees. Evaluations record reported outcomes; they
do not independently execute or certify an agent benchmark.

Passing gates automatically activates a project-specific instruction override stored
in SQLite. ORC's runner, MCP skill reads, and API/dashboard skill reads use it. Installed
bundled/user skill files and supporting assets are unchanged. External tools that directly
read the original file do not receive this override. An upstream installed-package change
invalidates the override, so ORC falls back to the new installed version.

**Skills → Automatic skill changes and evaluation history** shows proposals, evaluations,
before/after instructions, and human reverts. A current promoted version can be reverted
with a reason. The API requires the current activation ID and checks the installed package
before reverting. Reverting retains both versions and the evaluation record.
CLI: `orc wiki evolution --project orc` and
`orc wiki revert <activation-id> --project orc --reason "Observed regression"`.

Writing lessons, passing ordinary tests, or recording a small evaluation does not prove
better agent performance. Rejected candidates and no-gain outcomes remain available to
future learning. Representative paired agent evaluations, costs, and recurring outcome
tracking are necessary to substantiate improvement beyond an individual suite.

## Validation scope

`bun scripts/validate-wiki-runtime.ts` runs a real authenticated Claude worker through
the ordinary source API and task loop on port 7711. It uses an isolated database,
actual repository documents, exact citation checks and duplicate work-unit logging,
then retains the agent's consolidation outcome and flow ledger. It requires Claude
credentials, may incur model charges, and has a seven-minute agent deadline. A
legitimate no-change outcome is retained; the script never fabricates promotion results.

Run `bun scripts/evaluate-retrieval.ts` for a reproducible SQLite-only smoke benchmark
using repository documents, routine noise, expired and foreign-project distractors.
It retains the isolated database and report under `.claude/tooling/wiki-evaluation/`.
Reports keep strict source ranks and acceptable equivalent-evidence ranks separate.
Metric snapshots and query-by-query results stay in the report artifacts, outside the
indexed feature documentation, so retrieval cannot rank its own benchmark commentary.
The manually labeled queries are a smoke diagnostic, not independent held-out evidence;
changing labels or corpus documentation does not demonstrate a retrieval improvement.
This small corpus is a diagnostic, not a representative benchmark or semantic quality claim.

Tests cover controlled promotion gates, persisted history, browser citation access and
human revert. They do not establish improved real-agent performance. No production
skill has been promoted by this implementation's validation.
The npm bundle ships built-in skill files alongside the dashboard. Standalone builds
embed those files and materialize a content-addressed cache under `~/.orc/bundled-skills/`
so baseline hashing and supporting-file reads work without a repository checkout.
Standalone agent execution additionally requires Claude Code on `PATH`; the SDK's
native executable is external to the compiled binary. The readiness probe checks
this prerequisite before starting maintenance. npm/source use the installed SDK executable.
