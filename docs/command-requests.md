# Commands that need user input

Agents call the MCP tool `human_request` with `kind:"command"` to create an item
in **Attention needed**. The same tool supports ordinary questions and approvals;
`command_request` remains a compatible shortcut for commands.
Provide `origin` (the requesting session/backend and an idempotent request ID),
an optional short `title`, a `prompt` explaining why help is needed, and `command`
with an exact `host` (`null` means the API machine),
`cwd`, `script`, optional `arguments`, and `timeout_seconds` (1–300, default 60).

Declare as many inputs as needed (up to 20), for example
`{name:"PASSWORD",label:"Service password",description:"Used only for this login",required:true}`.
Every input is masked and redacted, including usernames, URLs and other values
that do not look like passwords. Inputs are never returned raw to the agent.
Use the execution host's shell syntax for environment variables, for example
`my-cli login --password "$ORC_INPUT_PASSWORD"` in bash/zsh or
`my-cli login --password "$env:ORC_INPUT_PASSWORD"` in PowerShell.
Do not include secrets in the tool call, script, prompt or argument labels.

The request does not execute anything. Attention shows compact rows; opening a
request reveals its purpose, host/folder, exact command and input descriptions.
The command is read-only until **Edit command** is selected. The user fills the
masked fields and clicks **Run command**, or cancels without running.
Only one request is open at a time; drafts survive collapsing/switching requests
and resizing without being saved in browser storage. Values are
cleared after submission and never stored in ORC's request, result or transcript.
The selected host needs Bun. Commands use the same default shell as terminals:
the host's configured shell (such as zsh or bash), or PowerShell on Windows.
A local terminal shell override also applies. Commands run with that host user's
permissions, without privilege escalation. Review commands before supplying credentials:
a command can use credentials to contact external services.

Poll `human_request_get({id,wait_seconds:30})` from the originating workflow while
pending/running. Once answered, consume `response` (`exit_code`, `stdout`,
`stderr`, `truncated`) and call `human_request_acknowledge` with that exact version.
The existing MCP session/project ownership checks also protect command results.

Values travel in the authenticated Run body and execution stdin, not process
arguments, files or logs by ORC. A command can still pass a value into its own child-process arguments or write it to its own files; prefer commands that accept credentials through environment variables or stdin. Literal supplied values and common URL/Base64/JSON
encodings are redacted before output leaves the execution host. Arbitrary
transformations and data sent to other services cannot be hidden by output redaction.
Keep secrets in the masked fields, not the editable command. Output is limited to
64,000 characters per stream and timeout stops the process group on POSIX or
the process tree on Windows.
Concurrent or repeated Run requests cannot execute twice. Interrupted runs become
unavailable after the execution lease; inspect the host before creating another request.
An unknown transport outcome is reported explicitly and never retried automatically.

# Chat and terminal folders

Before the first chat message, expand **Working folder** to select a host, browse
a folder, choose a recent folder, or create a new git worktree. Worktrees use the
same `.orc/worktrees/` location and branch naming as terminals. Existing conversations
retain their host and folder when resumed or reloaded.

Terminal and chat browsers share the last selected folder and up to 15 recent
folders per host in browser storage. Browse selections, recent selections and
completed typed folder fields update that history. Browser storage is optional;
blocked storage does not prevent launching a session.

Consecutive chat tool calls share a collapsed group; expand it to inspect each
call's arguments and result. Thinking and status entries separate groups.
