# Agent questions and approvals

An agent pauses, ORC evaluates its existing Rules, and an **Ask user** action creates
a durable request in **Activity → Attention needed**. Answer the question or review
the exact tool input, folder and host before approving or denying. The response
goes back to that agent's original pending call. ORC does not execute the command
or add privileges. Privileged execution and Windows UAC are deferred.

The inbox and its header indicator use ORC's shared SSE resource feed. A periodic
snapshot also recovers missed events and time-based expiration. Closing or
reloading the browser does not discard the request or answer.
To view a completed chat after reloading, open **Resume a conversation** in the
chat panel and select its saved conversation.

## Configure Rules

Enable Rules (`rules.enabled: true` in the existing ORC JSON configuration). In
Rules, add these catalog templates to the workspace policy:

- **ORC · Agent questions**: managed Claude/Codex structured questions and supported
  non-secret MCP forms.
- **ORC · Agent tool approvals**: managed Claude/Codex native permission requests,
  including command, file and additional-permission requests.

Select the Claude SDK backend (`claude`) or native Codex backend (`codex-cli`).
Use the agent's default permission mode when you want native approval prompts.
An agent configured to approve tools automatically may have no permission pause
to report. For Claude, a separate PreToolUse Ask user rule can require review even
when the agent otherwise auto-approves tools. Existing deny rules take precedence.

Rules can filter these events using the same filters as other actions. The
native question's actual text and choices appear in the inbox; its configured
rule prompt is used for ordinary approvals. Multi-select questions preserve
their selected values; a typed answer is also supported.

Question and approval rules are distinct. A question response does not approve a
tool. Ordinary approval only answers the native permission prompt; the agent's
own sandbox, deny rules and operating-system permissions still apply.

## Independently started agents

Explicit requests work through ORC's HTTP MCP endpoint or the existing CLI on any
machine that can securely reach ORC. No helper service is installed. This is also
the supported independent remote-agent path on a Windows central server. Native
SSH launches retain the existing Linux/macOS central-server requirement.

MCP workflow:

1. Call `human_request` with a stable origin session/backend/request identity,
   request kind, prompt and optional choices. Approval requests must also include
   the exact action, folder and host. Retain the returned request ID.
2. Call `human_request_get` with `id` and `wait_seconds: 30`. Repeat while pending.
   Only use the answer belonging to this workflow. Do not proceed on cancellation,
   expiration or unavailability; denial never authorizes execution.
3. After consuming the answer, call `human_request_acknowledge` with its returned
   ID and answered version. Acknowledgement records delivery, not command success.

The MCP tools accept readable project names and honor selected MCP project
bindings. A stdio caller's native session identity, when available, must match the
request origin.

CLI equivalents:

```sh
orc attention request request.json --wait
orc attention list
orc attention get REQUEST_ID
orc attention respond REQUEST_ID response.json --version 1
orc attention acknowledge REQUEST_ID --version 2
orc attention cancel REQUEST_ID --version 1
```

Use `-` instead of a file for JSON on stdin. Example question:

```json
{
  "origin": {"session_id": "my-session", "backend": "my-agent", "request_id": "color"},
  "kind": "question",
  "prompt": "Which color?",
  "choices": ["Blue", "Green"]
}
```

A response file contains `{"kind":"question","answer":"Blue"}` or
`{"kind":"approval","approved":false}`. Reusing an origin with changed content
is rejected. Concurrent, duplicate and stale-version responses are rejected.

### Claude native command hooks

The catalog also includes external Claude question/approval templates. Hook
timeouts must exceed the human request lifetime. For the 30-minute templates:

```sh
orc rules install-hook claude --target .claude/settings.local.json --events PreToolUse,PermissionRequest,PostToolUse,PostToolUseFailure,Stop --timeout-seconds 1815
```

This explicitly updates ORC handlers in that settings file and preserves unrelated
handlers. Install on a machine where the existing ORC CLI and policy database are
already available. Configure its authenticated API connection through existing
secure configuration/environment references.

PreToolUse approvals are qualified against a real independent Claude process.
Approved execution is acknowledged by its post-tool hook; a denied tool has no
post-tool hook, so its natural Stop acknowledges the denial. Keep those lifecycle
handlers installed. PermissionRequest uses its distinct native JSON decision
envelope and does not rely on exit code 2 to deny.

Native hook availability depends on the installed agent and launch mode. In the
tested Claude CLI 2.1.310, print mode did not expose AskUserQuestion with a command
hook alone. Use the proven managed SDK question path or explicit MCP/CLI requests
for that case. An independently running Codex terminal cannot be intercepted by
ORC's separate app-server session; use explicit MCP requests there. Plain text
such as “Should I continue?” is not a structured pause event.

### Cursor Agent

Real Cursor Agent validation covers explicit MCP questions and approval replies,
plus native Shell approval through its existing `preToolUse` Rules hook. For
native Shell review, configure an event rule scoped to Cursor, `pre_tool`, with
tool equal to `Shell`, and an **Ask user → Approval** action. Install the matching
receipt hooks as well:

```sh
orc rules install-hook cursor --target .cursor/hooks.json --events preToolUse,postToolUse,postToolUseFailure --timeout-seconds 1815
```

Supply a valid working directory; ORC rejects an empty native hook directory.
Approval returns Cursor's native permission response. The original Cursor process
executes the command; its tool result acknowledges delivery. A denied tool's
failure event acknowledges the denial.

For questions, use the explicit MCP workflow above. Cursor native question
interception is not qualified. In unattended Cursor CLI runs, approving the MCP
server with `--approve-mcps` can still leave individual tool calls blocked. Allow
only the required tools in the workspace's `.cursor/cli.json`, following
[Cursor's permissions reference](https://prod.cursor.com/docs/cli/reference/permissions):

```json
{
  "permissions": {
    "allow": [
      "Mcp(orc:human_request)",
      "Mcp(orc:human_request_get)",
      "Mcp(orc:human_request_acknowledge)"
    ]
  }
}
```

Replace `orc` with that server's name in `.cursor/mcp.json`. This permits calling
the request service; it does not approve the requested action.

## Telegram and Slack

Enable either notification checkbox on the Ask user action. The existing gateway
sends requests to authorized chats on that platform whose selected project
matches the request. Select the intended project in the gateway chat first.
Notifications are off by default.

The notification supplies an explicit response command:

```text
/attention REQUEST_ID VERSION answer My answer
/attention REQUEST_ID VERSION approve
/attention REQUEST_ID VERSION deny
```

Replies are checked against the current authorized user and the original
chat/thread/request/version binding before they reach agent chat. Large requests
that cannot be shown completely, and multi-select forms, require the web inbox.
Notification failures retry through durable leases; a repeated notification cannot
cause a repeated decision. Telegram/Slack routing is tested at the adapter boundary;
live provider credentials were not used during validation.

## Lifecycle and limits

| Situation | Behavior |
| --- | --- |
| Browser disconnect/reload | Request and answer remain in SQLite; SSE reconnect fetches the current snapshot. |
| Native call cancelled | Pending request is cancelled; a late answer is rejected. |
| Native connection lost | Request becomes unavailable and cannot authorize anything. An abruptly lost waiting owner is detected after its 30-second heartbeat lease. |
| Rule changed/disabled while waiting | The old review is invalidated. Every matching rule revision must remain active. |
| Answer saved | Shows answered until delivery is acknowledged; this does not mean a command ran. |
| Managed daemon dies | Requests remain, but a dead native process is not automatically recreated. Its outstanding owned request becomes unavailable. |
| Independent CLI/MCP workflow restarts | It can reconnect using its retained request ID and stable origin. |
| Expired or unavailable request | No approval is granted; unavailable answers remain visible for inspection and can be dismissed. |

Supported MCP forms contain non-secret primitive fields. URL authentication,
secret fields and unsupported schema constraints are explicitly cancelled with a
status explaining that the native client is required. Passwords belong in a
separate credential flow, never in an inbox answer.
