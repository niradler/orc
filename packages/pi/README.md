# porc: ORC inside Pi

`@orc/pi` is a [Pi](https://pi.dev) package that makes [ORC](https://github.com/niradler/orc)
the engine of a Pi setup. Install it once to get:

- Memories, skills and project context, read from and written to ORC.
- Cron jobs scheduled from chat.
- ORC rules enforced on Pi's tool calls and prompts.
- The ORC theme.

porc does not configure models or providers. Pi keeps its own model setup, and local Pi
skills, prompts and extensions keep loading as usual.

## What it adds

| Piece         | Behavior                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `orc` tool    | One tool for context, memories, skills, projects, jobs, rules and any ORC tool via meta search |
| Recall        | Each prompt gets a small hidden hint of relevant ORC memories and skills (names only)          |
| Rules         | ORC rules for the workspace run on Pi `tool_call`, `tool_result` and `input`; blocks are real  |
| Projects      | Detects the ORC project for `cwd`, including nested folders, or asks: existing, new, global    |
| System prompt | A short static `orc` section; the context index is injected once per session                   |
| Theme         | `porc` (dark) and `porc-light`, matching ORC's `DESIGN.md`; apply with `/orc-theme`            |

### Reads and writes

- **Writes go to ORC.** "Remember X" calls `memory_create`, and "make a skill for Y" calls
  `skill_create`, so other agents, the CLI and the UI see them too.
- **Reads come from both places.** ORC memories and skills are read through recall and the
  `orc` tool. Pi loads local skills natively from `.agents/skills`, `.pi/skills`,
  `~/.pi/agent/skills` and packages, and local skills win on name clashes.
- **ORC skills are never copied to disk.** They are fetched when needed, so there is nothing
  to sync.

### Context cost

- Nothing is preloaded. The ORC tool surface is reached through the meta tools: `search` →
  `describe` → `invoke`. Only one tool schema sits in context.
- Recall adds at most 4 memories and 3 skills per prompt, capped at about 900 characters. A
  name already hinted in the session is skipped, and the set resets after compaction.
- The system prompt section is static, which keeps it prompt-cache friendly.

## Install

```bash
pi install npm:@orc/pi      # or, from a checkout: pi install ./packages/pi
```

Start Pi in a repository and run `/orc`.

## Prerequisites

- ORC running, by default at `http://127.0.0.1:7700`.
- The `orc` executable on `PATH`. It provides the stdio MCP transport and the rule hook
  (`orc rules hook pi`).
- Project trust granted in Pi before a project-level `.pi/porc.json` is read.

If ORC is offline, Pi still starts. porc reports the limited state, and rules fail closed for
blocking events.

## Projects

On session start, porc resolves the ORC project in this order:

1. `--porc-project`, `PORC_PROJECT` or `porc.json` `project`.
2. The deepest of these two:
   - an ORC project whose root contains `cwd`;
   - a choice you saved earlier for `cwd` or a parent folder.
3. Otherwise, a prompt with these choices:
   - create a project for this folder;
   - pick an existing project;
   - work globally;
   - decide later.

Saved choices live in `~/.pi/agent/porc-projects.json`. `/orc-project` changes the
project: pass a name, `new`, `global`, `auto` or `reset`.

## Jobs and rules from chat

```text
schedule a check of open PRs every hour
block the agent from running ssh
```

**Jobs.** `job_create` creates an ORC cron job that runs Pi in the current folder.

**Rules.**

- `rule_add` adds a rule to the workspace policy and activates a new revision.
  - The target defaults to `block` and the event to `pre_tool`.
  - The new revision applies to every agent ORC governs, Pi included.
- `rule_remove` removes a rule.
- `rule_list` lists the rules.

**Confirmation.** Each of these writes asks for confirmation first.

**Enforcement.** Enforcement runs `orc rules hook pi <event>`, the same engine Claude and
Codex hooks use. Rules must be enabled in ORC settings for enforcement. When the rules plan
cannot be loaded (ORC offline or the fetch failed), blocking events (`tool_call`, `input`)
still run the hook against the local ORC database and fail closed, like the Claude and Codex
adapters. The plan refreshes at least every 30 seconds while the session runs, so rules
activated later are picked up without restarting Pi.

## Connection and secrets

porc looks up each setting in order and uses the first one found:

1. API base:
   1. `PORC_API_BASE` or `ORC_API_BASE`
   2. `porc.json` `apiBase`
   3. `api.host` and `api.port` in `~/.orc/config.json`
2. Secret:
   1. `PORC_API_SECRET`
   2. the variable named by `secretEnv`
   3. `ORC_API_SECRET`
   4. `api.secret` in `~/.orc/config.json`

Secrets are passed to child processes through the environment, never through argv. They
are also redacted from tool output and errors.

| Variable             | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `PORC_API_BASE`      | ORC API origin                                     |
| `PORC_API_SECRET`    | Secret or token for the API and MCP                |
| `PORC_PROJECT`       | ORC project name                                   |
| `PORC_AUTO_PROJECT`  | `false` disables project detection                 |
| `PORC_ASK_PROJECT`   | `false` never prompts for a project                |
| `PORC_MCP_TRANSPORT` | `stdio` (default, runs `orc mcp`) or `http`        |
| `PORC_CONTEXT`       | `false` disables the context injection             |
| `PORC_SYSTEM_PROMPT` | `false` disables the system prompt section         |
| `PORC_RECALL`        | `false` disables per-prompt recall                 |
| `PORC_RULES`         | `false` disables rule enforcement in Pi            |
| `PORC_TIMEOUT_MS`    | API and MCP timeout, `250`–`60000`, default `5000` |
| `PORC_ORC_COMMAND`   | Command used for MCP and rule hooks, default `orc` |
| `PORC_DISABLED`      | `true` disables porc for the session               |

## Configuration

User config lives at `~/.pi/agent/porc.json`. Project config lives at `.pi/porc.json`, and
project values override user values.

```json
{
  "apiBase": "http://127.0.0.1:7700",
  "secretEnv": "ORC_API_SECRET",
  "project": "my-app",
  "autoProject": true,
  "askProject": true,
  "autoContext": true,
  "systemPrompt": true,
  "rules": true,
  "transport": "stdio",
  "timeoutMs": 5000,
  "recall": {
    "enabled": true,
    "maxMemories": 4,
    "maxSkills": 3,
    "minSkillScore": 6,
    "budgetChars": 900
  }
}
```

## Commands and flags

| Command                                         | Purpose                                                |
| ----------------------------------------------- | ------------------------------------------------------ |
| `/orc`                                          | Connection, project and rules status                   |
| `/orc-context [project]`                        | Show the ORC context index                             |
| `/orc-project [name\|new\|global\|auto\|reset]` | Choose the ORC project for this folder                 |
| `/orc-skills`                                   | List ORC skills visible to the project                 |
| `/orc-remember a \| b \| c`                     | Save an ORC memory: name, when it matters, content     |
| `/orc-doctor`                                   | Diagnose config, trust, health, project and rule hooks |
| `/orc-theme [porc\|porc-light]`                 | Apply the ORC theme                                    |
| `/orc-reload`                                   | Reload porc and Pi resources                           |

Session flags: `--porc-api-base`, `--porc-project`, `--porc-no-context`,
`--porc-no-recall`, `--porc-no-rules`.

## The `orc` tool

| Action                                                         | Purpose                                  |
| -------------------------------------------------------------- | ---------------------------------------- |
| `context`                                                      | Active tasks and memories by priority    |
| `search`, `describe`, `invoke`                                 | Find, inspect and call any ORC tool      |
| `memory_list`, `memory_read`, `memory_create`, `memory_update` | ORC memories                             |
| `skill_list`, `skill_read`, `skill_create`                     | ORC skills; global scope when no project |
| `project_list`                                                 | Registered ORC projects                  |
| `job_create`, `job_list`                                       | Cron jobs that run Pi                    |
| `rule_add`, `rule_remove`, `rule_list`                         | Workspace rules enforced across agents   |

## Security

- Project config loads only after Pi grants project trust.
- Writes that change shared behavior (jobs and rules) ask for confirmation.
- Rule hooks fail closed for blocking events when the ORC command cannot run.
- Retrieved ORC content is evidence for the model, not trusted instructions.

## Development

```bash
bun run --cwd packages/pi typecheck
bun run --cwd packages/pi test
```
