# Pi and porc

[Pi](https://pi.dev) is a terminal coding agent. `@orc/pi`, called **porc**, makes ORC the
engine of a Pi setup. Memories, skills, project context, cron jobs and rules all live in ORC
and are used from Pi. porc does not touch Pi's models or providers.

## Install

```bash
pi install npm:@orc/pi
```

Start Pi in a repository and run `/orc`. ORC must be running, and `orc` must be on `PATH`.

## What you get

| Piece      | Behavior                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `orc` tool | Context, memories, skills, projects, jobs, rules, and any ORC tool through `search` → `describe` → `invoke`   |
| Recall     | A small hidden hint of relevant ORC memories and skills per prompt; nothing is preloaded                      |
| Rules      | ORC rules for the workspace run on Pi `tool_call`, `tool_result` and `input` through `orc rules hook pi`      |
| Projects   | Detects the ORC project for `cwd`, including nested folders, or asks you to pick one: existing, new or global |
| Theme      | `porc` and `porc-light`, matching `DESIGN.md`; apply with `/orc-theme`                                        |

Memories and skills you create from Pi are written to ORC, so other agents and the UI see
them. Pi still loads local skills from `.agents/skills`, `.pi/skills` and
`~/.pi/agent/skills`, and local skills win on name clashes. ORC skills are fetched on
demand and never copied to disk, so there is nothing to sync. Pi sessions are already read
by ORC's session archive.

## Ask for it in chat

```text
remember that staging deploys need a feature flag
schedule a dependency audit every Monday at 9
block the agent from running ssh
```

These map to:

| Request    | Action                                                      | Confirmation |
| ---------- | ----------------------------------------------------------- | ------------ |
| remember … | `memory_create`                                             | none         |
| schedule … | `job_create`: a cron job that runs Pi in the current folder | asks first   |
| block …    | `rule_add`: activates a new rule revision for the workspace | asks first   |

A rule applies to every agent ORC governs. ORC rules must be enabled in Settings.

## Configure

User config lives at `~/.pi/agent/porc.json`. Project config lives at `.pi/porc.json`, and
porc reads it only after Pi trusts the project. The full option and environment variable
reference is in the
[package README](https://github.com/niradler/orc/tree/master/packages/pi#readme).

| Key                          | Default                                         | Purpose                                             |
| ---------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| `apiBase`                    | `~/.orc/config.json` or `http://127.0.0.1:7700` | ORC API origin                                      |
| `secretEnv`                  | —                                               | Environment variable that holds the API secret      |
| `project`                    | detected                                        | Fixed ORC project                                   |
| `autoProject` / `askProject` | `true` / `true`                                 | Detect the project, and prompt when none matches    |
| `autoContext`                | `true`                                          | Inject the context index once per session           |
| `rules`                      | `true`                                          | Enforce ORC rules in Pi                             |
| `transport`                  | `stdio`                                         | `stdio` runs `orc mcp`; `http` uses `<apiBase>/mcp` |
| `recall.*`                   | 4 memories, 3 skills, 900 chars                 | Per-prompt hint budget                              |

## Commands

`/orc`, `/orc-context`, `/orc-project [name|new|global|auto|reset]`, `/orc-skills`,
`/orc-remember name | when | content`, `/orc-doctor`, `/orc-theme`, `/orc-reload`.

Session flags: `--porc-api-base`, `--porc-project`, `--porc-no-context`,
`--porc-no-recall`, `--porc-no-rules`.

For the MCP and skills setup shared with other agents, see
[Connect agents](./connect-agents.md).
