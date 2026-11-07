# CLI reference

Every `orc` command group, its subcommands and their main flags.

Most commands call the ORC API, so the daemon must be running (`orc daemon start`, or the desktop app). Run `orc <command> --help` for the full flag list of any command.

## Global options

These go before the command: `orc --json task list`.

| Option | Overrides | Purpose |
| --- | --- | --- |
| `--json` | | Machine-readable JSON output |
| `--port <n>` | `ORC_API_PORT` | API port |
| `--host <host>` | `ORC_API_HOST` | API host |
| `--secret <secret>` | `ORC_API_SECRET` | API bearer secret |
| `--db <path>` | `ORC_DB_PATH` | Database file |
| `--log-level <level>` | `ORC_LOG_LEVEL` | `debug`, `info`, `warn` or `error` |
| `--runner-timeout <secs>` | `ORC_RUNNER_TIMEOUT` | Default job timeout |
| `--runner-max-jobs <n>` | `ORC_RUNNER_MAX_JOBS` | Max concurrent jobs |
| `--snapshot-max-bytes <n>` | `ORC_SNAPSHOT_MAX_BYTES` | Session snapshot budget |
| `--version` | | Print the version |

Commands that take a project (`task`, `job`, `mem`, `kb`) default to the active project set with `orc project use <name>`. Pass `-p <name>` to pick another, or `--no-project` where offered to see everything.

## Server and system

| Command | Purpose |
| --- | --- |
| `orc daemon start` | Run API, scheduler, file watchers and gateway as one process |
| `orc daemon stop` | Stop the daemon |
| `orc daemon status` | Scheduler state and next run times of active jobs |
| `orc daemon install [--force]` | Register the daemon to start on login/boot and start it now |
| `orc daemon uninstall` | Remove the auto-start registration |
| `orc api` | Start the API server only |
| `orc mcp [--mode meta\|full]` | Start the MCP server on stdio. See [MCP](./mcp.md) |
| `orc home` | Show `~/.orc` files, daemon state and API config |
| `orc status` | API health and counts |
| `orc doctor` | Check which agent backends are usable on this machine |
| `orc schema [resource] [--list]` | Show resource schemas from the running API's OpenAPI spec |

## Projects

`orc project github-sync [name]` runs GitHub issue/task status sync for the named
or active project. Configure a GitHub remote first, then use `--enable` to opt in,
`--disable` to stop, `--status-label <status=label...>` to customize mappings, and
`--config-only` to inspect/save settings without running sync. For example:

```sh
orc project github-sync my-app --enable --status-label doing=in-progress review=needs-review
orc project github-sync my-app --config-only
```

`orc task list` includes imported issues with a GitHub issue number and sync-error
or pending-status indicator. `--json` includes task sync metadata. Status updates
use the existing task commands and reach GitHub on the next sync cycle.

| Command | Main flags |
| --- | --- |
| `orc project list` | `--status <s>`, `-t, --tag <tag>`, `-l, --limit <n>` (1-100, default 20), `--offset <n>` |
| `orc project add <name>` | `-d, --description`, `--scope <s>`, `--git-remote-url <url>`, `--tags <csv>` |
| `orc project show [name]` | |
| `orc project use <name>` | `--clear` unsets the active project |
| `orc project update <name>` | `--name`, `-d`, `--status active\|paused\|archived`, `--scope`, `--git-remote-url`, `--clear-git-remote-url`, `--tags` |
| `orc project archive <name>` | |
| `orc project delete <name>` | |

## Tasks

Task IDs accept the full ULID or its last 6 characters.

| Command | Main flags |
| --- | --- |
| `orc task list` | `-p, --project`, `--no-project`, `-s, --status`, `-t, --tag`, `-l, --limit` (default 20), `--flat` |
| `orc task add <title>` | `-p`, `--no-project`, `--priority low\|normal\|high\|critical`, `-b, --body`, `--skill <name>`, `--backend claude\|codex\|cursor`, `--model <model>`, `--flow <name>` (default `orc-default`) |
| `orc task show <id>` | `--no-comments` |
| `orc task update <id>` | `--title`, `--body`, `--status`, `--priority`, `--progress 0-100`, `--tags <csv>`, `-p`, `--no-project`, `--skill`, `--flow` |
| `orc task comment <id> <text>` | `--author <name>` (default `human`) |
| `orc task done <id>` | |
| `orc task review <id>` | Submit for review |
| `orc task approve <id>` | `-c, --comment` |
| `orc task reject <id>` | `-r, --reason` |
| `orc task delete <id>` | |

Status values: `todo`, `doing`, `review`, `changes_requested`, `blocked`, `done`, `cancelled`.

## Flows

See [Task flows](./task-flows.md).

| Command | Main flags |
| --- | --- |
| `orc flow list` | `-q, --query`, `--source builtin\|user\|project`, `--reload` |
| `orc flow show <name>` | |
| `orc flow validate` | `-f, --file <path>` or `-d, --definition <json>` |
| `orc flow create` | `-f` or `-d`, `--overwrite`, `--shadow-builtin` |
| `orc flow attach <taskId>` | `-n, --name <flow>` or `-f` / `-d` for an inline graph, `--start` |
| `orc flow status <taskId>` | Run and ledger |
| `orc flow resume <taskId>` | Resolve a human node: `-o, --outcome`, `-s, --summary`, `--var key=value` (repeatable) |
| `orc flow halt <taskId>` | `-r, --reason` |

## Attention (human requests)

See [Human requests](./human-requests.md).

| Command | Main flags |
| --- | --- |
| `orc attention list` | |
| `orc attention get <id>` | |
| `orc attention request <file>` | JSON file or `-` for stdin; `--wait` |
| `orc attention respond <id> <file>` | Answer or approval JSON; `--version <n>` |
| `orc attention acknowledge <id>` | `--version <n>` |
| `orc attention cancel <id>` | `--version <n>` |

## Memory

Memories are short project facts. Every subcommand takes `-p, --project` (default: active project).

| Command | Main flags |
| --- | --- |
| `orc mem list` | `-q, --q <text>`, `-s, --sort reads\|recent\|priority`, `-l, --limit` (default 30) |
| `orc mem show <name>` | |
| `orc mem add <name>` | `-d, --description`, `-c, --content`, `--priority 0-100` |
| `orc mem edit <name>` | `-d`, `-c`, `--priority <n\|none>`, `-r, --reason` |
| `orc mem delete <name>` | Revertible from history |
| `orc mem history <name>` | |
| `orc mem revert <name> <change-id>` | `-r, --reason`, `--expected-change-id` |
| `orc mem sources` | List native memory folders (Claude Code, Codex) |
| `orc mem import [dir]` | `-n, --name <names...>`, `--all`, `--replace <names...>` |
| `orc mem export [dir]` | `-n`, `--overwrite <names...>`, `--overwrite-all`, `--dry-run` |

## Knowledge bases

| Command | Main flags |
| --- | --- |
| `orc kb list` | `-p`, `--no-project`, `-s, --scope default\|project\|global\|all` |
| `orc kb create <name>` | `-p`, `-g, --global`, `-d`, `--editable-by mcp,api,cli,ui\|none` |
| `orc kb editable-by <kb> <sources>` | Which call sources may change documents |
| `orc kb docs <kb>` | `-f, --folder`, `-l, --label` |
| `orc kb get <ref>` | Document ID or citation `kb:<doc>@<rev>#<n>`; `-H, --heading` |
| `orc kb search <query>` | `-p`, `--no-project`, `-s`, `-k, --kb <ids>`, `--labels`, `-m, --mode`, `-l, --limit` (default 10) |
| `orc kb evidence <query>` | Same filters as search, plus `-b, --budget <tokens>` (default 6000) |
| `orc kb add <kb> <files...>` | `-t, --title`, `--path`, `--labels`, `-d` |
| `orc kb rm <document>` | |
| `orc kb reparse <document>` | |
| `orc kb history <document>` | |
| `orc kb lines <document> [start] [end]` | Numbered lines for partial edits |
| `orc kb usage <id>` | `--doc` when the ID is a document |
| `orc kb status` | Counts, jobs, embeddings, parsers |
| `orc kb settings` | `--parser auto\|basic\|docling`, `--embedding-provider`, `--embedding-model`, `--embedding-url`, `--embedding-key` |
| `orc kb comment list\|add\|resolve\|dismiss\|reopen` | Comments on a KB or document (`--doc`) |
| `orc kb digest show\|template\|set\|run\|runs\|rm` | Digest agent; `set` takes `-b, --backend`, `--cron` or `--manual`, `-i, --instructions <file>`, `--enable`/`--disable`, `--timeout` |
| `orc kb sources list\|add\|scan\|rm` | Local folders synced into a KB; `add` takes `--pattern <glob>` |
| `orc kb docling status\|install\|remove` | Optional Docling parser |

## Jobs

| Command | Main flags |
| --- | --- |
| `orc job list` | `-p`, `--no-project` |
| `orc job add <name>` | `-c, --command`, `--action-config <json>`, `--trigger manual\|cron\|watch\|one-shot\|webhook`, `--cron <expr>`, `--watch <path>`, `--timeout` (default 300), `--retries`, `--notify never\|failure\|always`, `--enable`, `-d`, `-p`, `--no-project` |
| `orc job show <name-or-id>` | |
| `orc job update <name-or-id>` | `--name`, `-d`, `-c`, `--trigger`, `--cron`, `--timeout`, `--retries`, `--notify`, `--enabled` / `--disabled` |
| `orc job run <name-or-id>` | `-w, --wait`, `--wait-secs` (1-240) |
| `orc job runs <name-or-id>` | `-l, --limit` (default 10), `-s, --sessions`, `--logs` |
| `orc job delete <name-or-id>` | |

New jobs are disabled until `--enable` or `orc job update <job> --enabled`.

## Sessions

| Command | Main flags |
| --- | --- |
| `orc session list` | `-a, --agent claude-code\|cursor\|codex`, `-n, --limit` |
| `orc session show <id>` | `-e, --events`, `-s, --snapshot`, `-n, --limit` |
| `orc session log <summary>` | `-a, --agent` (default `human`), `--agent-version` |

## Scratchpads

| Command | Main flags |
| --- | --- |
| `orc pad ls` | `-k, --kind doc\|diagram\|html`, `-p`, `--unassigned`, `-s, --session <id\|current>`, `-t, --tag`, `-q`, `-l` |
| `orc pad show <id>` | |
| `orc pad new <kind> <title>` | `-f, --file`, `-p`, `-t, --tag` (repeatable), `--no-session` |
| `orc pad pull <id> [file]` | Write the pad to disk |
| `orc pad push <id> <file>` | `-r, --if-revision <n>` |
| `orc pad rm <id>` | |

## Skills

See [Skills](./skills.md).

| Command | Main flags |
| --- | --- |
| `orc skill list` | `-q, --query`, `--project-id`, `--source builtin\|user`, `--limit` (1-500, default 30), `--offset`, `--reload` |
| `orc skill read <name>` | `--project-id`, `--ref <path>` |
| `orc skill create <name>` | `-c, --content`, `-f, --file`, `-d, --directory <path>` (whole folder) |
| `orc skill update <name>` | `-c` or `-f` (full `SKILL.md`), `--reason`, `--project-id` |
| `orc skill file <name> <path>` | `-c` or `-f`, `--new`, `--reason`, `--project-id` |
| `orc skill history <name>` | `--project-id` |
| `orc skill revert <name> <change-id>` | `--expected-change-id`, `--reason`, `--project-id` |
| `orc skill delete <name> --yes` | User skills only |
| `orc skill validate <directory>` | Check a folder against the Agent Skills spec |
| `orc skill export <name> <directory>` | Original `SKILL.md` plus supporting files |
| `orc skill import <source>` | GitHub repo or skills.sh link; `--list`, `-s, --skill <names...>` |
| `orc skill sync <name>` | Pull GitHub updates, keep local edits |
| `orc skill origin <name>` | Import provenance |
| `orc skill local [agent]` | `-p, --path <dir>`, `--project <name>`, `-s, --skill <names...>`, `--all` |
| `orc skill export-to <target> [names...]` | `--project`, `--overwrite <names...>`, `--overwrite-all`, `--dry-run` |
| `orc skill project-folders` | `--project <name>` |
| `orc skill projects <name>` | `--set <ids...>`, `--global` |
| `orc skill visibility` | `--hidden-skills <names...>`, `--hidden-builtins <names...>` |

## Agents and packages

See [Reusable agent packages](./agent-packages.md).

| Command | Main flags |
| --- | --- |
| `orc agent list` | |
| `orc agent read <id>` | |
| `orc agent create <id>` | `-f, --file <path>` (APM `.agent.md`) |
| `orc agent export <id> <file>` | |
| `orc agent-package list` | |
| `orc agent-package import <directory>` | `apm.yml` or `plugin.json` package |
| `orc agent-package export <name> <directory>` | |

## Rules and hooks

See [Agent rules](./agent-rules.md).

| Command | Main flags |
| --- | --- |
| `orc rules catalog [template]` | `--workspace <path>` |
| `orc rules list` | `--workspace <path>` |
| `orc rules check <file>` | |
| `orc rules activate <file>` | `--expected <revision>`, `--reason` |
| `orc rules revert <revision>` | `--reason` |
| `orc rules install-hook <backend>` | `--target <settings-file>`, `--events <list>`, `--legacy-hooks-dir <dir>`, `--timeout-seconds` (default 10) |
| `orc rules hook <backend> <event>` | Native hook stdin/stdout entry point; called by the agent, not by hand |

## Gateway

| Command | Main flags |
| --- | --- |
| `orc gateway status` | Enabled adapters and active sessions |
| `orc gateway send` | `--platform telegram\|slack`, `--chat <id>`, `--text`, `--thread <id>` |

## Examples

```bash
orc project add my-app -d "Customer portal" --git-remote-url https://github.com/acme/my-app.git
orc project use my-app

orc task add "Fix login redirect" --priority high --skill orc-sdlc --backend claude
orc task list -s doing
orc task show 3f9k2a

orc mem add deploy-window -d "When deploys are allowed" -c "Weekdays 09:00-16:00 UTC only"

orc job add nightly-backup --trigger cron --cron "0 22 * * *" -c "./scripts/backup.sh" --enable
orc job run nightly-backup --wait

orc kb search "rollback procedure" -l 5
orc --json task list --no-project
```
