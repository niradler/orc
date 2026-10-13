# Continue a local session in ORC

Use the bundled `orc-handoff` skill with Claude Code or Codex. The agent commits and
pushes the intended work, verifies the remote SHA, calls `session_handoff`, and uploads
its native conversation. In **Sessions**, the imported session appears as **Ready**.
Choose **Open in terminal** to continue it.

The destination project must already exist in ORC with its folder scope pointing to a
repository on the selected execution host. Its configured remote must match the reported
repository. ORC does not clone arbitrary repository URLs supplied in an upload.
SSH mode installs files on the same SSH host/user that runs the resumed agent, including
a Docker container reached through an SSH alias. Persist the agent home and repository
volumes if sessions must survive container replacement. The host needs Git, the relevant
agent CLI and, for remote file operations, Python 3.

## HTTP contract

All operations are available through the API. MCP exposes one convenience tool:
`session_handoff` forwards the same initiation request over HTTP. The SDK exposes
`client.handoffs.create`, `get` and `prepare`.

| Operation | Endpoint | Authentication |
| --- | --- | --- |
| Initiate | `POST /api/session-handoffs` | ORC Bearer secret |
| Upload | `PUT /api/session-handoffs/{id}/upload?token=…` | Temporary upload capability |
| Inspect | `GET /api/session-handoffs/{id}` | ORC Bearer secret |
| Retry preparation | `POST /api/session-handoffs/{id}/prepare` | ORC Bearer secret |
| Resume | `POST /api/terminals` with `live_session_id` | Existing terminal authentication and workspace rules |

Initiation accepts `project` (readable name), `agent` (`claude` or `codex`), native
`session_id` (UUID), `source_cwd`, `repository` (credential-free URL), `remote`
(default `origin`), `branch`, exact pushed `commit` (40-character SHA), optional
`subdirectory` (relative repo folder) and optional `title`.

The returned upload link expires after 15 minutes and is single-use. It authorizes only
that handoff, not inspection, terminal launch or other API calls. Upload a JSON body:

```json
{"version":1,"files":[{"path":"session.jsonl","content":"native JSONL text\n"}]}
```

The full encoded body is limited to 64 MiB and 128 files, including actual streamed
bytes regardless of Content-Length. Claude also accepts `subagents/agent-*.jsonl`.
Codex accepts one native rollout. Arbitrary paths, credentials/config and agent SQLite
databases are rejected. Native conversation IDs are verified before consuming the link.
The skill includes a Python upload helper; no SCP or access to the destination filesystem
is required on the source machine.

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
copied into a new native UUID, with structured cwd metadata relocated; historical
message/tool text is retained. Custom native storage uses the execution host's
`CODEX_HOME` or `CLAUDE_CONFIG_DIR` when set.

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
