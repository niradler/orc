# Clarify and plan

## Extract executable requirements

Inspect the existing task, comments, handoff, affected code and relevant project
decisions. Reuse the supplied branch/worktree and task rather than creating competing
work. Resolve observable questions through inspection or a focused experiment.

For unclear intent or multiple consequential approaches, ask one decision at a
time: explain the options, recommend one, and wait for direction on dependent work.
Continue independent investigation when useful. Do not turn clarification into
handing the implementation back to the user.

Establish the desired outcome, concrete examples/acceptance criteria, constraints,
explicit exclusions, relevant existing decisions, dependencies and who must decide
remaining product choices. Search memories/KB decisions before re-asking them.
Probe meaningful branches: failure cases, permissions, saved-state/compatibility
expectations and interaction with existing behavior. Do not interrogate a clear
request ceremonially. State assumptions; do not turn an unanswered required choice
into approval. The exit condition is an assignment another developer can execute
and a reviewer can judge without inventing product behavior.

## Choose the task kind, then the effort

First identify the core outcome and trace its current entry point, data owner,
callers and observable result. Distinguish an observed fact from an assumption;
run a bounded experiment for an answer available from the system. Reserve user
questions for intent, tradeoffs and authorization that evidence cannot settle.

Choose the relevant procedure below, then size it with the effort table. Mixed
tasks may combine procedures; investigation alone does not authorize implementation.

| Task kind | When and how to proceed | Completion evidence |
| --- | --- | --- |
| Investigation | A question about behavior or cause; inspect source/history and reproduce relevant facts | Cited answer with observed facts, inference and unknowns separated; no unsolicited patch |
| Defect | Incorrect behavior with a triggering case; use the debugging section in development.md | Failure reproduced, cause explained, regression and actual affected path verified |
| Feature | New behavior; start with a caller/user example, authoritative data and ownership | A complete vertical use case, including failure paths and affected consumers |
| Refactor | Structure changes while behavior stays stable; establish invariants before editing | Same observable contract before/after; callers migrated and old paths accounted for |
| Performance | A latency/resource complaint; measure a representative baseline before changing code | Comparable before/after artifacts, correctness retained and limits of the measurement stated |
| Migration or broad change | Several dependent boundaries or existing stored state | Ordered, verifiable slices, compatibility/recovery decision and final target-state check |
| Prototype | An uncertain design choice needs cheap empirical evidence | A bounded experiment answers the named question; label temporary artifacts and production gaps |

Writing/docs/skill tasks follow the same outcome/scope discipline: verify technical
claims and links, inspect the rendered/read artifact when relevant, and evaluate
instructions against realistic task scenarios. Do not require a code scaffold for prose.

| Route | Criteria | Required preparation |
| --- | --- | --- |
| Direct | Clear outcome, local boundary, low consequence and easy recovery | Short criteria/check list; implement and verify |
| Planned | Uncertainty, several connected layers/dependencies or meaningful design alternatives | Resolve choices; ordered implementation/validation plan |
| Staged | Large sweep, migration, multi-phase work or several independently verifiable deliverables | Dependency order, bounded slices, explicit checkpoints and a final integration/completeness check |
| High impact (applies at any size) | Auth, sensitive input/data, migrations, compatibility, destructive operations or rollout | Trust/failure analysis, migration/recovery and real-path verification; independent review when warranted/required |

Risk takes precedence over line count. Planning does not authorize extra agents,
production changes or publishing. Follow required human gates before dependent work.

A small UI label correction can stay direct. A small auth change still needs trust
boundary checks. A feature spanning API/storage/UI needs a contract and an end-to-end
slice. A multi-package migration needs staged verification, not a larger unstructured
implementation. Explain a non-obvious route briefly; do not narrate a checklist for
every trivial edit. Promote the route when new uncertainty appears; stop adding
planning artifacts once the next safe step is clear.

## Make the plan testable

Record only what makes execution and review reliable:
- User-visible outcome and checkable acceptance criteria.
- Scope, constraints and authoritative data/contracts.
- Chosen approach, affected boundaries and meaningful milestones.
- Validation method, material risks and immediate next action.

For a meaningful new boundary, sketch the caller's usage, input/output/error types,
state owner and module responsibilities before implementation. Compare alternatives
only when a consequential choice is unresolved. A focused prototype can settle an
empirical fork; several competing implementations are not mandatory. Keep sketches
in the existing plan/handoff; do not add empty production scaffolding by default.
When the human should review, comment on or reshape a plan, design or diagram, put it
in an ORC scratchpad and share its link (`orc-platform`, scratchpads reference).

Map each criterion to the relevant implementation step and verification evidence.
Trace affected public contracts, callers, stored state and version compatibility;
include docs/config/SDK/packaging changes when behavior depends on them. Identify
what can fail, how it will be detected and what recovery is needed. A migration
plan must address existing data, not just a newly created test database.

A bounded change needs little planning. Cross-package behavior, persistence,
authorization or rollout may require tracing callers and migration/recovery paths
before editing. Do not impose an elaborate design template on every task.

When decomposition is requested or authorized by the project, create separate dependency-linked work units only when they can be executed or
reviewed meaningfully on their own. Keep one coherent change together when splitting
would merely increase task and review overhead. Do not create agents as a side
effect of creating a plan. Check available backend capabilities and authorization
before any managed execution; preserve concurrency and flow budgets.

For a proposal-only request, deliver the concrete options, recommendation and
open decision. For an implementation request, proceed through implementation and
validation; a plan is not the requested completed result. Keep the existing topic
handoff current after meaningful chunks so another session can resume accurately.

Design influences: [Ponytail's minimal complete solutions](https://github.com/DietrichGebert/ponytail/blob/main/skills/ponytail/SKILL.md),
[pstack's task routing](https://github.com/backnotprop/pstack/blob/main/skills/poteto-mode/SKILL.md)
and [architecture preparation](https://github.com/backnotprop/pstack/blob/main/skills/architect/SKILL.md).
These are background sources, not additional runtime skills or authorization;
the ORC guidance above adapts their practices to the task and project constraints.
