# OpenCode

[`@orc/opencode`](https://www.npmjs.com/package/@orc/opencode) enforces ORC rules inside
[OpenCode](https://opencode.ai) through OpenCode's native plugin hooks. The same workspace
policies that guard Claude, Codex, Cursor, Gemini and Pi also guard OpenCode: block
dangerous tool calls, gate prompts, inject guidance and trigger ORC automation.

## Install

Requires OpenCode 2.x and the `orc` executable on `PATH`. Add the plugin to
`opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@orc/opencode"]
}
```

Or point `plugins` at a directory that contains the plugin package (OpenCode 2.x
resolves a plugin directory through its `package.json`; a single `.js` file is ignored):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/@orc/opencode"]
}
```

Enable enforcement in ORC settings (`rules.enabled: true` or `ORC_RULES_ENABLED=true`) and
activate a policy for the workspace on the **Rules** page or with `orc rules activate`.
There is no `install-hook` step; OpenCode loads the plugin itself.

## ORC-managed sessions

A chat or worker that ORC starts with the OpenCode backend needs no manual install. ORC
adds the bundled plugin and the dangerous-command permission baseline to a session-scoped
`OPENCODE_CONFIG_CONTENT` document at spawn. OpenCode merges that layer after global and
project configuration, so the ORC entries win without editing the user's
`opencode.json`; plugins from both layers load. The session also receives
`ORC_COMMAND`, `ORC_DB_PATH`, `ORC_API_BASE` and `ORC_API_SECRET` so the hook child reads
the same ORC database and API as the session.

The baseline asks the human before `daemon stop`/`restart`, process kills, `sudo`,
destructive `rm`/`rd`/`del`/`format`/`mkfs`, forced pushes, hard resets, `shutdown` and
`reboot`. Everything else keeps OpenCode's own policy, so ordinary shell commands do not
start prompting. The plugin's `execute.before` deny still runs first, and auto-approval
cannot bypass it.

If rules are enabled and a policy covers the session folder, ORC refuses to start the
session when the plugin bundle is missing, the database is in memory, or the session runs
on a remote execution host. The error names the missing plugin and
`ORC_OPENCODE_PLUGIN`, which can point at an explicit plugin directory. ORC never
downgrades a protected session to advisory enforcement.

## What you get

| OpenCode hook         | ORC phase       | Behavior                                          |
| --------------------- | --------------- | ------------------------------------------------- |
| `tool execute.before` | `pre_tool`      | Block the call, rewrite its input, or add context |
| `tool execute.after`  | `post_tool`     | Observe results, add context, trigger automation  |
| `session prompt`      | `prompt_submit` | Block prompt admission or add context             |
| `session compaction`  | `pre_compact`   | Run pre-compaction rules and automation           |
| `session context`     | —               | Delivers queued rule context to the model         |
| `experimental.idle`   | —               | Delivers queued context before the session sleeps |

Every hook forwards to `orc rules hook opencode <event>`, the same adapter the other
agents use, evaluated against the local ORC database. The plugin fetches the workspace
rules plan from the ORC API and refreshes it at least every 30 seconds, so only events
that carry rules run the hook and ask-user rules get their approval lifetime plus a
grace period as the hook timeout. Rule context is queued per session and delivered on
the next model request. OpenCode has no session start/end hooks, so rules scoped to
those events are not delivered here.

`experimental.idle` is the last delivery point before a session goes idle: queued
ORC context is admitted as a synthetic message that runs in the same execution
instead of waiting for the next prompt. The hook is experimental in the OpenCode
SDK — the plugin feature-detects it, and on hosts without it (or without the
synthetic API) context still delivers on the next model request. A failed
delivery restores the queue in order; nothing is lost or duplicated.

## Failure behavior

Without a plan (ORC offline or unauthenticated), blocking hooks still run against the
local ORC database and fail closed; only a confirmed global disable
(`rules.enabled: false`) skips enforcement. A workspace without rules spawns no hooks.

- `execute.before`: a denied rule, hook crash or timeout rejects the tool call; the
  model sees the rule reason as a tool error.
- `prompt`: a denied prompt is rejected before the model runs. OpenCode 2.x surfaces
  this as a session error (qualified on OpenCode 2.3.0); the rule reason is recorded in
  the ORC audit trail.
- `execute.after` / `compaction`: observation fails open and never defects the session,
  but still waits for the hook up to its timeout.

Hooks are not an OS sandbox; see [Agent rules](./agent-rules.md) for the guarantee
boundary.

## Configure

Pass options through the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "@orc/opencode",
      "options": {
        "command": "orc",
        "rules": true,
        "timeoutMs": 30000,
        "apiBase": "http://127.0.0.1:7700",
        "secretEnv": "ORC_API_SECRET"
      }
    }
  ]
}
```

| Key         | Default                          | Purpose                                            |
| ----------- | -------------------------------- | -------------------------------------------------- |
| `command`   | `ORC_COMMAND` or `orc`           | ORC executable that runs the rule hook             |
| `rules`     | `true`                           | `false` loads the plugin without enforcement       |
| `timeoutMs` | `30000`                          | Minimum blocking hook timeout; ask-user rules may wait longer |
| `apiBase`   | `ORC_API_BASE` (unset otherwise) | ORC origin for the plan fetch and hook actions; when unset, the plan uses the local API and hooks use the orc config |
| `secretEnv` | `ORC_API_SECRET`                 | Environment variable holding the API secret        |

Session identity is forwarded as `ORC_SESSION_ID`, so rule decisions and writes are
attributed to the OpenCode session.

## ORC tools and sessions

The plugin enforces rules; it does not add ORC tools. For context, memories, skills and
tasks, register the ORC MCP server under `mcp.servers` (see [Connect agents](./connect-agents.md)).
OpenCode session history is read from its SQLite store and appears in the ORC chat session list
(see [Live sessions](./live-sessions.md)).
