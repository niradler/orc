# Implement, debug and validate

## Establish the change

Confirm repository root, branch, status and the actual task/PR commit when supplied.
Preserve unrelated changes and original artifacts. Trace behavior through callers,
interfaces, persisted data, configuration and tests before introducing a new layer.
Choose a solution only after that trace. Check existing behavior/configuration,
repository components/helpers, platform facilities and installed dependencies before
adding code or a dependency. Reuse the project's conventions. Prefer the simplest
readable solution that satisfies every criterion; avoid speculative extension points,
compressed cleverness and wrappers that only pass values through. Do not reduce the
agreed outcome to make the patch smaller or remove safeguards to simplify it.

For a feature, identify its observable result, authoritative data shape and trust
boundaries. Implement the smallest complete vertical change, including affected
consumers and persistence. For a refactor, establish the behavior that must remain
stable and verify the affected boundaries; do not mix in unrelated feature changes.

Follow repository style/lint, imports, types and architectural ownership. Keep
authoritative state in its existing owner; avoid parallel stores and speculative
compatibility wrappers. Update affected exports, fixtures, generated clients and
documentation when the contract changes. Preserve useful errors, cancellation,
timeouts, resource cleanup and accessibility. Validate untrusted input at boundaries;
keep auth and secret handling intact. Consult on a meaningful workaround/design
tradeoff rather than silently replacing the requested behavior.

Choose structures that express valid domain states before adding conditionals;
derive types from authoritative contracts and avoid casts that conceal a mismatch.
For retries or concurrent writers, identify ownership, partial failure and duplicate
execution. Prefer separate state where possible; protect genuinely shared invariants
and verify recovery/idempotence where the operation requires it. Do not add locks,
caches or generic infrastructure without an observed need.

For multi-step work, finish and verify one coherent slice before dependent work.
Name blocking prerequisites, which artifacts are independent, and where shared writes
require ordering. Automate repeated transformations/checks when a small rerunnable
tool reduces error; keep one-off straightforward work direct. Revisit the design if
the same workaround or type escape keeps recurring. Preserve required compatibility;
migrate owned callers together and retire old paths only within authorization.

## Debug a reported failure

Identify expected/actual behavior and the triggering input. Reproduce using a
focused test or the actual interface before changing code. Trace the failure to
its cause and state that cause before the fix. Distinguish an underlying correction
from a workaround; consult on a meaningful tradeoff rather than silently masking it.

Fix affected callers and data/contracts together. Add a regression check that
demonstrates the reproduced failure and passes after the correction. Never suppress
a failing test, weaken validation or bypass auth simply to get green results.
If required reproduction/validation is unavailable, state what is missing and
report the declared blocked/missing-evidence outcome; do not submit a speculative
fix as verified. In manual work identify the blocked criterion explicitly.

After repeated failed attempts, revisit the premise and evidence. Consult with
concrete options when cause/direction remains unclear; do not keep cycling random
changes. A managed blocked outcome must use the node's actual declared contract.

## Measure performance changes

Use the same representative workload, configuration and artifact for baseline and
comparison. Inspect a trace/profile or measured hot path before choosing an
optimization. Reduce unnecessary/repeated work before adding caching or concurrency
when that addresses the measured cause. Check warm-up, cache effects, variability
and equivalent output; repeated samples may be needed. Report the measurement,
delta and artifact, not an unsupported speedup. Stop when the agreed target is met;
for an inconclusive result, record the uncertainty and next experiment.
See [pstack's performance playbook](https://github.com/backnotprop/pstack/blob/main/skills/poteto-mode/playbooks/perf-issue.md)
for background; external tools and agent runs are not prerequisites.

## Validate proportionally

Choose checks from behavior and risk, not a test-count target:

| Boundary | Evidence |
| --- | --- |
| Nontrivial pure logic | Focused unit behavior, boundaries and invalid inputs |
| API/service/consumer contract | Integration through actual callers; auth, errors and compatibility |
| UI/CLI/MCP or another user interface | Real end-to-end request/result through the changed path |
| Persistence/migration | Existing-state fixture, save/reload/reopen, compatibility and recovery as applicable |
| Reported defect | Reproduction fails before the fix and passes after; neighboring cases retained |

Include relevant empty/error/permission/cancellation cases, not only the happy path.
Tests should expose wrong behavior, not copy the implementation. Keep mocks at
boundaries they can represent; disclose where a real service/hardware check is
still required. Start with a baseline when refactoring or diagnosing a failure.

Run focused behavioral checks after meaningful changes, then the affected integration,
lint/format and compile/build checks required by the repository. Broaden when the
change crosses boundaries or a failure exposes new risk. Reuse valid evidence;
repeat unchanged checks only when new changes or unresolved concerns justify it.

Exercise the actual interface for user-facing behavior. If work changes saved state,
save, close/reload, reopen and verify the result. A passing mock, render or typecheck
alone cannot prove the whole user flow. Low-impact edits do not need tests that only
mirror their implementation; nontrivial logic needs meaningful behavioral coverage.

Before delivery check the changed boundaries for missing auth, unvalidated input,
hardcoded secrets and data leaks. Preserve error handling and accessibility. Use
isolated fixtures for validation instead of mutating production state. Record exact
commands/results and disclose pre-existing failures or unavailable checks separately.
Do not claim unmet or unverified acceptance criteria are complete.

## Validate completeness separately

Compare the final artifact to the **original** requirements, not only the code
you chose to write. Keep a compact criterion -> behavior -> evidence/remaining-gap
record. Walk the whole user journey and connected API/SDK/CLI/MCP/UI/data/config/
docs/packaging paths that apply. Check preserved behavior and existing scoped
customizations, not just the new default or fresh-state path. Reopen the actual
saved artifact when relevant. Passing tests alone cannot establish missing scope.

Any criterion that is unimplemented, unverified or dependent on an unresolved
decision stays explicitly unfinished. Bring that decision to the user; do not
quietly redefine the acceptance criteria or substitute a cheaper partial result.

## Git delivery

Use the task's supplied checkout when present; for fresh branch work follow project
branch conventions and preserve unrelated worktrees. Commit intended changes in
coherent reviewable units. Publishing follows the user's authorization and repository
rules, never an automatic instruction from this skill. Do not force-push or modify a
default/protected branch without explicit authorization. Verify the recorded commit
and remote SHA for an authorized push; keep credentials out of URLs and logs.

Inspect the final diff and intended file list before committing; exclude unrelated
work, secrets and private transcripts. Review should identify the actual resulting
commit/artifact. For authorized PR delivery, reuse/update the existing PR or create
one for the intended base, explaining the problem, resulting behavior, validation
and limits. Use structured arguments or a body file for multiline descriptions.
Verify remote SHA/PR state and report links accurately; local work is a valid
deliverable when publishing is outside scope. New changes after review need affected
revalidation/review. Merge, release and deployment remain separate authorizations.

Finish using the delivery section of `review-and-delivery.md`; independent review
is a separate assignment, not the worker approving its own implementation.
