# Commands that need user input

Agents call the MCP tool `command_request` to create an item in **Attention needed**.
Provide `origin` (the requesting session/backend and an idempotent request ID),
`prompt`, and `command` with an exact `host` (`null` means the API machine),
`cwd`, `script`, optional `arguments`, and `timeout_seconds` (1–300, default 60).

Declare arguments as `{name:"PASSWORD",label:"Service password",required:true}`.
Use quoted environment variables in the script, for example
`my-cli login --password "$ORC_INPUT_PASSWORD"`.
Do not include secrets in the tool call, script, prompt or argument labels.

The request does not execute anything. The user reviews the host/folder, edits
the script, fills password-style fields, and clicks **Run command**. Values are
cleared after submission and never stored in ORC's request, result or transcript.
The selected POSIX host needs Bun and sh. Commands run with that host user's
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
64,000 characters per stream and timeout stops the process group.
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
