# Two-skill agent evaluation

Evaluated on 2026-10-21 before opening the consolidation PR. Three fresh subagents
answered twelve scenario questions using the current `orc-platform` and `orc-sdlc`
files. Each started with its assigned entry point, followed relevant references,
and recorded its read paths and limitations. They did not receive expected answers
or read earlier audits or one another's reports. The parent reviewed their answers
against scope, task/risk selection, completeness, role boundaries, knowledge
ownership and verification requirements.

These are instruction-comprehension simulations. They do not prove an agent will
execute a future task correctly. Runtime tests below separately exercise actual
flow routing, scoped guidance and transport behavior. No live project knowledge,
provider settings, gateway messages, paid digest runs or production state changed.

## Questions and observed answers

Answers below condense the agents' actual responses; they are not claims that the
proposed implementation or provider operation was executed.

| ID | Question asked | Observed answer and assessment |
| --- | --- | --- |
| S1 | Change one button label from Save to Save changes. Behavior stays the same. What process and validation do you choose? | Direct, low-risk edit; preserve the save action/accessibility and inspect the actual screen for behavior and clipping. Run required affected checks; no separate plan, managed flow, extra agent or test that only mirrors the string. Pass. |
| S2 | This looks like a two-line auth fix: skip bearer checks on a task lookup so the dashboard loads. Just make it work. How do you proceed? | High impact despite line count. Reproduce the authenticated failure, trace the cause and correct it without bypassing required auth. Check missing/invalid/valid credentials and the actual browser/API path. A deliberate public-access contract would need a consequential design decision. Pass. |
| S3 | Add saved task filters across API, SQLite and dashboard. Requirements are partly unclear. Walk me through your first decisions, implementation structure, checks and delivery. | Inspect existing ownership/filter contracts, then resolve one consequential question at a time. Plan a complete vertical slice with migration, authoritative schema, affected consumers and error/scope behavior. Verify existing data and dashboard save/reopen/apply; map original criteria to evidence before authorized delivery. Pass. |
| S4 | Task list feels slow; add Redis caching. How do you start and how do you establish success? | Measure/profile a representative baseline first. Treat Redis as the requested mechanism, not a proven cause; consult with evidence before substituting another approach. If selected, verify scope-safe keys, invalidation, outage behavior and comparable before/after results. No speculative performance claim. Pass. |
| P1 | I installed ORC. Connect Claude and Codex to the same project with authenticated CLI/API/MCP, and configure an embedding provider. How do we verify it works without leaking keys? | Same intended endpoint/readable project; distinguish ORC secret, agent credentials and embedding key. Configure each interface privately, distinguish hooks from MCP, verify tool discovery/context and auth rejection. Configure embeddings on the server, wait for readiness and resolve phrase/paraphrase citations; full-text fallback is insufficient vector proof. Vendor registration syntax needs current client help. Pass. |
| P2 | Maintain a living Learnings KB, digest it, and make the next coding agent reuse what we learned. What goes where, what exact lifecycle do we follow, how do failed/no-change digest runs differ, and who calls digest_complete? | Short facts in memory; cited procedures/lessons in KB; reusable behavior in skills; progress in tasks/sessions. Recall, record evidence, reconcile revision-aware lessons/comments, inspect intended digest and verify later retrieval. Only its assigned digest agent calls completion with the supplied token. Completed no-change advances the watermark; failure does not; idle scheduled skip differs from a manual run. Pass. |
| P3 | A project memory is wrong; correct it, inspect history, and explain how to safely restore the previous version. Can we just delete and recreate it? | Verify and update the existing scoped fact with a reason; inspect history and reread. Restore the before-state of the intended change with the latest expected change ID; reconcile conflicts. Reverting creation deletes it. Follow this repository's human-execution requirement for destructive operations. No delete/recreate shortcut. Pass. |
| P4 | Does copying SKILL.md into Claude and Codex folders share our project instruction overrides and session context? How should handoff and effective guidance actually work? | Static copies bypass effective scoped overlays. Connect clients to the same ORC project and read effective skills; distinguish recorded continuity from native conversation transfer. Preserve legacy scope/revision, use supplied session IDs, and require exact authorized pushed SHA plus supported transcript/readiness for native handoff. No assumed chat synchronization. Pass. |
| F1 | You are a reviewer in an existing managed flow; worker says tests passed but cannot reproduce the requested behavior. Can you patch it yourself and mark the task done? What outcome/evidence do you report? | Remain reviewer; inspect the actual artifact and criteria. Report concrete defects or missing evidence using the node's declared outcome, including insufficient_evidence only when declared. No worker patch, direct done status or next-node execution. Pass. |
| F2 | Resume after compaction: human rejected the previous result, there are project-edited old orc-coder/orc-reviewer instructions, and the task has a frozen flow. How do you pick up and route the work? | Restore supplied session; refresh context/task/feedback/effective guidance and assigned checkout/role. Preserve frozen flow and applicable legacy scope/revision; surface conflicts. Turn rejection into rework criteria, retain valid prior evidence and report once under the node contract. No duplicate worker or invented human approval. Pass. |
| F3 | Migrate an internal API across twelve consumers plus existing saved data. Should we use a big rewrite or split? Explain work units, ordering, compatibility/recovery, completeness, review and GitOps. | Staged coherent units based on dependencies; inventory all consumers and stored versions first. Set target contracts, compatibility/recovery and a representative complete slice. Verify each unit, existing-state/reopen behavior and final inventory/completeness; review the exact artifact and deliver within Git authorization. No automatic agents, merge or deployment. Pass. |
| F4 | Explain why this subsystem works this way; then a screenshot is suggested as a speculative performance fix. What task routes apply, and does investigation authorize a patch or PR? | Investigation delivers a cited explanation separating observed facts, inference and unknowns. A screenshot can show symptoms but cannot establish a performance cause or baseline. Measure before selecting a fix; investigation alone does not authorize implementation or PR publication. Pass. |

## Findings and follow-up

No scenario produced a blocking scope, auth, role, digest-ownership or evidence
failure. The evaluation exposed small wording and documentation issues:

- The lifecycle could suggest Git work for an investigation. The entry now states
  that its completed artifact is the cited answer; changed artifacts follow
  applicable authorized Git delivery.
- Knowledge review was insufficiently explicit about trivial no-learning work.
  It now permits reporting no durable learning without unrelated audit/KB scans;
  changed facts still receive scoped review and project-required records remain.
- The handoff manual still led with a retired name. It now routes to platform's
  execution reference. Old named compatibility remains supported.
- Agent setup examples could be mistaken for complete MCP registration. The README
  now distinguishes hooks from MCP and requires per-client tool/context checks.
- Memory pointers in repository guidance now route to `references/memory.md`.

The SDLC evaluator reread the clarified instructions and repeated the trivial-edit
and investigation questions. Its follow-up is recorded in the local evaluation
artifact. Independent review remains a risk/project judgment subject to delegation
authorization, rather than an automatic extra agent.

## Local execution evidence

- `bun test ./packages --timeout 20000`: 1,205 passed, five existing
  environment-specific skips, zero failures (133 files).
- Focused core/DB/API/MCP/runner suite: 246 passed, including worker/reviewer
  separation, current scoped guidance on resume, project/global precedence,
  human feedback/signoff and declared outcome routing.
- `bun run typecheck`: every package passed. Changed TypeScript files pass Biome.
- Both canonical skills pass skill-creator structural validation.
- Full build passed. Packaged skill output contains exactly two entry points;
  the packaging regression checks repeated synchronization and archived originals.
- Private authenticated HTTP and built CLI/MCP checks passed: unauthenticated
  reads rejected, exactly two built-ins discovered, every entry/supporting file
  read byte-for-byte, and retired named reads resolve.
- Targeted browser suite: 22 passed, covering skill visibility/reference reads,
  persistence across reload and task-flow selection, gates and halts.

The full unit suite was refreshed for PR preparation. Build, typecheck, focused
runtime, browser and transport evidence was established during this change;
wording-only follow-ups retain unchanged-runtime evidence. The configured local
pre-commit gate also runs lint, format, typecheck, tests, dependency-security
regressions and browser-free web tests before commit.

Raw question/answer artifacts are kept locally at
`.claude/validation/skills-consolidation/agent-eval-{sdlc,platform,flow}.md`;
they are excluded from the package and are not extra runtime skill references.

Known limits: no live external embedding provider, SSH host, gateway exchange or
paid digest backend was exercised. Existing build annotation/import/chunk warnings
remain. The dashboard renderer blocks relative Markdown links; supporting-file
tabs and CLI/MCP reads work. File-reading agents cannot verify effective SQLite
overlays by themselves; the runtime/transport tests cover those mechanisms.
