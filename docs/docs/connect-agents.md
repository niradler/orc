# Connect agents

How to connect Claude Code, Codex, Cursor, Gemini CLI, Pi, OpenCode and other MCP clients to ORC: MCP registration, session tracking, hooks and skills.

## What each piece gives you

| Piece                                 | Gives the agent                                                           | Setup                                                            |
| ------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [MCP server](#mcp)                    | ORC tools: context, tasks, memories, knowledge, jobs, skills, scratchpads | Register once per agent                                          |
| [Session tracking](#session-tracking) | The agent's sessions in **Sessions**, with resume and search              | Automatic for Claude Code and Codex; hooks for Cursor and Gemini |
| [Rule hooks](#rule-hooks)             | ORC rules enforced inside the agent (block, approve, inject context)      | `orc rules install-hook`                                         |
| [Skills](#skills)                     | ORC's `orc-platform` and `orc-sdlc` skills in the agent                   | `npx skills add` or `orc skill export-to`                        |

MCP and hooks are independent. Hooks alone do not give the agent ORC tools.

## MCP

ORC serves MCP two ways:

| Transport       | Endpoint                    | Auth                                                             |
| --------------- | --------------------------- | ---------------------------------------------------------------- |
| Streamable HTTP | `http://127.0.0.1:7700/mcp` | `Authorization: Bearer <secret or token>` when a secret is set   |
| stdio           | `orc mcp`                   | Reads `api.secret` from `~/.orc/config.json` or `ORC_API_SECRET` |

Both default to meta mode: three tools (`tool_search`, `tool_describe`, `tool_invoke`) that let the agent find and call any ORC tool without loading every schema. Use `?mode=full` (HTTP) or `orc mcp --mode full` (stdio) for the full tool list.

Scope a connection to projects with query parameters:

| Parameter              | Effect                                      |
| ---------------------- | ------------------------------------------- |
| `?project=my-app`      | Project-aware tools default to `my-app`     |
| `?projects=my-app,lib` | Several projects in priority order (max 50) |

Pass `project` or `projects`, not both. Unknown project names are rejected.

::: tip Generate the snippet
**Settings → MCP** in the dashboard builds the exact config for Claude Code (`.mcp.json` or CLI), Codex (`config.toml`), the spec CLI or a bare URL, with your endpoint, mode, projects and the name of the environment variable that holds your secret. The secret itself is never shown.
:::

The examples below assume the secret is exported as `ORC_API_SECRET`. Without a secret, drop the header or token line. To use a revocable token instead of the secret, create one under **Settings → Security** (see [Configuration](./configuration.md#authentication)).

### Claude Code

CLI:

```bash
claude mcp add --transport http orc 'http://127.0.0.1:7700/mcp' \
  --header 'Authorization: Bearer ${ORC_API_SECRET}'
```

Or `.mcp.json`:

```json
{
  "mcpServers": {
    "orc": {
      "type": "http",
      "url": "http://127.0.0.1:7700/mcp",
      "headers": { "Authorization": "Bearer ${ORC_API_SECRET}" }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.orc]
url = "http://127.0.0.1:7700/mcp"
bearer_token_env_var = "ORC_API_SECRET"
```

### Cursor

`.cursor/mcp.json` (stdio):

```json
{
  "mcpServers": {
    "orc": {
      "command": "orc",
      "args": ["mcp"],
      "env": {
        "ORC_API_BASE": "http://127.0.0.1:7700",
        "ORC_SESSION_ID": "cursor"
      }
    }
  }
}
```

### Gemini CLI and other MCP clients

Any client that launches stdio servers:

```json
{
  "mcpServers": {
    "orc": {
      "command": "orc",
      "args": ["mcp"],
      "env": {
        "ORC_API_BASE": "http://127.0.0.1:7700",
        "ORC_SESSION_ID": "gemini"
      }
    }
  }
}
```

Clients that support HTTP can use `http://127.0.0.1:7700/mcp` with the bearer header instead.

### Pi (porc)

[`@orc/pi`](https://www.npmjs.com/package/@orc/pi), or **porc**, packages the ORC
connection for [Pi](https://pi.dev): context, memories and skills read from and written
to ORC, cron jobs, enforced ORC rules, an ORC system prompt section and the ORC theme.

```bash
pi install npm:@orc/pi
```

It talks to ORC through `orc mcp` (meta tools), scoped to the matched project, enforces
rules through `orc rules hook pi`, and sets `ORC_SESSION_ID` so writes are attributed to
the Pi session. No `install-hook` step is needed for Pi. Configure it in
`~/.pi/agent/porc.json` or `.pi/porc.json`; environment variables and session flags
override the files. See [Pi and porc](./pi.md) for configuration, commands and
security notes.

| stdio variable   | Purpose                                                   |
| ---------------- | --------------------------------------------------------- |
| `ORC_API_BASE`   | ORC origin to call (default from `api.host` / `api.port`) |
| `ORC_SESSION_ID` | Attribution for memory, knowledge and scratchpad writes   |
| `ORC_API_SECRET` | Secret, when not in `~/.orc/config.json`                  |

### OpenCode

[`@orc/opencode`](https://www.npmjs.com/package/@orc/opencode) is a native OpenCode
plugin that enforces ORC rules through OpenCode's own hooks. Add it to `opencode.json`
(project) or `~/.config/opencode/opencode.json` (global):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@orc/opencode"]
}
```

It runs `orc rules hook opencode` per tool call, prompt and compaction, blocks denied
calls fail-closed, and delivers rule context on the next model request. No `install-hook`
step is needed. For ORC tools, register the MCP server under `mcp.servers` (HTTP
`http://127.0.0.1:7700/mcp` with the bearer header, or stdio `orc mcp`). See
[OpenCode](./opencode.md) for options and failure behavior.

### spec CLI

If you use the `spec` CLI, register ORC once and every agent can reach it through `spec`:

```bash
spec add orc --mcp-http 'http://127.0.0.1:7700/mcp' --auth env:ORC_API_SECRET
spec call --spec orc context --data '{"project":"my-app"}'
```

### Check the connection

Ask the agent to call `context` for your project, or call it yourself:

```bash
spec call --mcp-http http://127.0.0.1:7700/mcp context --data '{"project":"my-app"}'
```

It returns the project's active tasks and its memories by priority.

## Session tracking

| Agent                | How sessions reach ORC                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Claude Code          | Discovered from its local session files. Waiting on a permission prompt or question needs the lifecycle hooks. |
| Codex                | Discovered from its local session files and writer locks. No setup.                                            |
| Cursor (IDE and CLI) | History is discovered; live state needs lifecycle hooks                                                        |
| Gemini CLI           | History is discovered; live state and permission waits need lifecycle hooks                                    |
| OpenCode             | History is read from its SQLite store. No setup; no live state.                                                |

Install the Cursor and Gemini lifecycle hooks from a clone of the repository (needs Bun):

```bash
bun scripts/install-session-hooks.ts
```

It adds hooks to `~/.claude/settings.json`, `~/.cursor/hooks.json` and `~/.gemini/settings.json`, keeps existing entries and writes a dated backup of each file. Details: [Live sessions](./live-sessions.md).

## Rule hooks

ORC rules run inside the agent through its native hook system. Install the adapter into the agent's settings file:

```bash
orc rules install-hook claude --target ~/.claude/settings.json
orc rules install-hook codex  --target <codex hooks JSON file>
orc rules install-hook cursor --target ~/.cursor/hooks.json
orc rules install-hook gemini --target ~/.gemini/settings.json
```

| Option                     | Purpose                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--target <file>`          | Settings file to merge into (required). Existing hooks are kept and a backup is written.                                    |
| `--events <list>`          | Comma-separated event names; default is every supported event                                                               |
| `--timeout-seconds <n>`    | Hook timeout (default `10`). Raise it above the ask-user request lifetime when using [human requests](./human-requests.md). |
| `--legacy-hooks-dir <dir>` | Replace old `hooks/*.ts` continuity handlers in that directory                                                              |

Rule enforcement also needs `rules.enabled: true` (or `ORC_RULES_ENABLED=true`). See [Agent rules](./agent-rules.md) and [Human requests](./human-requests.md).

Pi and OpenCode skip `install-hook`: `@orc/pi` and the `@orc/opencode` plugin embed the
same rule adapter and forward native events to `orc rules hook <backend>`.

::: warning Old hook scripts
Older setups pointed Claude Code at `bun /path/to/orc/hooks/session-start.ts`, `post-tool-use.ts` and `pre-compact.ts`. Those scripts now forward to the rule dispatcher. Migrate with `orc rules install-hook claude --target ~/.claude/settings.json --legacy-hooks-dir /path/to/orc/hooks`.
:::

## Skills

ORC ships two entry-point skills, `orc-platform` and `orc-sdlc`. Install them into your agents with the `skills` CLI:

```bash
npx skills add niradler/orc --all          # into the current project
npx skills add niradler/orc --all -g       # globally
npx skills add niradler/orc --skill orc-platform orc-sdlc
```

Or export from your running ORC, which also includes your own skills:

```bash
orc skill export-to claude                  # ~/.claude/skills
orc skill export-to codex                   # ~/.codex/skills
orc skill export-to agents                  # ~/.agents/skills
orc skill export-to claude --project my-app # <checkout>/.claude/skills
orc skill export-to claude --dry-run
```

Agents connected over MCP can also list and read skills without installing them (`skill_list`, `skill_read`). See [Skills](./skills.md).

Pi users do not need a skill install: `@orc/pi` reads ORC skills on demand, and Pi still
loads local `.agents/skills` and `.pi/skills`. See [Pi and porc](./pi.md).

## Agents ORC runs itself

Separate from connecting your own agent: ORC can start agents for tasks, jobs and chat. Check which backends work on this machine:

```bash
orc doctor
```

Registered backends: `claude` (Anthropic SDK, default), `claude-cli`, `codex-cli`, `cursor`, `opencode`, `pi`, `acpx`, `acp`, `agentapi`, `a2a`. Set the default with `agent_loop.default_backend`. See [Configuration](./configuration.md).


## Capabilities and direct ACP

ORC reports the operations each backend actually implements through `GET /backends`
and `GET /chat/capabilities?agent=codex`. Add `threadId` to read the capabilities
negotiated for a saved conversation. Discovery does not launch an agent or a login
flow. Unknown integrations report conservative capabilities. This describes ORC's
adapter, not proof that every installed agent version supports every native feature.

Codex chat uses `codex app-server` over stdio. It supports native resume, approvals,
questions, live permission changes, steering and interruption. While Codex is
responding, **Send now** sends a text message into that active turn; ordinary **Send**
queues it for later. Stop interrupts the active turn and keeps the native session, so
the next message continues the same conversation. Fork and conversation rollback are
not exposed. Non-interactive `codex-cli` callers
continue to use execution mode, without chat's interactive controls.

Claude chat uses the Claude Agent SDK in streaming-input mode. It supports native
resume, approvals, questions, live permission changes, steering and interruption.
While Claude is responding, **Send now** delivers a text message into the active
query; Claude picks it up within the same response. On current Claude versions the
response completes once the steered message has been answered; if it is never
answered, the response ends after a quiet period with a note. Delivery is confirmed
when the SDK has written the message to the agent; ordinary **Send** queues it for
the next turn. Stop sends
the SDK's native interrupt, releases pending approvals and questions, and keeps the
native session, so the next message resumes the same conversation. On current Claude
versions, a steering message delivered but not yet answered when Stop lands is
cancelled and does not run. Steering and interrupt require the SDK path; when Claude
falls back to ACPX, the conservative ACPX capabilities apply.

ACPX remains the compatibility path for other coding agents. It streams text,
reasoning and tool results and keeps named sessions. Its CLI permissions are chosen
through launch flags; ORC cannot answer individual live ACPX permission requests.

On first API startup, ORC enables installed agents from the default list: Codex,
Claude Code, Cursor, Gemini CLI and OpenCode. Missing agents start unchecked in
**Settings → Agents**. This selection is saved once, including an empty selection
when none are installed. Existing explicit agent/provider selections are preserved.
Later enabling an unavailable agent keeps that choice and reports installation
guidance when you try to run it. Copilot remains supported; enable it in Settings.

OpenCode speaks ACP directly: ORC launches `opencode acp`
on the execution host (an installation with ACP support) and negotiates capabilities per
session, including native resume, model selection, image input, HTTP MCP,
per-request approvals, questions, interruption and mid-turn steering. A missing install reports
installation guidance instead of falling back to ACPX. The OpenCode provider
profile's **Executable path** selects a specific installation, model choices load
from `opencode models`, and an `agent_loop.acp_commands.opencode` entry overrides
the built-in command entirely. That override runs through the generic ACP
backend, which keeps steering disabled. If OpenCode moves a saved session into a worktree it
created, ORC follows it on resume, continues in that folder and updates the
conversation's working folder.

While OpenCode is responding, **Send now** sends a second `session/prompt` into
the running turn. OpenCode's ACP server treats that prompt as steering, so the
text reaches the model before its next step instead of waiting for the turn to
end. This was verified against OpenCode 1.19.5 over `opencode acp`, including
steering during a running tool call. The ACP handshake has no steering field, so
ORC declares it for the OpenCode backend and keeps it on the negotiated session;
if an OpenCode build rejects a mid-turn prompt, ORC turns the flag off for that
session and reports that the message should be queued instead. Other direct ACP
agents, and ACPX, keep steering disabled rather than assuming concurrency.

Direct ACP advertises form elicitation and turns form questions into the same
chat question card used by Codex and Claude, including single-choice,
multi-choice, free-text and custom answers. URL elicitation or an unsupported
form schema is not guessed: ORC reports that the agent needs input in its native
client and declines the form. ACP agents that do not use elicitation keep working
unchanged.

Configure and authenticate providers in OpenCode on the execution host. In ORC, leave
**Default model** blank to use OpenCode's selection, or enter the exact
`provider/model` ID returned by `opencode models`. The profile model is applied to
new and resumed ACP sessions; an explicit session model takes precedence. Provider
environment overrides also apply to model discovery. Native OpenCode provider and
model options belong in OpenCode configuration, rather than ACPX launch flags.

For an installed agent that speaks ACP directly, configure a separate agent ID in
`~/.orc/config.json`:

```json
{
  "agent_loop": {
    "acp_commands": {
      "my-acp": { "command": "my-agent", "args": ["--acp"] }
    }
  },
  "preferences": {
    "agents": ["codex", "claude", "my-acp"]
  }
}
```

Use the executable and ACP arguments documented by that agent. The command runs on
the selected local or SSH execution host, with literal arguments and no shell
expansion. Keep credentials in the agent's login store or existing environment,
never in these arguments. Reserved native backend IDs cannot be replaced. An
existing ACPX agent such as `gemini` can be explicitly configured for direct ACP;
already saved conversations keep their original backend.

Select the configured ID in chat, or use it as a task backend. The registered `acp`
backend also accepts `SessionOpts.acpAgent`. Direct ACP currently negotiates stable
ACP v1 using the official TypeScript SDK. It supports streamed text/tool updates,
per-request approvals, cancellation, and native resume when `loadSession` is
advertised. Model selection uses an advertised model config option; unsupported
explicit model choices fail instead of being ignored. Image input is negotiated
for runtime callers. ORC's chat uploads retain their existing file-reference flow.

**Allow for session** selects the agent's `allow_always` option when it offers
one, which delegates to that agent's own always-allow policy; when an agent
offers only `allow_once`, ORC falls back to that one-shot grant.
**Approve** stays one-shot: ORC never escalates an ordinary approval to a
persistent agent policy. Direct ACP does not advertise ORC filesystem, terminal,
browser-login or native-rule-hook handlers. The agent runs its own tools under
its own sandbox. ACP approval prompts are not a sandbox, and ORC's live
permission-mode selector is unavailable for ACP: the protocol has no approval-mode
handshake, and OpenCode's `session/set_mode` selects its build/plan agent rather
than ORC's `default`/`acceptEdits`/`bypassPermissions` modes.

If the agent does not advertise HTTP MCP, select **Native configuration** for its
MCP connection before starting chat. Existing agent login and native MCP settings
remain agent-owned. ACPX-specific launch flags do not apply to direct ACP. Failed
resume preserves the original identity instead of silently starting fresh.


Stop ends the current turn. On backends with a native interrupt — Claude, Pi, Codex
and OpenCode/direct ACP — Stop sends that interrupt and keeps the session, so the next
send resumes the same native conversation instead of starting a new one. ACPX has no
native interrupt, so Stop closes the agent process as before.

Stopping a native Claude, Codex or direct ACP turn revokes pending interactive requests
and rejects new approval callbacks while cancellation completes, including when automatic
approvals were enabled. ACP requests while idle are also cancelled. Steering saves
its intent before native delivery and reuses a request ID on retry; a delivery warning
means to inspect the current response before sending another message.

### Pi native RPC

Select **Pi** as a named coding provider to use the native `pi --mode rpc` backend.
Pi 1.5.2 or newer must be installed and authenticated on the execution host.
This path uses Pi's own RPC protocol and an ORC session extension for permissions
and scoped MCP; it does not require ACPX or `pi-acp`.
See [Pi configuration and capabilities](./configuration.md#pi).

Pi persists a native session only once its transcript holds a message. A turn made
entirely of slash/extension commands (which send no model message) creates no
resumable native session, so ORC starts the next message in a fresh Pi session. The
ORC conversation continues normally — such commands leave no native transcript, so
there is no history to lose. This also holds when such a turn is stopped: ORC does not
pin a session id that cannot be resumed, so the next send works instead of failing.
