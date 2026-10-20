# Sessions, execution hosts and Git

Sources: [Live sessions](https://github.com/niradler/orc/blob/master/docs/live-sessions.md), [Handoff](https://github.com/niradler/orc/blob/master/docs/session-handoff.md).

## Session continuity

Use the supplied ORC session ID. At meaningful milestones record decisions, failures,
artifact/commit references and next action with `session_event`; avoid per-line
noise. `session_snapshot` preserves compact context; after compaction use
`session_restore`, then refresh task/feedback and relevant guidance. Do not assume
every client has lifecycle hooks. `session_log` summarizes one completed work unit;
progress belongs in the existing handoff when ORC tools are unavailable.

Use Sessions or `orc session list` / `orc session show <id> --events` to inspect
recorded work. Native live sessions are separate: Sessions searches/transcripts
come from configured agent homes/watchers (`/api/sessions/live`), may need an
explicit sync, and are paged. Verify agent, cwd and task link before resuming.
Do not paste private native transcripts into shared memory/KBs. Snapshot before
compaction where the client cannot do it; restore before re-deciding earlier work.

### Hand off a native Claude/Codex session

This transfers a conversation into a **new** native session on the selected ORC
execution host; it preserves the original. The destination project must already
have the correct repository folder scope. Native transcripts are required, not
an ORC event snapshot. Parent sessions are required for Codex child-agent histories.

1. Identify native agent/session UUID, source cwd, repository remote, branch and
   repository-relative subdirectory. Inspect Git status and include only intended
   work. Required ignored files, environment/dependencies, LFS or submodules need
   explicit handling; they are not transferred automatically.
   Use `git rev-parse --show-prefix` (without its trailing slash) for the
   repository-relative subdirectory. Destination worktrees are created under
   `.orc/worktrees/<handoff-id>` in the selected repository; do not choose an
   unrelated existing checkout as a substitute.
2. Within the user's Git authorization, commit/push the intended state to the
   intended branch. Verify local HEAD equals `git ls-remote` for that branch.
   Do not force-push or push a protected/default branch without authorization.
3. Call `session_handoff` with project, agent, session_id, source_cwd, subdirectory,
   credential-free repository URL, remote, branch and exact pushed commit. The HTTP
   equivalent is `POST /api/session-handoffs`. Treat the returned `upload_url` as a
   secret: bounded, single-use, expiring after 15 minutes.
   Inspect the returned `max_bytes` and expiry before preparing the bundle.
4. Find the actual transcript: Claude under its configured home `projects/`;
   Codex under its configured home `sessions/` or an explicit archived rollout.
   Use `scripts/upload-session.py` from the **orc-platform skill root**:

   If that file is not locally accessible, request it with
   `skill_read({name: "orc-platform", ref: "scripts/upload-session.py", download: true, project})`,
   fetch the signed URL into `scripts/upload-session.py`, and verify the returned
   SHA-256/size. Do not recreate it from the MCP text. Keep both download and upload
   capabilities private; downloading the helper does not execute or authorize it.

   ```sh
   python scripts/upload-session.py --agent codex --session-file /path/to/rollout.jsonl --upload-url '<returned-url>'
   ```

   The helper uploads a version 1 transcript bundle and supported sidecars, not
   credentials/config, databases or the repository. Keep the source session idle
   and the recorded code state stable while snapshotting.
   Claude transcripts: `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<encoded-cwd>/<session-id>.jsonl`
   with supported subagent sidecars. Codex:
   `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl`
   or an explicitly selected archive. Use the actual parent native session.
5. Confirm `status: ready`, destination cwd and `live_session_id`, then use
   **Sessions → Open in terminal**. Upload acceptance alone does not prove readiness.

Inspect `GET /api/session-handoffs/<id>` on failure. After correcting a preparation
failure, retry `POST /api/session-handoffs/<id>/prepare` using normal auth. A consumed
or expired upload capability cannot be reused; a changed branch/SHA needs a new
handoff. Destination credentials/config apply; running processes, open shells and
external attachments are not transferred. Historical message paths stay historical.

## Terminals

Terminals execute on the API's execution host. Check readiness, backend availability,
project folder and shell before launch. Resuming a live session differs from starting
a new agent. API clients mint a one-shot terminal ticket before its WebSocket;
do not reuse tickets or expose them in logs. Keyboard data uses binary frames;
text frames are control messages. Follow the selected runtime's schema.

Verify the opened terminal's cwd/host and actual agent session. Resize/replay/exit
are transport state, not task outcomes. Close/stop only the selected session;
existing sessions can retain a previously selected host after settings change.

## Dashboard chat and backend readiness

Use dashboard chat for an intended interactive agent request; select the backend
and understand its execution cwd/context first. API integrations use
`POST /api/chat/stream` with a nonempty `messages` array of role/content records
and supported agent/options; consume SSE chunks plus final/error state. Stop/cancel
the owned request when abandoned. A connected stream without a final result is
not successful completion. Check backend readiness, auth, provider stderr/logs,
timeouts and rules before retrying; never switch to an unprotected backend to
bypass an enforced policy. Chat is not an automatic task flow or independent review.

`orc doctor` / `/api/backends` report usable backends, not just installed names.
Verify dependencies/login on the host that executes them. Profiles describe an
agent's role/tools/model; backends select SDK/CLI/HTTP transport. Unknown custom
names may route through ACPX; inspect resolution rather than treating a typo as
a verified backend. Tool installation does not supply credentials or enforcement.

## SSH execution host

Use Settings' execution-host selection or authenticated `GET /api/ssh`,
`POST /api/ssh/test`, `PUT /api/ssh` with the intended configured SSH alias.
Test connectivity/readiness before selecting it. ORC reads aliases from the
server's SSH config; establish host-key trust and key/agent login there, not in the
browser. ORC cannot answer interactive SSH password prompts. Inspect errors before
changing keys or forwarding; keep private keys/tokens local.

The remote host needs the intended repository, supported agent/runtime and host
inspection prerequisites, not another ORC database. Use remote filesystem paths
for project scope. Current SSH host mode requires OpenSSH connection sharing on
the central host (Linux/macOS or Docker); native Windows central ORC rejects it.
Remote host probing reports supported OS, binaries and login readiness.

Leave `ssh.remote_port` unset/blank for automatic callback forwarding. ORC asks SSH
for remote loopback port 0, captures/reuses the assigned port and propagates the
central API/MCP callback. Explicit port is an override; diagnose collisions/forwarding
policy before forcing it. Test central callback reachability from the remote host,
then a harmless intended command/session in the remote project. Existing terminals
keep their host; new work uses the new selection. Selecting local clears the SSH
host through the supported settings/API, not by editing live DB rows.

## Git, GitHub and worktrees

Use the Git workspace/registry or `GET /api/git/worktrees?cwd=<folder>` to inspect
the exact repository/checkouts; `/api/git/registry` aggregates known scopes.
Terminal Git actions apply to that terminal's host and cwd. Check status, branch,
base and user changes before staging/committing/pushing. Keep task links to the
actual artifact. Worktree cleanup/removal needs scope and dirty/untracked checks;
follow project instructions requiring the human to run destructive commands.

GitHub's `/api/github/items` feed reports relevant issues/PRs plus auth/errors;
an empty or truncated feed is not proof there is no PR. Check the intended repo,
filters and GitHub login/token availability on the execution host. ORC API auth
and GitHub auth are separate. Use available GitHub tooling for authorized PR writes,
reuse the existing PR and verify its branch/commit. The SDK/API feed is a read path,
not a general GitHub publishing endpoint. For complete implementation/PR delivery
use the Git delivery section of `orc-sdlc` development guidance.

