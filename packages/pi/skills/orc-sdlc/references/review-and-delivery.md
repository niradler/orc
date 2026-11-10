# Independent review and delivery

## Review and rework checkpoint

Every delivered change needs final self-review of scope, diff, security and
criterion/evidence coverage. For a bounded low-risk change that can be sufficient;
use independent review when the project/flow requires it or uncertainty/impact
warrants it, within delegation authorization. Do not claim self-review is independent.
Inspect original requirements for omissions as well as defects in implemented code.
Check whether the final structure fits its callers and state ownership, whether an
existing mechanism could replace new machinery, and whether reported measurements
support the claim. Remove only unnecessary scope within authorization; retain
required safeguards, compatibility and acceptance behavior. Evaluate connected code
and realistic failures, not only changed lines or diff size.

Findings return to implementation, affected revalidation and review of the resulting
artifact. Bound repeated attempts; escalate unresolved choices/missing evidence with
concrete next actions. Reuse unchanged valid evidence instead of repeating every
suite on every small fix. An approval of an earlier commit is not evidence for later changes.

## Independent review (reviewer assignments only)

Read acceptance criteria, worker evidence, recent feedback and flow ledger. Identify
the exact artifact/branch/base/commit in the correct checkout; do not review a daemon's
checkout or a similarly named branch by assumption. Verify relevant knowledge against
the current artifact. The assigned role and node contract govern this review.

Trace changed behavior through connected callers, interfaces and stored data.
Prioritize correctness, security, meaningful validation, project conventions and
scope. Inspect actual checks and run the relevant ones needed to establish the claim;
do not approve from the worker summary or test count alone. Reuse valid evidence and
keep re-review focused on fixes and affected behavior.

Each blocking finding needs a location, triggering scenario, demonstrable failure
and corrective action. Distinguish a reproduced defect from an untested risk; do
not block on personal style. Reviewers report findings rather than implementing
the worker's fixes. A worker cannot claim an independent verdict on its own work.

- Approve only with sufficient acceptance evidence and no blocking defect.
- Request changes for concrete defects or unmet criteria.
- Use `insufficient_evidence` when declared and required evidence is unavailable;
  otherwise follow the node's declared failure outcome and describe the missing check.

## Delivery and scoped knowledge review (all work units)

Before any outcome, including blocked or missing-evidence results, review the
work unit's actual discoveries and memory changes. This is an inline check, not
a separate mandatory agent or quota of writes. Keep it proportional: when no
durable fact changed or lesson emerged, state that result without unrelated
audit/KB scans. Project-required records still apply.

1. For facts changed during work, use `audit_list` scoped to the project and supplied session ID, or the memory
   names recorded during work. Read current memory/history before correcting it.
   Keep short facts in memory; project progress stays in tasks/session events.
   If session attribution is absent, inspect `memory_list(sort: recent)` plus the
   names/events recorded during work; do not assume HTTP MCP captured a native ID.
2. Correct contradictions and overlaps only within the user's write scope. Prefer
   updating the existing fact with a reason. Procedures/verified lessons belong
   in the relevant KB or maintained docs, not another long memory. No durable
   learning means no new memory or KB write.
3. Search the relevant KB before adding a lesson. Preserve human-owned documents;
   for a read-only KB leave a comment. Edits use current `expected_revision`, a
   reason and evidence sources such as files/commits/session references. On conflict
   reread and reconcile. Load `orc-platform` knowledge guidance if mechanics are needed.
4. Log the completed work unit with `session_log` when available, using its explicit
   session ID and readable project. Keep the existing topic handoff current with
   state, evidence, open issues and the immediate next action.

The next coding agent must be able to find the resulting fact/lesson in the same
central ORC project. Keep provenance and uncertainty; check stale/contradictory
guidance against source. In a read-only Learnings KB leave a cited comment for its
digest. Do not trigger a paid/manual digest or rewrite shared skills unless that
action is within scope. Use platform knowledge guidance to maintain/diagnose the
digest; only the digest's assigned agent reports its run token with `digest_complete`.

Shared effective skills are ORC-scoped reads, not copies of local agent files.
Old authored compatibility instructions retain their name/scope/change identity;
if they contradict the assigned role or current instructions, surface the conflict
instead of silently discarding them. Resolve process changes in their intended scope.

Deliver a concise result containing:
- What changed and why; artifact/branch/commit/PR references where applicable.
- Acceptance criteria checked and actual validation results.
- Risks, failures, unavailable checks and concrete remaining work.
- Knowledge reused/recorded, or no durable learning; disclose unavailable tools.

Prefer an enforceable check or architectural correction for recurring defects.
Propose process/skill changes separately unless they are the assigned task; one
observation does not justify silently rewriting shared instructions.

For managed work, call `flow_report` once using the exact declared outcome and
evidence, then stop. The engine routes review/rework and human gates. Do not set
flow-owned task status or run another node yourself. Outside a flow, report to the
user and update the task under its agreed manual lifecycle. Review completion
does not authorize merge, release, deployment or external messages.
