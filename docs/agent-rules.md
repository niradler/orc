# Agent rules and evidence-based skill quality

ORC rules evaluate coding-agent events before selected tools execute, or enqueue an
existing job after a matching event. Skills guide reasoning; flows coordinate work;
rules return deterministic decisions. Policies are opt-in and scoped to an existing
absolute workspace directory and its descendants.

## Enable and manage policies

Set `rules.enabled: true` in ORC configuration, or `ORC_RULES_ENABLED=true`, and restart
the host to enable interception for ORC-managed sessions. Rule administration over
HTTP uses normal API authentication; configure `ORC_API_SECRET` to require a Bearer token.
No policy is enabled or installed globally by upgrading ORC.

Create a policy JSON file:

```json
{
  "workspace": "C:\\Projects\\my-app",
  "project_id": null,
  "rules": [{
    "id": "block-rm-rf", "kind": "event", "enabled": true,
    "reason": "Bash command text matched rm -rf",
    "scope": { "agents": ["claude"], "events": ["pre_tool"] },
    "filter": { "match": "all", "conditions": [
      { "predicate": { "field": "tool", "operator": "equals", "value": "Bash" } },
      { "predicate": { "field": "input.command", "operator": "contains", "value": "rm -rf" } }
    ] },
    "target": { "type": "block" }
  }
  ]
}
```

Run `orc rules activate policy.json --reason "Project conventions"`. Updating requires
`--expected <current-revision>`. `orc rules list --workspace <directory>` exposes policy
revisions, redacted decisions and action status. `orc rules revert <current-revision>
--reason "Observed regression"` creates a new revision restoring the immediately previous
policy; reverting the initial revision disables it. Stale updates/reverts return conflict.
All previous versions and reasons remain stored. The dashboard's **Rules** page (`/rules`)
shows an Applied rules table with Edit and Enable/Disable actions. Add rule opens one form. Select a template to autofill it, or fill the inputs manually. Settings manages workspace/project scope, agent
assignments, connections and policy history. The editor retains the
Scope → Filtering → Target definition; settings changes use the same validated policy revisions.

API: `GET /api/rules`, `POST /api/rules/activate`, `POST /api/rules/revert` and
`POST /api/rules/check`. Check accepts a normalized event and performs a dry run: it
does not record a decision, enqueue an action or execute a custom script. Rules are strict
typed data; explicitly selected custom scripts are trusted executable actions.
There is no MCP tool that lets a learning agent activate or weaken hard rules.

## Scope, filtering and targets

The `event` rule is the general editor model. Scope selects all supported agents or
specific agents, events to listen to, and the policy's workspace/project. Canonical
events such as `pre_tool` map to native names. Agent-specific events use `native:Name`
and require a specific agent scope. Unsupported events are not delivered by a host.
`GET /api/rules` returns the shared event/capability catalog used by UI and installers.

Filters apply identically to every target. Conditions select dotted fields such as
`input.command`, `tool`, `failed` or `payload.prompt`; operators are regex, contains,
equals, in, starts_with, ends_with and exists. Combine with ALL/ANY and per-condition NOT.
Equality and lists preserve scalar types. Regex uses pinned RE2JS with linear matching;
lookaround/backreferences are rejected. Maximum 32 conditions and 512 characters per
regex. Empty conditions match every event in scope.

Targets are block, inject context, run an enabled ORC job, or run a custom script.
Block/context require actual event capabilities. Synchronous scripts can return both
a decision and context. Background scripts use the existing queue and cannot change
the already completed hook decision.
Claude Notification/Setup are side-effect listeners without context injection. TaskCompleted
and TeammateIdle remain action listeners: native exit-code feedback differs from SDK JSON
control, so the shared catalog conservatively excludes declarative blocking there.

For a command filter, select all agents, Pre-tool, field `input.command`, Contains,
value `rm -rf`, then Block. This matches that spelling; regex/string filtering cannot
classify every equivalent shell program. Other tool names and other deletion methods are unaffected. There is no universal file-deletion preset.

## Decisions and supported rules

### Route commands through an external processor

The **Reusable rule catalog** on the Rules page provides Git/test RTK routing, a generic
command processor, pattern blocking, session guidance and synchronous guard templates.
Choose **Customize this rule** to load an independent draft, then change its scope, filter
and target and save. Loading does not activate it; saved copies remain yours when the
catalog changes. Existing IDs receive a new suffix rather than silently replacing a rule.
The same catalog is available through `GET /api/rules/catalog`, the SDK's `rules.catalog()`
and `orc rules catalog`. Export a policy draft with
`orc rules catalog rtk-git --workspace C:/Projects/my-app`; review it before activation.

The **Rewrite command with a processor** target uses the existing Scope → Filtering → Target
editor. Select **Claude**, **pre tool**, and narrow conditions on `tool` / `input.command`.
The initial qualified tool is Claude's **Bash**. Other agents/events reject this target
until their command replacement capability is implemented and verified.

```json
{
  "id": "compact-git-status",
  "kind": "event",
  "enabled": true,
  "reason": "Route Git status through my local processor",
  "scope": { "agents": ["claude"], "events": ["pre_tool"] },
  "filter": {
    "match": "all",
    "conditions": [
      { "predicate": { "field": "tool", "operator": "equals", "value": "Bash" } },
      { "predicate": { "field": "input.command", "operator": "equals", "value": "git status" } }
    ]
  },
  "target": {
    "type": "rewrite_command",
    "argv": ["rtk", "rewrite", "{command}"],
    "timeout_ms": 1000,
    "rewrite_exit_codes": [0, 3],
    "passthrough_exit_codes": [1]
  }
}
```

RTK is an example, not an ORC dependency. Any trusted local CLI can implement this contract:

1. ORC checks all original-command rules before running a processor.
2. The processor receives the normalized event as stdin JSON. A complete `{command}`
   argument is replaced by the original command as **one literal argument**, without shell
   interpolation. The configured executable is never interpolated.
3. On a configured rewrite exit code (default `[0]`), stdout must be a nonempty replacement
   command. On a passthrough exit code (default `[]`), stdout must be empty.
4. ORC rechecks the replacement against active blocking rules and synchronous guard scripts.
   Validation does not reroute or enqueue another job/background script.
5. Claude receives `updatedInput.command`, executes it with its normal permission checks,
   and returns its stdout/stderr and exit status. ORC never auto-allows a rewritten command.

A custom processor can simply parse stdin and print its chosen replacement command. It
must plan the command rather than execute it: execution belongs to the host, preventing
duplicate execution. The replacement program is responsible for preserving the original
command's intended behavior and exit semantics; ORC does not certify arbitrary wrappers.

Processors have a 100–2000 ms timeout and 64 KiB stdout/stderr bounds. Missing executables,
timeouts, oversized/invalid output, unknown exit codes, ambiguous multiple matches or failed
replacement checks deny the call. Configured passthrough is explicit; there is no automatic
fallback after a failure. Narrow overlapping filters rather than relying on rule order.
Synchronous guards and processing share a bounded budget, including replacement validation.

Current RTK `rewrite` documents 0/3 as rewritten commands, 1 as passthrough and 2 as denial;
use the mappings above, and ensure the returned command's executable is on the agent host's
PATH. [RTK rewrite protocol](https://github.com/rtk-ai/rtk/blob/master/src/hooks/rewrite_cmd.rs).
ORC does not install RTK or its hooks. Native Claude hooks use the same target through
`orc rules hook claude PreToolUse`; their host version/trust still needs qualification.

`/rules/check` only previews the selected processor; it does not execute it or produce a
replacement. Existing revision history and enable/disable controls apply. `command_route`
history records a redacted rewritten/passthrough/denied outcome and replacement input hash,
not the original/replacement command or output. Configured processor arguments are policy
data and remain visible in policy history: do not embed credentials in them.
Processors are trusted programs, inherit the host environment and receive tool input;
they are not sandboxed. Referenced local processor files receive the same structured-edit
protection as rule scripts. Processor planning runs on each delivered hook, including a
replay; it must be safe to repeat. The agent host owns actual command execution.

`bun scripts/validate-command-processors.ts <rtk-executable>` runs an isolated real-agent
probe with RTK, a custom CLI, a nonzero replacement exit and original/replacement denials.
Evidence is retained under `.claude/tooling/command-processors/`.

All rules use the same event/filter/action schema. The catalog contains explicit command
and file-text checks, session guidance, command routing and built-in ORC actions. There
are no special deletion-prevention or language-comment rule types.

For example, the Bash rm -rf template tests tool equals Bash and input.command against
its visible regex. It does not cover alternate flag order, Python deletion or other tools.
The comment-marker template checks Write content and JS/TS filename text; it matches
URLs and strings containing the same markers too. The separate comment guidance template
injects an instruction and does not block tools. Users edit the actual conditions before saving.

Multiple matching policies/rules are combined; deny wins. An abstention preserves the
agent's normal permission checks. Every active policy protects ORC storage and recognized
hook/policy configuration files from structured edits, including resolved symlink targets.
Session identities and native tool IDs
deduplicate recorded events; an identity replayed with different input fails closed.
Decision records store input hashes rather than raw tool arguments or file contents.

## Agent coverage and failure behavior

The supported managed adapter is **Claude through the Agent SDK**. ORC registers supported
SDK lifecycle hooks, including synchronous `PreToolUse` before automatic-approval paths.
Managed SessionStart is evaluated explicitly before each startup/resume query and its
context is appended to the agent prompt. SDK startup callbacks are not relied on: some
SDK launches register them after that native lifecycle event has already occurred.
SDK settings are isolated for guarded sessions and ORC supplies its own MCP connection.
The hook rechecks active policy on every event, so human policy changes/reverts apply to
guarded sessions. Enable the host setting before starting sessions; already running
unguarded sessions must be restarted.

Rule evaluation failure denies the pre-tool call. Hook callbacks have bounded timeouts;
the Claude hook reference documents blocking SDK callback timeouts. Native command-hook
failure blocking needs a newer Claude CLI; it must not be assumed for older installations.
[Claude hook reference](https://code.claude.com/docs/en/hooks).

`orc rules hook <claude|cursor|gemini|codex> <event>` implements stdin JSON/stdout JSON protocols
against the local configured SQLite DB. Denials/errors exit 2. This works without a running
API, but is a transport adapter, not proof of coverage in every agent version.
`orc rules install-hook <claude|cursor|gemini|codex> --target <settings-file>` preserves
existing entries, makes a backup and installs supported listeners. `--events` narrows
listeners using comma-separated canonical or native names. Explicit targets are Claude
settings JSON, Cursor hooks JSON, Gemini settings JSON, or Codex hooks JSON. Cursor uses
`failClosed: true`; Claude uses `onFailure: "block"`, requiring CLI v2.1.295 or newer.
Gemini timeouts are milliseconds; other native handler timeouts are seconds.
WorktreeCreate is excluded because Claude requires its hook to replace native creation. Native host installation/version,
timeouts, crashes and actual edit payloads must be qualified before relying on that path.
[Cursor hook reference](https://cursor.com/docs/hooks),
[Gemini hook reference](https://geminicli.com/docs/hooks/reference/),
[Codex hook reference](https://learn.chatgpt.com/docs/hooks). Codex requires host trust;
its native hooks do not intercept every hosted tool or execution path.

Other managed backends refuse sessions in policy-protected workspaces. Protected chat
cannot fall back to an unverified CLI/remote backend, and ORC refuses unqualified native
agent terminals/package setups in protected workspaces. Human shell terminals remain
available. Native Codex protocol support does not qualify ORC-managed Codex/ACPX/A2A/AgentAPI blocking.

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
retained run should be inspected before a human triggers the job again. Automatic retries remain absent.

Custom scripts use an executable/argument array without shell interpolation and receive
the normalized event as stdin JSON. A synchronous script returns strict JSON such as
`{"decision":"deny","reason":"Policy rejected command","context":[]}` or
`{"decision":"abstain","context":["Project guidance"]}`. Stdout is bounded to 64 KiB.
Nonzero exit, timeout, malformed output or unsupported decisions fail closed. Each sync
script has at most a 2-second timeout; matching scripts share a 5-second budget.
A pending deny is persisted before execution: uncertain effects after a crash are not
retried on receipt replay. Recognized structured edits protect referenced script files.

Background scripts run through the ordinary executor with bounded timeouts and the
event's working directory. Pending input is temporarily retained as JSON in the action
queue and erased after completion, failure or cancellation. Unlike redacted decision
records, pending script input may contain sensitive tool arguments. Protect the installation
DB and select trusted scripts. Scripts inherit runner environment and are not a sandbox.

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

`bun scripts/validate-event-rules-runtime.ts` exercises the flexible editor model with
a real Claude SDK agent under both bypassPermissions and whitelist auto-approval. It
checks actual regex and synchronous-script denials with absent filesystem markers, allowed
execution, observation of an injected random context token, and job/background script
execution triggered by actual PostToolUse events. Only harmless marker writes are attempted.
Failed and successful evidence is retained under `.claude/tooling/event-rules-runtime/`.
This verifies managed Claude; other native hosts still require their own qualification.

## Optional evidence review flow

Select `orc-review-only` on an already implemented task to use the existing reviewer
with connected-code tracing, concrete trigger inputs and executable evidence. It routes
verified work to done, demonstrated defects to changes_requested, and insufficient evidence
or reviewer errors to paused. It is bounded to one reviewer and does not replace the default
flow. This is a procedural option, not a measured quality improvement.

`bun scripts/validate-evidence-review.ts` runs the ordinary runner and authenticated API
against defective and clean expiry-boundary fixtures with a real agent.
`bun scripts/validate-rule-hooks.ts` checks actual CLI processes and settings installation
without changing global settings; `--executable=<path>` repeats it against a built binary.
All four native protocols and settings merge/reinstallation are checked. Native host
qualification remains separate from adapter/installer tests. Gemini events without stable
tool IDs, and lifecycle events without generation/turn IDs, use fresh receipts; identical
redeliveries without host identities cannot be universally deduplicated.

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
# Built-in continuity and learning catalog

The Rules catalog includes editable templates for loading project context, recording significant tool events, snapshotting before compaction, restoring after compaction, sharing Claude memory topics, and queuing wiki learning. Loading a template creates a draft; save it to activate it for the selected workspace. Every action remains configurable in the rule editor.

These templates use `orc_action` targets: `load_context`, `record_event`, `snapshot_session`, `restore_session`, `sync_agent_memory`, and `queue_knowledge_digest`. Actions call the authenticated local API and reuse existing ORC services. Configure the same database, `ORC_API_BASE`, API secret, and `ORC_RULES_ENABLED=true` for the agent hooks and API. Dry runs select actions without executing them. Receipt history records outcomes without storing returned context or imported note bodies. Continuity failures appear as diagnostics; command guards retain their existing enforcement behavior.

The three old continuity scripts under `hooks/` now forward native events to the rule dispatcher. Install the native adapter into an explicit settings file; use `orc rules install-hook claude --target <settings-file> --legacy-hooks-dir <absolute-hooks-directory>` to replace those specific old handlers while preserving other hooks and creating a backup. Live-session identity and transcript connection remain adapter plumbing. This migration does not install global settings automatically.

`claude-share-memory` imports local Claude Markdown topic files into project-scoped ORC memory. Set its directory to `auto` or an explicit absolute path. Successful file writes trigger an import; session end rescans the configured directory. Each topic file's frontmatter `name` (normalized to a lowercase-hyphenated memory name) and `description` plus its body become one memory; updating the topic updates that memory, recorded in its history. Files without a description or over the memory content cap are skipped and reported. The `MEMORY.md` index is excluded. A project is required. Imported notes remain attributed facts, not automatically promoted instructions. Files are bounded and symlink escapes are rejected. Explicit configuration is required for remote memory sources or Claude settings overrides that automatic directory discovery cannot see. Source deletion does not delete shared memories.

`orc-wiki-learning` queues the existing enabled `orc-knowledge-digest` job after changed inputs, coalesces outstanding requests, and runs through the existing scheduler. It launches no model inside the hook. Enable this rule deliberately: the existing learning job can incur model charges and update wiki or skill instructions. The trigger checks the rule project for changed inputs; the existing global job then visits all changed project scopes, each with its own digest completion watermark, as scheduled learning does. Digest sessions suppress built-in continuity actions to prevent recursive learning triggers while retaining command guards.
