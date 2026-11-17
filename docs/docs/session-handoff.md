# Continue a local session in ORC

Use the bundled `orc-platform` skill's `references/execution.md` handoff section
with Claude Code or Codex. Within Git authorization, the agent commits and
pushes the intended work, verifies the remote SHA, calls `session_handoff`, and uploads
its native conversation. The chat session list shows the imported session as **Ready to resume**.
Click it to continue in chat, or copy its resume command from the session viewer.
The dashboard's [Send to host](#send-from-the-dashboard) move also supports OpenCode and Pi.

The destination project must already exist in ORC with its folder scope pointing to a
repository on the selected execution host. Its configured remote must match the reported
repository. ORC does not clone arbitrary repository URLs supplied in an upload.
SSH mode installs files on the same SSH host/user that runs the resumed agent, including
a Docker container reached through an SSH alias. Persist the agent home and repository
volumes if sessions must survive container replacement. The host needs Git, the relevant
agent CLI and, for remote file operations, Python 3.

## Send from the dashboard

A session can also be moved by a person, without the agent running the sequence:
**Send to host…** in the session's actions menu (the send icon) opens the saved ORC
servers from [Settings → Hosts](./desktop-and-web.md#settings), except the one you are
connected to. Pick a host, then one of its projects, optionally leave a note, and send.

The source installation then runs the same contract on your behalf:

1. It snapshots the session's repository through a temporary Git index — committed,
   uncommitted and untracked work, without touching the checkout — and leaves
   secret-looking files (`.env*`, keys, certificates, tfstate, …) on the source machine.
2. It pushes the snapshot as `orc/send/<send-id>` to the repository's `origin` and
   uploads the native transcript (Claude sidecars included) to the destination.
3. The destination prepares its worktree and shows the session as **Ready to resume**;
   the source row keeps a **Sent to …** badge, and the send result links straight to the
   destination session. Reopening Send to host on a moved session shows that link again.

The first chat turn on the destination carries a one-time handoff briefing: where the
session came from, the branch and snapshot, which files stayed local, and your note — so
the agent knows it resumed on another machine and checks dependencies before relying on
them. The destination host's token and proxy headers travel with the send request only;
the source never stores them.

Sending supports Claude Code, Codex, OpenCode and Pi sessions on the source server's own
machine, and both installations must reach the same Git remote. The destination project's
checkout must already exist there. OpenCode sessions move between the two machines'
OpenCode databases (the destination must have run OpenCode once; legacy pre-2.2 sessions
are refused with a hint to open them in OpenCode first). Pi resume in chat needs an
enabled Pi provider on the destination, like any Pi conversation. Errors (a missing
project, an unreachable host, a diverged remote) are recorded on the send and shown in
the dialog; nothing is cleaned up on the destination automatically, so a failed send can
be inspected there and retried.

## HTTP contract

All operations are available through the API. MCP exposes one convenience tool:
`session_handoff` forwards the same initiation request over HTTP. The SDK exposes
`client.handoffs.create`, `get` and `prepare`, plus `client.sessions.sendPreview`,
`sendTo` and `sends` for the dashboard-driven move.

| Operation | Endpoint | Authentication |
| --- | --- | --- |
| Initiate | `POST /api/session-handoffs` | Bearer token when an API secret is configured; otherwise open |
| Upload | `PUT /api/session-handoffs/{id}/upload?token=…` | Temporary upload capability |
| Inspect | `GET /api/session-handoffs/{id}` | Bearer token when an API secret is configured; otherwise open |
| Retry preparation | `POST /api/session-handoffs/{id}/prepare` | Bearer token when an API secret is configured; otherwise open |
| Resume | `POST /api/terminals` with `live_session_id` | Existing terminal authentication and workspace rules |

Initiation accepts `project` (readable name), `agent` (`claude`, `codex`, `opencode` or
`pi`), native `session_id` (UUID for Claude/Codex/Pi, `ses_…` for OpenCode), `source_cwd`,
`repository` (credential-free URL), `remote` (default `origin`), `branch`, exact pushed
`commit` (40-character SHA), optional `subdirectory` (relative repo folder), optional
`title` and optional `briefing` (delivered with the first resumed chat turn).

The returned upload link expires after 15 minutes and is single-use. It authorizes only
that handoff, not inspection, terminal launch or other API calls. Upload a JSON body:

```json
{"version":1,"files":[{"path":"session.jsonl","content":"native JSONL text\n"}]}
```

The full encoded body is limited to 64 MiB and 128 files, including actual streamed
bytes regardless of Content-Length. Claude also accepts `subagents/agent-*.jsonl`.
Codex and Pi accept one native log; OpenCode accepts one raw database export
(`session.jsonl` with a `session` header row and `session_message` rows). Arbitrary
paths, credentials/config and agent SQLite databases are rejected. Native conversation
IDs are verified before consuming the link. The skill includes a Python upload helper
for Claude/Codex; no SCP or access to the destination filesystem is required on the
source machine.

## Destination state

The upload is stored privately on the API machine. Preparation captures the selected
execution host, fetches the configured remote branch and requires its tip to equal the
reported SHA. A changed branch requires a new handoff. ORC creates:

```text
<destination-repo>/.orc/worktrees/<handoff-id>
```

The local branch is `orc/handoff/<handoff-id>`, tracking the reported remote branch.
Git's local exclusions keep this directory out of the original checkout's status.
ORC preserves existing branches, checkouts and session files. Conversation history is
copied into a new native session id (a UUID for Claude/Codex/Pi, a `ses_…` id for
OpenCode), with structured cwd metadata relocated; historical message/tool text is
retained. Custom native storage uses the execution host's `CODEX_HOME` or
`CLAUDE_CONFIG_DIR` when set; Pi honors `PI_CODING_AGENT_DIR`, and OpenCode installs
into its database under the execution host's home.

Before the first resume, the terminal API verifies the commit, a clean worktree and the
native transcript's presence. Successful launch marks the handoff `resumed`; later
resumes allow the session's subsequent edits and commits. Existing running terminals
are reused by the standard terminal API.
Deleting the ORC project keeps its handoff history and session as unassigned; it does
not remove the native files or worktree.

## Failures and limits

Inspect `status`, `error`, `cwd` and `live_session_id`. Upload returns the handoff record;
`status: error` means bytes were received but preparation failed. Fix the cause and call
the prepare endpoint, without uploading again. Preparation records and bundles survive
API restarts. A preparation lease can be recovered after five minutes; a ready handoff
is returned unchanged on retry. A consumed or expired link cannot upload again.

Only Git-tracked state is transported. Ignored files, dependencies, environment variables,
processes, external attachments, submodule checkouts and LFS hydration need separate
preparation. Destination CLI credentials and configuration remain its own. Standalone
Codex child-agent sessions are rejected: hand off their parent instead. Active child-agent
processes are not migrated. Keep the source idle during the final snapshot and continue
work in the destination once it is ready.
