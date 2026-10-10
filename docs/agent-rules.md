# Agent rules and evidence-based skill quality

ORC rules evaluate coding-agent events before selected tools execute, or enqueue an
existing job after a matching event. Skills guide reasoning; flows coordinate work;
rules return deterministic decisions. Policies are opt-in and scoped to an existing
absolute workspace directory and its descendants.

## Enable and manage policies

Set `rules.enabled: true` in ORC configuration, or `ORC_RULES_ENABLED=true`, and restart
the host to enable interception for ORC-managed sessions. Rule administration over
HTTP requires a configured `ORC_API_SECRET` and the normal authenticated API access.
No policy is enabled or installed globally by upgrading ORC.

Create a policy JSON file:

```json
{
  "workspace": "C:\\Projects\\my-app",
  "project_id": null,
  "rules": [
    { "id": "keep-files", "kind": "deny_delete", "reason": "Prevent deletion" },
    { "id": "no-comments", "kind": "deny_comments", "reason": "Prevent new code comments" }
  ]
}
```

Run `orc rules activate policy.json --reason "Project conventions"`. Updating requires
`--expected <current-revision>`. `orc rules list --workspace <directory>` exposes policy
revisions, redacted decisions and action status. `orc rules revert <current-revision>
--reason "Observed regression"` creates a new revision restoring the immediately previous
policy; reverting the initial revision disables it. Stale updates/reverts return conflict.
All previous versions and reasons remain stored. The dashboard's **Settings → Agent rules**
provides file-protection controls, current/history views and human revert.

API: `GET /api/rules`, `POST /api/rules/activate`, `POST /api/rules/revert` and
`POST /api/rules/check`. Check accepts a normalized event and performs a dry run: it
does not record a decision or enqueue a job. Rules are strict typed data, not scripts.
There is no MCP tool that lets a learning agent activate or weaken hard rules.

## Decisions and supported rules

- `deny_tools`: deny an exact list of tool names on pre-tool events.
- `deny_delete`: permit recognized structured writes/edits and reads, and deny deletion,
  rename, arbitrary shell execution, subagent delegation and unverified tools. This is
  deliberately conservative: a shell-text regex cannot safely classify every script.
  It protects file existence; ordinary replacement of a file's contents remains an edit.
- `deny_comments`: reconstruct supported file writes/edits and compare parsed JS/TS comment
  tokens with the current file. New or changed comment tokens are denied; existing comments
  may remain. Strings, URLs, regular expressions, templates and JSX text are distinguished
  from comments. Unsupported languages, patch tools, malformed/ambiguous edits or invalid
  syntax are denied. New license/directive comments are also comments and require a policy
  change. This does not judge whether a comment is useful or prohibit ORC task comments.
- `context`: provide explicit context on session start. Instruction delivery is recorded
  separately from proof that an agent followed it.
- `enqueue_job`: on `session_start`, successful `post_tool` or `session_end`, enqueue an
  existing enabled ordinary job belonging to the policy's project. `tools: []` matches all
  tools; otherwise match exact tool names. Policy definitions never contain shell commands.

Multiple matching policies/rules are combined; deny wins. An abstention preserves the
agent's normal permission checks. Every active policy protects ORC storage and recognized
hook/policy configuration files from structured edits, including resolved symlink targets.
File-protection rules also reject edits outside the workspace. Session identities and native tool IDs
deduplicate recorded events; an identity replayed with different input fails closed.
Decision records store input hashes rather than raw tool arguments or file contents.

## Agent coverage and failure behavior

The supported managed adapter is **Claude through the Agent SDK**. ORC injects synchronous
`PreToolUse` hooks before its automatic-approval paths, including SDK auto-approved tools.
SDK settings are isolated for guarded sessions and ORC supplies its own MCP connection.
The hook rechecks active policy on every event, so human policy changes/reverts apply to
guarded sessions. Enable the host setting before starting sessions; already running
unguarded sessions must be restarted.

Rule evaluation failure denies the pre-tool call. Hook callbacks have bounded timeouts;
the Claude hook reference documents blocking SDK callback timeouts. Native command-hook
failure blocking needs a newer Claude CLI; it must not be assumed for older installations.
[Claude hook reference](https://code.claude.com/docs/en/hooks).

`orc rules hook <claude|cursor|gemini> <event>` implements stdin JSON/stdout JSON protocols
against the local configured SQLite DB. Denials/errors exit 2. This works without a running
API, but is a transport adapter, not proof of coverage in every agent version.
`orc rules install-hook cursor --target <settings-file>` preserves existing entries, makes
a backup and adds explicit hooks with `failClosed: true`. Native host installation/version,
timeouts, crashes and actual edit payloads must be qualified before relying on that path.
[Cursor hook reference](https://cursor.com/docs/hooks),
[Gemini hook reference](https://geminicli.com/docs/hooks/reference/).

Other managed backends refuse sessions in policy-protected workspaces. Protected chat
cannot fall back to an unverified CLI/remote backend, and ORC refuses unqualified native
agent terminals/package setups in protected workspaces. Human shell terminals remain
available. Codex/ACPX/A2A/AgentAPI blocking coverage is not claimed by this release.

Hooks are not an OS sandbox. A human able to edit configuration, a process outside ORC,
an unmediated remote execution channel, or another concurrent filesystem writer remains
outside the guarantee. Path checks use canonical existing directories and symlink targets;
there is no kernel-level lock spanning the agent's eventual write. Workspaces/worktrees
outside the configured root need their own policy. Do not expose the shared installation
bearer token to untrusted tenants; ORC's authorization model remains a trusted installation.

## Deterministic job actions

Actions are written transactionally with the decision and dispatched through the existing
job executor under its configured capacity. Identical event/rule pairs enqueue once.
The dispatcher rechecks the active policy and current job/project before execution;
policy changes cancel pending old actions. The pending queue is bounded to 1,000; overflow
is retained as failed. Rule-triggered jobs carry `ORC_RULE_ACTION=1` to prevent recursive
rule action enqueueing in their descendants. The scheduler must be running to dispatch.

External effects cannot be made universally exactly-once across process crashes. A claimed
action is not blindly retried after restart: history records uncertain effects and the
retained run should be inspected before a human triggers the job again. Automatic retries
and arbitrary command actions are intentionally absent from this initial contract.

## Skill and flow quality

Ponytail's reuse-first and connected-code review procedures motivated narrow worker/reviewer
candidates. ORC retains the current skill baseline, proposed instructions, source rationale
and paired outcomes through the existing wiki/evolution store. Candidates are evaluated
before activation; adding a prompt or storing a lesson does not establish improvement.
[Ponytail source](https://github.com/DietrichGebert/ponytail/tree/9cc65d03aa2da1db7121b912d03596409ee340b8).

`bun scripts/evaluate-skill-quality.ts` is a paid real-agent paired diagnostic suite. It
alternates arm order in isolated temporary directories, retains injected skill hashes,
complete events/usage, execution failures and baseline/candidate results, and submits actual
outcomes to ORC's normal evaluation gates. Worker outputs face executable checks; reviewers
face seeded defects and clean controls. Its small fixtures and single runs are diagnostic,
not a statistically representative certification. No-gain candidates remain inactive.
Use independent production-like cases and repeated runs before generalizing a gain.

`bun scripts/validate-rules-runtime.ts` is a paid real-agent probe covering allowed edits,
blocked comment/shell-delete attempts, protected-file hashes, unsupported backend refusal,
deduplication and a real queued job. Retained state lives under `.claude/tooling/`;
production databases and global hook settings are untouched.

## Optional evidence review flow

Select `orc-evidence-review` on an already implemented task to use the existing reviewer
with connected-code tracing, concrete trigger inputs and executable evidence. It routes
verified work to done, demonstrated defects to changes_requested, and insufficient evidence
or reviewer errors to paused. It is bounded to one reviewer and does not replace the default
flow. This is a procedural option, not a measured quality improvement.

`bun scripts/validate-evidence-review.ts` runs the ordinary runner and authenticated API
against defective and clean expiry-boundary fixtures with a real agent.
`bun scripts/validate-rule-hooks.ts` checks actual CLI processes and settings installation
without changing global settings; `--executable=<path>` repeats it against a built binary.
The generic Gemini protocol requires stable tool-call IDs and has no supported installer;
payloads lacking IDs fail closed. Native host qualification remains separate.

`python scripts/validate-rules-binary.py <compiled-orc-path>` checks the embedded dashboard,
authenticated policy API, actual guarded Claude chat, file hashes, retained history after
restart and human revert against the compiled server. It uses port 7711 and isolated state.

## Dependency security deployment boundary

Repository installs use pinned patched releases of MCP SDK, simple-git, ip-address and
js-yaml. `patches/braces@3.0.3.patch` bounds pattern parsing and AST traversal because
[the braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no patched
release. `bun install --frozen-lockfile` applies that patch; CI tests malicious patterns,
actual runner/QMD dependency resolution, protected Git configuration and ordinary cloning.
Run `bun test scripts/dependency-security.test.ts` to verify it.

The package version remains 3.0.3, so raw `bun audit` still reports that advisory. The
patch does not transfer automatically to a separate published npm install; release work
must carry or otherwise replace that mitigation before claiming equivalent protection.
Existing moderate/low findings remain listed by the audit. No audit finding is hidden.

Native agent terminal launches also check the derived worktree directory before creating
a branch or worktree, then check the final directory before spawning. Reattaching a live
session checks the existing terminal directory before changing its session association.
Human shell terminals remain available in protected workspaces.
