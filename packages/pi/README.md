# porc — ORC inside Pi

`@orc/pi` is a [Pi](https://pi.dev) package that makes [ORC](https://github.com/niradler/orc)
the engine of a Pi setup: persistent memory, skills, tasks and integrations, a system
prompt that explains them, the native ORC MCP server, the `spec` CLI and the ORC theme.

It is meant as one install instead of a pile of memory, skill and tool extensions. ORC
extends your local Pi setup and never replaces it: local skills, prompts and extensions
keep loading and win on name clashes.

porc does not configure models or providers. Pi keeps its own model setup.

## What it adds

| Piece           | Behavior                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Memory          | ORC memories are the memory: recalled per prompt, saved with `memory_create` / `/orc-remember`  |
| Skills          | Searched per prompt instead of preloaded; bundled `orc-platform` / `orc-sdlc`; optional pinning |
| `orc` tool      | Context, memories, skills, project listing, or any ORC tool by name                             |
| `orc_spec` tool | Bridges to the `spec` CLI for operations that are not exposed as MCP tools                      |
| Native MCP      | Registers `orc` as a stdio (default) or HTTP MCP server for the session                         |
| System prompt   | A short static `orc` section; the context index is injected once per session                    |
| Theme           | `porc` (dark) and `porc-light`, matching the ORC design tokens; apply with `/orc-theme`         |
| Prompts         | `orc-plan`, `orc-handoff` and `orc-recall` prompt templates                                     |

### Context management

porc keeps the token cost flat:

- ORC skills are **not** loaded at startup. On each prompt porc searches ORC with the
  prompt's distinctive terms and adds a small hidden hint (at most 4 memories and 3
  skills, about 900 characters) with names and one-line descriptions only. The agent
  reads a full memory or skill only when it needs it.
- A name already hinted in the session, or already loaded as a local Pi skill, is not
  hinted again. The set resets after compaction.
- The system prompt section is static, so it stays prompt-cache friendly; all dynamic
  content travels in the hidden message.
- Skills below the relevance threshold (`recall.minSkillScore`) are dropped.

### Replacing a hand-built Pi setup

| You had                               | With porc                                                           |
| ------------------------------------- | ------------------------------------------------------------------- |
| A memory extension and its own store  | ORC memories: shared with ORC itself, CLI, UI and other agents      |
| A skills folder synced by hand        | Local skills still load; ORC skills are searched, or pinned by name |
| MCP wiring per server                 | One `orc` MCP server (`meta` mode keeps its schemas out of context) |
| A custom system prompt section        | Generated static section, plus your own `AGENTS.md` as usual        |
| Task and job tracking in ad hoc files | ORC tasks, jobs and flows through the `orc` tool                    |
| A hand-tuned theme                    | `porc` / `porc-light`, aligned with ORC's `DESIGN.md`               |

Other Pi extensions (subagents, web search, LSP and so on) are not replaced; install them
alongside porc as usual.

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
| `PORC_SKILLS`        | `search` (default), `pinned` or `all`                         |
| `PORC_RECALL`        | `false` disables per-prompt memory and skill hints            |
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
    "mode": "search",
    "pinned": [],
    "dir": "~/.pi/agent/porc/skills"
  },
  "recall": {
    "enabled": true,
    "maxMemories": 4,
    "maxSkills": 3,
    "minSkillScore": 6,
    "budgetChars": 900
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
- `skills.mode`: `search` (default) loads no ORC skills and relies on per-prompt recall;
  `pinned` materializes only the names in `skills.pinned`; `all` materializes every ORC
  skill visible to the project (costly, use sparingly).
- `skills.dir` is where `pinned` and `all` write skills. Only folders carrying a
  `.porc-managed` marker are ever pruned. Bundled `orc-platform` and `orc-sdlc` are always
  loaded from the package.

## Commands

| Command                          | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `/orc`                           | Connection, project, MCP, skills and spec status           |
| `/orc-context [project]`         | Fetch and display the ORC context index                    |
| `/orc-project [name\|auto]`      | Select a project, or re-run auto detection                 |
| `/orc-skills [sync]`             | List project ORC skills; `sync` refreshes pinned/all       |
| `/orc-remember a \| b \| c`      | Save an ORC memory: name, when it matters, content         |
| `/orc-spec list\|show\|call ...` | Run the `spec` CLI against ORC                             |
| `/orc-doctor`                    | Diagnose config paths, trust, health, MCP, skills and spec |
| `/orc-theme [porc\|porc-light]`  | Apply the ORC theme                                        |
| `/orc-reload`                    | Reload porc, ORC resources and Pi extensions               |

Session flags: `--porc-api-base`, `--porc-project`, `--porc-mode`,
`--porc-no-context`, `--porc-no-mcp`, `--porc-no-spec`, `--porc-skills <mode>`,
`--porc-no-recall`.

## Tools

`orc` accepts an `action`:

| Action          | Arguments                                               | Returns                               |
| --------------- | ------------------------------------------------------- | ------------------------------------- |
| `context`       | `project`                                               | Active tasks and memories by priority |
| `memory_list`   | `query`, `sort`, `limit`, `project`                     | Memory summaries                      |
| `memory_read`   | `name`, `project`                                       | One memory                            |
| `memory_create` | `name`, `description`, `content`, `priority`, `project` | Created memory                        |
| `memory_update` | `name`, `description`, `content`, `priority`, `project` | Updated memory (history is kept)      |
| `skill_list`    | `query`, `limit`, `project`                             | Available skills                      |
| `skill_read`    | `name`, `ref`, `project`                                | A skill or one of its files           |
| `project_list`  | —                                                       | Registered ORC projects               |
| `call`          | `tool`, `arguments`, `project`                          | Any ORC tool result                   |

`orc_spec` accepts `action: "list" | "show" | "call"`, plus `filter`, `limit`,
`operation` and `data`. It runs `spec` against the same ORC stdio connection, so the
schemas cannot drift from what ORC serves.

## Skills

Your local Pi skills (project `.pi/skills`, user `~/.pi/agent/skills`, packages) load as
usual. By default porc adds no ORC skills at startup; relevant ones surface through
recall, and the agent can search with `orc` `skill_list` and read with `skill_read`.

In `pinned` or `all` mode, porc materializes the selected skills visible to the active
project into the managed skill directory on session start and `/orc-project`, and removes
skills it wrote earlier that are no longer selected. The package's own `orc-platform` and
`orc-sdlc` skills load directly from the package and are never overwritten.

Skill files are written only for safe relative paths; traversal, absolute paths and
binary files are skipped. A failed sync is reported in `/orc-skills` but does not fail the
session.

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
