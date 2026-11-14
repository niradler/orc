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

Or copy the self-contained bundle into the project's plugin folder:

```bash
cp node_modules/@orc/opencode/dist/plugin.js .opencode/plugins/orc.js
```

Enable enforcement in ORC settings (`rules.enabled: true` or `ORC_RULES_ENABLED=true`) and
activate a policy for the workspace on the **Rules** page or with `orc rules activate`.
There is no `install-hook` step; OpenCode loads the plugin itself.

## What you get

| OpenCode hook         | ORC phase       | Behavior                                          |
| --------------------- | --------------- | ------------------------------------------------- |
| `tool execute.before` | `pre_tool`      | Block the call, rewrite its input, or add context |
| `tool execute.after`  | `post_tool`     | Observe results, add context, trigger automation  |
| `session prompt`      | `prompt_submit` | Block prompt admission or add context             |
| `session compaction`  | `pre_compact`   | Run pre-compaction rules and automation           |
| `session context`     | —               | Delivers queued rule context to the model         |

Every hook forwards to `orc rules hook opencode <event>`, the same adapter the other
agents use, evaluated against the local ORC database. Rule context is queued per session
and delivered on the next model request. OpenCode has no session start/end hooks, so rules
scoped to those events are not delivered here.

## Failure behavior

Blocking hooks fail closed: a denied rule, a hook crash or a timeout rejects the tool call
or prompt and the model sees the reason. Non-blocking hooks fail open so observation never
stalls a session. Enforcement reads the local ORC database through the CLI, so it keeps
working while the ORC API is offline. Hooks are not an OS sandbox; see
[Agent rules](./agent-rules.md) for the guarantee boundary.

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
| `timeoutMs` | `30000`                          | Blocking hook timeout; raise above ask-user lifetimes |
| `apiBase`   | `ORC_API_BASE` or orc config     | ORC origin for rule actions                        |
| `secretEnv` | `ORC_API_SECRET`                 | Environment variable holding the API secret        |

Session identity is forwarded as `ORC_SESSION_ID`, so rule decisions and writes are
attributed to the OpenCode session.

## ORC tools and sessions

The plugin enforces rules; it does not add ORC tools. For context, memories, skills and
tasks, register the ORC MCP server under `mcp.servers` (see [Connect agents](./connect-agents.md)).
OpenCode session history is read from its SQLite store and appears in ORC **Sessions**
(see [Live sessions](./live-sessions.md)).
