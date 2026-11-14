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

Blocking hooks fail closed: a denied rule, a hook crash or a timeout rejects the tool call
or prompt, and the model sees the reason. Non-blocking hooks fail open so observation never
stalls a session. Enforcement reads the local ORC database through the CLI, so it keeps
working while the ORC API is offline.

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
        "timeoutMs": 30000, // blocking hook timeout; raise above ask-user lifetimes
        "apiBase": "http://127.0.0.1:7700", // ORC origin for rule actions
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
