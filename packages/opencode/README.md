# @orc/opencode

ORC rules for [OpenCode](https://opencode.ai). A native OpenCode plugin that enforces the
same workspace policies as Claude, Codex, Cursor, Gemini and Pi: block dangerous tool
calls, gate prompts, inject guidance and trigger ORC automation — all evaluated by
`orc rules hook opencode` against the local ORC database.

Requires OpenCode 2.x (plugin API) and the `orc` executable on `PATH`.

## Install

Add the plugin to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@orc/opencode"]
}
```

Or drop the self-contained bundle into the project's plugin folder (no package install):

```bash
cp node_modules/@orc/opencode/dist/plugin.js .opencode/plugins/orc.js
```

Rules must be enabled in ORC settings (`rules.enabled: true` or `ORC_RULES_ENABLED=true`),
and a policy must cover the workspace. Manage policies on the ORC **Rules** page or with
`orc rules activate`. No `install-hook` step is needed; OpenCode loads the plugin itself.

## What it enforces

| OpenCode hook         | ORC phase       | Behavior                                          |
| --------------------- | --------------- | ------------------------------------------------- |
| `tool execute.before` | `pre_tool`      | Block the call, rewrite its input, or add context |
| `tool execute.after`  | `post_tool`     | Observe results, add context, trigger automation  |
| `session prompt`      | `prompt_submit` | Block prompt admission or add context             |
| `session compaction`  | `pre_compact`   | Run pre-compaction rules and automation           |
| `session context`     | —               | Delivers queued rule context to the model         |

OpenCode has no session start/end hooks, so rules scoped to those events are not delivered
here; the shared catalog keeps them for agents that support them.

## Failure behavior

The plugin fetches the rules plan from the ORC API (refreshed at least every 30s): only
events that carry rules run the hook, and ask-user rules extend the hook timeout by their
approval lifetime. Without a plan (ORC offline), blocking hooks still run against the
local ORC database and fail closed; only a confirmed global disable skips enforcement.

- `execute.before`: a denied rule, hook crash or timeout rejects the tool call; the model
  sees the rule reason as a tool error.
- `prompt`: a denied prompt is rejected before the model runs; OpenCode 2.x surfaces this
  as a session error (qualified on OpenCode 2.3.0), and the reason is recorded in the ORC
  audit trail.
- `execute.after` / `compaction`: observation fails open and never defects the session,
  but still waits for the hook up to its timeout.

## Options

Configure through the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "@orc/opencode",
      "options": {
        "command": "orc", // ORC executable (default: ORC_COMMAND or "orc")
        "rules": true, // false loads the plugin without enforcement
        "timeoutMs": 30000, // blocking hook timeout; ask-user rules extend it automatically
        "apiBase": "http://127.0.0.1:7700", // ORC origin for the rules plan and rule actions
        "secretEnv": "ORC_API_SECRET" // env var holding the API secret
      }
    }
  ]
}
```

`ORC_API_BASE` and `ORC_API_SECRET` from the environment are passed to the hook; the `orc`
CLI also reads `~/.orc/config.json`. Session identity is forwarded as `ORC_SESSION_ID` so
rule decisions and writes are attributed to the OpenCode session.

## Development

```bash
bun test packages/opencode     # plugin tests with a stub orc adapter
bun run --filter @orc/opencode build
```

The generic hook client lives in [`@orc/rule-client`](../rule-client/README.md); the
OpenCode adapter only declares its native event map.
