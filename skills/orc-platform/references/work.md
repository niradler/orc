# Projects, tasks and operations

Contents: projects/tasks/flows/status; jobs/gateway; tags/audit/monitoring.
Sources: [Task flows](https://github.com/niradler/orc/blob/master/docs/task-flows.md),
[Usage](https://github.com/niradler/orc/blob/master/README.md#usage).

## Project and task operations

Discover the project with `project_list` or `orc project list`; inspect its folder
scope and execution host. MCP `project` arguments take readable names. CLI defaults
to the configured active project; use its explicit project option when appropriate.
For HTTP MCP, `?project=orc` sets connection-wide defaults, while
`?projects=orc,project2` combines selected projects' lists/searches and defaults
new work to the first project. A tool's explicit project can select another
project from that URL. See [MCP query parameters](setup.md#customize-the-http-mcp-connection)
for `mode`, validation and examples; connection selection does not change the
configured active project or relocate existing resources.
Inspect `task_list`/`task_get` before creating work. Record outcome, acceptance
criteria, constraints and expected artifacts in the task; keep progress in comments.
Use dependency-linked batches only for useful separate work units.

Common start: `orc project add my-app --scope <absolute-repo-folder>`,
`orc project use my-app`, then `orc project show my-app` to verify scope.
Changing the active project does not relocate repositories or change existing
terminal hosts. Inspect/create tasks through Tasks or `task_create` / `orc task add`;
set outcome/criteria before starting work. For a batch use string `ref` values and
`depends_on` references; inspect resulting links, not just the number created.

For manual work, use the agreed task lifecycle. For a managed task, inspect
`flow_status`: its graph owns task status. Do not set `doing`, `review` or `done`
to jump a flow. A queued node is not a running agent. `flow_report` reports one
assigned node's declared outcome and evidence; it does not start the next node by hand.

Inspect effective `flow_list`/`flow_read` before attach/start. Built-ins provide
development (`orc-default`), development with human signoff (`orc-human-review`),
and existing-artifact review (`orc-review-only`). `orc-sdlc` chooses the appropriate
process. Custom flows remain supported; active runs retain their frozen definition.
Conditions are validated data, edges are ordered, and execution/time/visit budgets
bound rework. Human gates wait for an explicit human response. Do not treat tool
availability, review approval or a task status as merge/deployment authorization.

For a new managed task, inspect `orc flow show orc-default`, then within scope
`orc flow attach <task-id> --name orc-default --start`; verify `orc flow status
<task-id>` and the node/session ledger. In `orc-default`, `required_review: false`
skips independent agent review. `orc-human-review` always requires agent review
and human signoff even when that flag is false. A human gate is answered through
its dashboard action or `orc flow resume <task-id> --outcome <declared-outcome>
--summary <feedback>` after the actual human decision. Workers report
`flow_report({task, node, outcome, summary})`; they do not impersonate the human.

For a custom graph, start from the closest effective definition, validate with
`orc flow validate --file <flow.json>`, then create/attach only as requested.
See the Task flows source for ordered guards, loops, fan-out/joins and limits.
On stuck work inspect pending/running nodes, capacity, backend errors and exhausted
budgets before retrying. Use `orc flow halt <task-id> --reason <reason>` only for an
intended stop, then verify nodes/sessions stopped. Do not reset DB rows or silently
replace frozen flow definitions to force progress.

For a status report, gather scoped tasks, flow/node states, jobs and sessions.
Lead with completed results, active work, concrete blockers and decisions needed;
include identifiers/links and timestamps when useful. Do not infer activity from
an old task status or repeat every log entry.

Inspect last activity and compare to the report's time window; distinguish agent
review from waiting for a human. Include counts, completed-since-last-report changes,
blocker causes and the next decision/action. Avoid an arbitrary universal stall timer.

## Jobs and gateway

Jobs execute configured commands: inspect command, cwd, environment, trigger and
timeout before running. `job_list`, `job_run`, `job_status` cover agent operations;
use CLI/API help for creation and schedules. `cron` replaces the old `repeat` trigger.
Verify a run's exit code and bounded log output; scheduler presence is not success.

Example for an intended test job: `orc job add verify --command "bun test"
--trigger manual --timeout 300 --project my-app`, inspect `orc job show verify`,
run with `orc job run verify`, then `orc job runs verify --logs`. Verify the actual
cwd/project and command before executing; add cron/watch only when recurring work
is wanted. Pausing a schedule uses job update/disabled; inspect whether an already
running job still needs an explicit stop. Check retries, timeout and scheduler logs
on failure instead of endlessly triggering duplicate work.

Gateway setup uses `gateway.telegram` / `gateway.slack` settings and channel
credentials. Configure authorized user IDs and intended project/backend routing;
keep tokens private. Check connection logs, message routing and the actual approval
path. Do not send messages to other people unless the user requested it. Existing
session routing, remote approval and new-session launch have different effects;
inspect the selected chat/session before acting. See the README Gateway section
for the channel's current config rather than copying a stale command list.

After authorized setup, `orc gateway status` verifies adapters/sessions; the full
daemon runs the gateway, while an API-only process does not. On Telegram/Slack use
`/help` to discover current commands. `/mode direct` handles ORC commands;
`/agent <backend>` or `/mode agent:<backend>` selects a live agent; `job:<name>`
routes messages to that configured job. Inspect `/project`, `/cwd` and `/sessions`
before sending work. A wrong mode can explain apparently ignored messages.

Live agent permission prompts require the human's Allow/Deny decision. Managed
human gates send notifications; an independent agent review round is not itself a
human signoff. Inspect the task/gate before `/approve` or `/reject`; do not assume
every approval command means the same transition. Missing notifications: inspect
authorized_users, adapter health, chosen chat and actual human-gate state.

Telegram voice input uses configured `speech` (openai/groq/qwen); voice replies use
`tts` (openai/qwen). Inspect enabled/provider/credentials, the execution host's
ffmpeg availability and provider connectivity. `voice_only` versus `always` controls
reply behavior. Configure within scope and verify a user-authorized voice exchange;
do not send messages to other people as a test or expose provider keys in logs.

## Tags, audit and monitoring

Use tags to organize/filter resources, not as proof of authorization or flow state.
Inspect `GET /api/tags`, then update the intended resource using its current schema
or dashboard. Verify the scoped filter and preserve other tags; do not invent a
separate tag-management API or assume cross-project names identify the same task.

`audit_list` / `GET /api/audit` inspect knowledge changes by project/session/action.
Read a bounded time range; follow subject/change IDs to memory, document or skill
history before correcting/reverting. Audit is provenance, not automatic proof that
content is true. Keep sensitive transcripts/credentials out of shared audit notes.

For health/activity use `orc status`, `orc doctor`, job/flow/session state and bounded
server logs. Integrations can subscribe to authenticated `GET /api/events` SSE
change notifications; events indicate resources to refresh, not full current state.
Reconnect and refetch after interruption. Select the intended host/API/project;
an old UI count or a running process is not proof that the latest operation succeeded.
