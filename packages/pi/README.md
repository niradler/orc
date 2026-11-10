# porc — ORC inside Pi

`@orc/pi` is a [Pi](https://pi.dev) package that fuses [ORC](https://github.com/niradler/orc)
into the Pi coding agent: project context, memories, skills, the native ORC MCP server,
the `spec` CLI and the ORC theme.

porc does not configure models or providers. Pi keeps its own model setup; porc only
connects the session to ORC.

## What it adds

| Piece           | Behavior                                                                             |
| --------------- | ------------------------------------------------------------------------------------ |
| `orc` tool      | Reads ORC context, memories and skills, or calls any ORC tool by name                |
| `orc_spec` tool | Bridges to the `spec` CLI for operations that are not exposed as MCP tools           |
| Native MCP      | Registers `orc` as a stdio (default) or HTTP MCP server for the session              |
| Skills          | Materializes ORC skills into Pi's skill loader and ships `orc-platform` / `orc-sdlc` |
| System prompt   | Adds a concise `<orc>` section and injects the context index once per session        |
| Theme           | `porc` (dark) and `porc-light`, applied explicitly with `/orc-theme`                 |
| Prompts         | `orc-plan`, `orc-handoff` and `orc-recall` prompt templates                          |

## Install

```bash
pi install npm:@orc/pi
```

Or try it for a single run:

```bash
pi -e npm:@orc/pi
```

To develop against a checkout:

```bash
pi install ./packages/pi
```

Start Pi inside a repository that ORC knows, then run `/orc` to see the connection
status.

## Prerequisites

- ORC running and reachable, by default at `http://127.0.0.1:7700`.
- The `orc` executable on `PATH` for the default stdio MCP transport.
- `spec` on `PATH` only if you want the `orc_spec` tool or `/orc-spec`.
- Project trust granted in Pi before a project-level `.pi/porc.json` is read.

If ORC is offline, porc loads in a limited state and reports the API as unreachable.
It does not block Pi startup.

## Connection and secrets

porc resolves its ORC connection in this order:

1. `PORC_API_BASE` / `ORC_API_BASE`, then `porc.json` `apiBase`, then `~/.orc/config.json`
   (`api.host` / `api.port`).
2. `PORC_API_SECRET`, then the environment variable named by `porc.json` `secretEnv`,
   then `ORC_API_SECRET`, then `api.secret` from `~/.orc/config.json`.

The secret is passed to the ORC stdio child through its environment and is redacted
from tool output and error messages. When the secret comes from `~/.orc/config.json`,
porc does not repeat it in the `spec` argv because the child already reads that file.

Common environment variables:

| Variable             | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `PORC_API_BASE`      | ORC API origin, for example `http://127.0.0.1:7700`           |
| `PORC_API_SECRET`    | Secret or token for the API and MCP                           |
| `PORC_PROJECT`       | Default ORC project name                                      |
| `PORC_MCP_MODE`      | `meta` (default) or `full`                                    |
| `PORC_MCP_TRANSPORT` | `stdio` (default) or `http`                                   |
| `PORC_CONTEXT`       | `false` disables automatic context injection                  |
| `PORC_SYSTEM_PROMPT` | `false` disables the ORC system prompt section                |
| `PORC_SPEC`          | `false` disables the spec bridge                              |
| `PORC_MCP`           | `false` skips native MCP registration                         |
| `PORC_SKILL_SYNC`    | `false` keeps bundled skills but skips managed skill sync     |
| `PORC_TIMEOUT_MS`    | API and MCP timeout, `250`–`60000`, default `5000`            |
| `PORC_ORC_COMMAND`   | Command used for the stdio MCP server and spec, default `orc` |
| `PORC_DISABLED`      | `true` disables porc for the session                          |

## Configuration

User config: `~/.pi/agent/porc.json`. Project config: `.pi/porc.json`, read only after
Pi grants project trust. Project values override user values; the `skills` object is
merged.

```json
{
  "enabled": true,
  "apiBase": "http://127.0.0.1:7700",
  "secretEnv": "ORC_API_SECRET",
  "project": "my-app",
  "autoProject": true,
  "autoContext": true,
  "systemPrompt": true,
  "mode": "meta",
  "transport": "stdio",
  "exposure": "direct",
  "spec": true,
  "mcp": true,
  "timeoutMs": 5000,
  "skills": {
    "bundled": true,
    "sync": true,
    "dir": "~/.pi/agent/porc/skills"
  }
}
```

- `mode: "meta"` exposes `tool_search`, `tool_describe` and `tool_invoke`; `full`
  exposes every ORC tool. The `orc` tool works in both modes.
- `transport: "http"` registers `http://<apiBase>/mcp` with a bearer header instead of
  spawning `orc mcp`.
- `exposure` is passed to Pi's MCP registration: `direct` (default), `codemode` or
  `deferred`.
- `autoProject` matches `ctx.cwd` against ORC's registered project roots.
- `skills.dir` is where ORC skills are materialized. Bundled `orc-platform` and
  `orc-sdlc` are always loaded from the package, not copied there.

## Commands

| Command                          | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `/orc`                           | Connection, project, MCP, skills and spec status           |
| `/orc-context [project]`         | Fetch and display the ORC context index                    |
| `/orc-project [name\|auto]`      | Select a project, or re-run auto detection                 |
| `/orc-skills [sync]`             | List ORC skills and resync them into Pi                    |
| `/orc-spec list\|show\|call ...` | Run the `spec` CLI against ORC                             |
| `/orc-doctor`                    | Diagnose config paths, trust, health, MCP, skills and spec |
| `/orc-theme [porc\|porc-light]`  | Apply the ORC theme                                        |
| `/orc-reload`                    | Reload porc, ORC resources and Pi extensions               |

Session flags: `--porc-api-base`, `--porc-project`, `--porc-mode`,
`--porc-no-context`, `--porc-no-mcp`, `--porc-no-spec`, `--porc-no-skills`.

## Tools

`orc` accepts an `action`:

| Action          | Arguments                                               | Returns                               |
| --------------- | ------------------------------------------------------- | ------------------------------------- |
| `context`       | `project`                                               | Active tasks and memories by priority |
| `memory_list`   | `query`, `sort`, `limit`, `project`                     | Memory summaries                      |
| `memory_read`   | `name`, `project`                                       | One memory                            |
| `memory_create` | `name`, `description`, `content`, `priority`, `project` | Created memory                        |
| `skill_list`    | `query`, `limit`, `project`                             | Available skills                      |
| `skill_read`    | `name`, `ref`, `project`                                | A skill or one of its files           |
| `project_list`  | —                                                       | Registered ORC projects               |
| `call`          | `tool`, `arguments`, `project`                          | Any ORC tool result                   |

`orc_spec` accepts `action: "list" | "show" | "call"`, plus `filter`, `limit`,
`operation` and `data`. It runs `spec` against the same ORC stdio connection, so the
schemas cannot drift from what ORC serves.

## Skills

On session start and `/orc-project`, porc lists ORC skills, materializes the ones
visible to the active project into the managed skill directory and removes skills it
previously wrote that are no longer available. The package's own `orc-platform` and
`orc-sdlc` skills are loaded directly from the package and are never overwritten.

Skill files are written only for safe relative paths; traversal, absolute paths and
binary files are skipped. A failed skill sync is reported in `/orc-skills` but does
not fail the session.

## Security

- Project config and project packages load only after Pi grants project trust.
- The API secret is kept in environment-backed config and redacted from rendered
  errors and tool output.
- Tool calls are scoped by project name. porc does not broaden project scope on its own.
- Retrieved ORC content is evidence for the model, not trusted instructions. The
  system prompt says so explicitly.

## Development

From the repository root:

```bash
bun run --cwd packages/pi typecheck
bun run --cwd packages/pi test
bun run --cwd packages/pi check:skills
```

`check:skills` verifies that the bundled copies match `skills/` in the repository.
Run `bun run --cwd packages/pi sync:skills` after changing the source skills.
