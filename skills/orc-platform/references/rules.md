# Rules, hooks and enforcement

Skills guide reasoning; flows coordinate work; rules return deterministic decisions
for supported events. A prompt instruction is not an enforced policy or OS sandbox.
Source: [Agent rules](https://github.com/niradler/orc/blob/master/docs/agent-rules.md).

## Inspect, check and apply

1. Identify the absolute workspace and actual execution backend. Inspect the Rules
   dashboard or `orc rules list --workspace <directory>`; use
   `orc rules catalog` to inspect available templates. Do not activate a template
   merely because it exists.
2. Rules are opt-in (`rules.enabled` / `ORC_RULES_ENABLED`). Read the current
   event/capability catalog and policy revision through `/api/rules`. A workspace
   outside the configured root needs its own scope. Runtime enabling/restarts and
   policy activation require the user's intended scope.
3. Draft strict scope/filter/target data. Dry-run a normalized event with
   `orc rules check <event-file>` or `POST /api/rules/check`. Check matching and
   nonmatching cases; dry run does not execute scripts/jobs or record a decision.
4. For an authorized policy change use `orc rules activate <policy-file> --reason
   <reason>`, adding `--expected <current-revision>` for an update. Verify the new
   revision and actual supported runtime behavior. Stale updates require rereading,
   not retrying with a fabricated current revision.

Native hook installation uses `orc rules install-hook --help` for the selected
client/settings file. Preserve existing hooks and inspect the resulting file.
Backend/version/event support differs; an installed hook or successful policy save
does not establish interception of every tool. Consult the linked coverage section
for the selected runtime. Protected work must not fall back to an unqualified
backend to bypass policy. Human policy changes remain authoritative.

## Diagnose and recover

Inspect redacted decisions/action results and the active workspace/revision before
changing a failing rule. Distinguish a denied operation, unsupported host/event,
hook transport failure and a queued background action. A background action cannot
retroactively block the tool that already completed.

For an authorized revert inspect history and the exact current revision, then use
the documented `orc rules revert` operation with a reason; it creates a new audited
revision and reverting an initial policy disables it. Follow any project requirement
that the human run destructive/revert commands. Do not weaken rules through another
interface when MCP cannot administer them. Keep secrets out of policy/scripts/logs;
custom script targets are trusted executable code and require their own review.
