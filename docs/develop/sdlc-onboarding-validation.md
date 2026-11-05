# SDLC onboarding validation

The follow-up adds a project-folder/first-task handoff to the existing dialogs,
workflow preview and create/start with saved-task retry, numeric MCP progress
read/write, and a repaired native Codex exec/resume adapter. The existing runner,
flow engine, backend picker, knowledge stores and human gate are reused.

## Actual local agent runs

`scripts/validate-sdlc-runtime.ts` is an opt-in paid probe, not an ordinary unit test.
Run it with Bun from an isolated checkout and a free private API port 7711. It
retains a separate database, temporary project artifacts and reports under ignored
`.claude/tooling/sdlc-runtime/`. It does not update production projects or install
global hooks. `ORC_VALIDATE_BACKENDS=claude,codex-cli` selects the supported local
runtimes; `ORC_VALIDATE_DURABLE=1` adds the positive knowledge-update case.

On 2026-10-14, both Claude SDK and Codex CLI 0.159.2 completed:

- A real worker replaced an incorrect predicate and executed the supplied checks.
- An independent real reviewer inspected the artifact and ran its verification.
- Human rejection routed back to the same native worker conversation; the worker
  added the requested zero-time equality assertion and verified it.
- A second independent review passed; explicit human approval completed the task.
- Each of four agent work units called scoped context/search, its own audit review,
  session logging and the declared flow outcome in the required order.
- Initial quiet work units made no memory/wiki writes. Requested rework recorded
  and reviewed one evidence-backed coverage discovery, revised the existing wiki
  procedure with expected_revision, and set numeric progress to 80.
- Executable artifact checks passed independently of the agent's self-report.
  Closing/reopening the private database preserved task, memory and wiki records.

Retained evidence: quiet Claude run `1791971832361`, quiet Codex run `1791972459729`,
and both positive cases `1791972934809`. The final strict API/event-only run
`1791974770565` passed for both backends with automatic polling disabled, eight
independent predicate acceptance checks and exact database close/reopen. A prior
direct-start Claude task completed but failed the strict wiki_search check
(`1791974202654`); startup now explicitly names the required search tools.
Negative attempts are also retained:
Windows `.cmd` argument failure and denied MCP calls resulting in a paused task.
The fixes use direct Windows Node launch, stdin prompts, current JSON events,
authenticated MCP, and approval of work-unit tools only when auto-approval is enabled.
Disabled worker auto-approval now propagates to runtime options and session state.
Explicit API starts dispatch subsequent nodes on session completion and human
resume, with automatic task polling disabled. Dispatch is serialized to preserve
the shared worker cap, and active sessions reuse the flow timeout sweep.

## Product and distribution checks

Chromium exercises fresh project → saved task, workflow preview, missing-folder
launch refusal, launch failure/retry without duplicate tasks, human approval and
save/reopen. The paid agent probe checks actual agent behavior separately from
browser wiring. Unit checks cover native protocol/resume/error handling, progress
read/write without status changes, and disabled worker auto-approval.

The Docker image includes pinned ACPX 0.12.1, Codex CLI 0.159.2 and Claude Code
2.1.299, with Node and Bun 1.4.2 on Debian. Actual container command probes and an
audit of the installed agent-tool dependency set pass (zero vulnerabilities).
`scripts/validate-container-tools.ts` checks tool execution, private API auth and
honest unavailable Codex status without credentials. No credentials are in the image.

## Boundaries

Final validation: 1,053 unit/integration tests passed (5 existing skips), 94 Chromium
tests passed (2 existing skips), workspace/script typechecks, Biome and the production
CLI/dashboard build passed. An invalid overlapping build/browser attempt is retained
in local logs: the API selected source HTML while the other build replaced web/dist,
causing /src/main.tsx 404s. Repeating the full suite after the build ended passed.

These are process and artifact checks on a small TypeScript development project,
not comparative quality benchmarks. No quality improvement or large-repository
reliability is claimed. The fixture has no separate lint/typecheck configuration;
agents disclose that limitation. Referenced collaboration reference files absent
from the fixture remain a reported limit, not an invented successful check.

Actual paid agents ran locally on Windows; Docker validation covers tools, auth
and readiness rather than authenticated paid work inside the container. Codex uses
workspace-write/read-only exec sandboxing and has no verified ORC native rule
interception: existing scoped ORC policies still refuse unsupported execution.
An installed tool or delivered prompt does not prove enforcement parity.

The unchanged workspace dependency audit still reports six advisories (1 high,
3 moderate, 2 low): braces, esbuild, KaTeX, postcss-selector-parser and sprintf-js.
The braces version already has a repository patch, but the raw audit still flags
its version; this follow-up does not certify advisory remediation. The separately
installed pinned Docker agent-tool tree audits clean. Dependency remediation is
separate from the onboarding/runtime fixes unless explicitly requested.

No master push, merge, release, published Docker image or production deployment is
part of this validation.
