# Pi and porc

[Pi](https://pi.dev) is a terminal coding agent. `@orc/pi`, called **porc**, is a Pi
package that connects a Pi session to ORC: project context, memories, skills, the
native ORC MCP server, the `spec` CLI and the ORC theme.

porc does not add a model provider or change Pi's model configuration. Models and
providers stay owned by Pi.

## Install

```bash
pi install npm:@orc/pi
```

Try it for one run without changing settings:

```bash
pi -e npm:@orc/pi
```

Start Pi in a repository registered with ORC and run `/orc` to check the connection.

## What porc adds

| Piece | Behavior |
| --- | --- |
| `orc` tool | Context, memories, skills, project listing and arbitrary ORC tool calls |
| `orc_spec` tool | Runs `spec` against ORC for operations not exposed as MCP tools |
| Native MCP | Registers the `orc` stdio MCP server, or HTTP when configured |
| Memory | ORC memories recalled per prompt and saved with `memory_create` or `/orc-remember` |
| Skills | Searched per prompt, not preloaded; bundles `orc-platform` and `orc-sdlc`; optional pinning |
| System prompt | A short static ORC section; the context index is injected once per session |
| Theme | `porc` (dark) and `porc-light`, applied with `/orc-theme` |
| Prompt templates | `orc-plan`, `orc-handoff`, `orc-recall` |

## Connection

The default transport is stdio: porc runs `orc mcp --mode meta` and passes
`ORC_API_BASE`, the secret, `ORC_ACTIVE_PROJECT` and `ORC_SESSION_ID` through the child
environment. This needs the `orc` executable on `PATH`.

For HTTP, set `transport` to `http` in `porc.json` or `PORC_MCP_TRANSPORT=http`. porc
then registers `http://<apiBase>/mcp?mode=<mode>` with a bearer header when a secret is
configured.

porc resolves the API base and secret in this order:

1. `PORC_API_BASE` or `ORC_API_BASE`, then `porc.json` `apiBase`, then `api.host` and
   `api.port` from `~/.orc/config.json`.
2. `PORC_API_SECRET`, then the variable named by `secretEnv`, then `ORC_API_SECRET`,
   then `api.secret` from `~/.orc/config.json`.

When ORC requires authentication, either let porc read `~/.orc/config.json` or export a
secret variable. The secret is redacted from tool output and errors.

If ORC is offline, Pi still starts and porc reports a limited state.

## Configure

User config lives at `~/.pi/agent/porc.json`. Project config lives at `.pi/porc.json`
and is read only after Pi grants project trust. Project values override user values.

```json
{
  "apiBase": "http://127.0.0.1:7700",
  "secretEnv": "ORC_API_SECRET",
  "project": "my-app",
  "autoProject": true,
  "autoContext": true,
  "mode": "meta",
  "transport": "stdio",
  "exposure": "direct",
  "spec": true,
  "mcp": true,
  "skills": { "mode": "search" },
  "recall": { "enabled": true }
}
```

| Key | Default | Purpose |
| --- | --- | --- |
| `apiBase` | `~/.orc/config.json` or `http://127.0.0.1:7700` | ORC API origin |
| `secretEnv` | — | Environment variable that holds the API secret |
| `project` | auto-detected | Default ORC project |
| `autoProject` | `true` | Match `cwd` against ORC project roots |
| `autoContext` | `true` | Inject the context index once per session |
| `systemPrompt` | `true` | Add the ORC section to the system prompt |
| `mode` | `meta` | `meta` exposes `tool_search`, `tool_describe` and `tool_invoke`; `full` exposes every ORC tool |
| `transport` | `stdio` | `stdio` or `http` |
| `exposure` | `direct` | Pi MCP exposure: `direct`, `codemode` or `deferred` |
| `spec` | `true` | Enable the `spec` bridge |
| `mcp` | `true` | Register the native ORC MCP server |
| `timeoutMs` | `5000` | API and MCP timeout, `250`–`60000` |
| `command` | `orc` | Command used for stdio MCP and spec |
| `skills.mode` | `search` | `search` loads no ORC skills, `pinned` writes only `skills.pinned`, `all` writes every visible skill |
| `skills.pinned` | `[]` | Skill names to load in `pinned` mode |
| `skills.dir` | `~/.pi/agent/porc/skills` | Managed skill directory; only folders porc marked are pruned |
| `recall.enabled` | `true` | Add relevant memory and skill pointers to each prompt |
| `recall.maxMemories` / `recall.maxSkills` | `4` / `3` | Pointers per prompt |
| `recall.minSkillScore` | `6` | Minimum ORC search score for a skill hint |
| `recall.budgetChars` | `900` | Size cap for one hint |

Environment variables override `porc.json`: `PORC_API_BASE`, `PORC_API_SECRET`,
`PORC_PROJECT`, `PORC_MCP_MODE`, `PORC_MCP_TRANSPORT`, `PORC_CONTEXT`,
`PORC_SYSTEM_PROMPT`, `PORC_SPEC`, `PORC_MCP`, `PORC_SKILLS`, `PORC_RECALL`,
`PORC_TIMEOUT_MS`, `PORC_ORC_COMMAND` and `PORC_DISABLED`.

Session flags are the last word: `--porc-api-base`, `--porc-project`, `--porc-mode`,
`--porc-no-context`, `--porc-no-mcp`, `--porc-no-spec`, `--porc-skills <mode>` and
`--porc-no-recall`.

## Commands

| Command | Purpose |
| --- | --- |
| `/orc` | Show connection, project, MCP, skills and spec status |
| `/orc-context [project]` | Fetch and display the context index |
| `/orc-project [name\|auto]` | Select a project or re-run auto detection |
| `/orc-skills [sync]` | List ORC skills visible to the project; `sync` refreshes pinned or all mode |
| `/orc-remember name \| when \| content` | Save an ORC memory |
| `/orc-spec list\|show\|call ...` | Run `spec` against ORC |
| `/orc-doctor` | Diagnose paths, trust, health, MCP, skills and spec |
| `/orc-theme [porc\|porc-light]` | Apply the ORC theme |
| `/orc-reload` | Reload porc, ORC resources and Pi extensions |

`/orc-theme` applies the theme explicitly. Install an ORC theme only if you want to
switch to it; Pi's configured theme is not overridden at startup.

## Memories and skills

The `orc` tool is scoped to the active project. Ask the agent to read context, list or
read memories, or create a memory when a decision should persist:

```text
Use orc action context, then memory_read for the deployment decision.
```

ORC memories are Pi's memory. On each prompt porc searches ORC with the prompt's
distinctive terms and adds a small hidden hint of at most four memories and three skills,
as names and one-line descriptions only. Names already hinted in the session, or already
loaded as local Pi skills, are skipped, and the hint is capped at about 900 characters.
Nothing is preloaded, so a large skill library costs no startup tokens.

Local Pi skills load as usual and win on name clashes; ORC extends them. To always load
specific ORC skills, set `skills.mode` to `pinned` and list them in `skills.pinned`.
`all` writes every visible skill into the managed directory and is rarely worth the
tokens. The bundled `orc-platform` and `orc-sdlc` skills load from the package and are
never overwritten. Binary files and unsafe paths are skipped, and only folders porc
marked with `.porc-managed` are ever removed.

## Verify

```text
/orc
/orc-doctor
/orc-context
```

`/orc-doctor` reports the resolved API, whether a secret was found and from where,
project matching, MCP registration, the managed skill directory and whether `spec` is
on `PATH`.

For the general MCP and skills setup shared with other agents, see
[Connect agents](./connect-agents.md).