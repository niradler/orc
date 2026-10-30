<div align="center">

# orc

**Multi-agent orchestrator with human-in-the-loop review**

[![npm version](https://img.shields.io/npm/v/orc-ai?style=flat-square)](https://www.npmjs.com/package/orc-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.1-f472b6?style=flat-square&logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)

One SQLite file. One CLI. Any agent.<br>
ORC coordinates Claude Code, Cursor, Codex, Gemini, and remote A2A agents through a shared task board, persistent memory, and a review flow that keeps you in control.

<img src="assets/Architecture.gif" alt="ORC Architecture" width="700" />

</div>

## Overview

Every AI agent session is an island. Start a new session and it knows nothing about the last one. Run two in parallel and they can't coordinate. Switch agents and you start from zero.

ORC fixes this. Shared memory across every session. A task board where agents submit work and you approve it. A scheduler that runs agents on a cron. All backed by a single SQLite file - no cloud, no account, no subscription.

### Key features

| Feature                   | What it does                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Agent orchestration**   | Task loop spawns workers across backends (Claude Code, Codex, Gemini, Copilot, A2A), manages concurrency and review cycles         |
| **Human-in-the-loop**     | Agents submit work for your approval via CLI, Telegram, or Slack before anything lands                                             |
| **Shared memory**         | Short project facts (ports, conventions, gotchas, decisions), ranked by priority and loaded into every session's context           |
| **Task board**            | `todo → queued → doing → review → done` with dependency tracking, priority, and automatic unblocking                               |
| **Multi-backend routing** | Route to Claude (in-process, nothing to install), ACPX (14+ agents), agentapi, or remote A2A endpoints — with `orc doctor` reporting which are usable |
| **Job runner**            | Cron, file-watch, webhook, or manual triggers with full run history                                                                |
| **MCP server**            | 54 tools connect any [Model Context Protocol](https://modelcontextprotocol.io) (MCP) compatible agent — stdio or Streamable HTTP   |
| **Session continuity**    | Snapshots survive context compaction so agents resume where they left off                                                          |
| **Gateway**               | Approve work, search memory, and chat with live agents from Telegram or Slack                                                      |
| **Knowledge bases**       | Upload PDFs, Office files and Markdown or copy in local folders; hybrid full-text + vector search with cited passages            |
| **Skill library**         | Discoverable workflow templates (coder, reviewer, planner, bugfix) that encode your standards                                      |
| **Task flows**            | Per-task graphs: conditional edges, bounded loops, parallel fan-out with joins, and human gates — with hard termination rails      |

## Getting started

### Install

**Recommended: the desktop app.** Download the installer for your machine from [GitHub Releases](https://github.com/niradler/orc/releases) - no Bun, Node or npm needed. Maintainers: see the [local release command](docs/releases.md).

| OS                    | Installer                                                |
| --------------------- | -------------------------------------------------------- |
| macOS (Apple Silicon) | `orc-<version>-mac-arm64.dmg`                            |
| macOS (Intel)         | `orc-<version>-mac-x64.dmg`                              |
| Windows (x64)         | `orc-<version>-windows-x64-setup.exe`                    |
| Linux (x64)           | `orc-<version>-linux-x64.AppImage` (`chmod +x`, then run) |

On first launch the app sets everything up:

- starts the orc daemon (API, scheduler, session watchers, gateway) and opens the dashboard in its window
- when it starts the daemon, generates an API secret, saves it to `~/.orc/config.json`, and sends it for you - Terminals work with nothing to configure
- installs the `orc` CLI to `~/.orc/bin` and adds that folder to your `PATH` (a marked block in your login shell's startup file on macOS and Linux, the user `PATH` on Windows) - open a new terminal and run `orc`
- registers start at login (hidden) and keeps the daemon running from the tray / menu bar when the window is closed; toggle it from the tray menu, quit from there to stop the daemon

The builds are unsigned: on macOS right-click the app and choose Open the first time, on Windows choose "More info" then "Run anyway".

The sidebar shows the saved execution host, for example `Connected (lab)` or `Connected (local)`. Switching hosts applies to new actions immediately. For a full restart, use **Settings → ORC server → Restart ORC server**; it keeps settings and reconnects the dashboard automatically. Restart closes active terminals and may interrupt running work. Host changes never trigger a restart automatically.

<details>
<summary>Headless / CLI-only install (servers, Docker, CI)</summary>

Needs [Bun](https://bun.sh) >= 1.4.4 for the npm install.

```bash
npm install -g orc-ai
```

#### Pre-built binaries

Download from [GitHub Releases](https://github.com/niradler/orc/releases):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-mac-arm64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# macOS (Intel)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-mac-x64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# Linux (x64)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-linux-x64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# Linux (ARM64)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-linux-arm64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# Windows - download orc-windows-x64.exe from the release page and add to PATH
```

#### From source

```bash
git clone https://github.com/niradler/orc
cd orc && bun install && bun build
```

</details>

### Quick start

```bash
# 1. Start the daemon - runs the REST API on :7700, task loop, job scheduler, gateway, and web UI
#    (skip this if you installed the desktop app: it is already running)
orc daemon start

# 2. Create a project
orc project add my-app -d "My application"
orc project use my-app

# 3. Add tasks and memories - everything auto-scopes to my-app
orc task add "Fix the auth bug" --priority high
orc mem add token-refresh-lock -d "Check before touching token refresh" -c "Use RWMutex for token refresh" --priority 60
orc job add nightly --command "bun run test" --trigger cron --cron "0 22 * * *"

# 4. See everything
orc status
orc task list
```

Open `http://localhost:7700` to use the web dashboard - task board, kanban, flow runs, jobs, memories, sessions, knowledge, and a live chat panel. The same server hosts both the REST API and the prebuilt React SPA, so there is no separate command to run for the UI.

Chat uses the shared agent runtime: Claude through its SDK, Codex through its native
CLI App Server, and other agents through ACPX. Choose a model beside the agent
at the top of chat; configure model choices, conversation instructions, tools and permission
actions in **Settings → Chat**. Defaults are stored in `preferences.chat` in ORC's
JSON configuration and apply to new conversations on every device. Conversation
settings show the current conversation's setup. Claude appends the instructions
to its coding system prompt; Codex and ACPX receive them as turn instructions.
Agent and workspace instructions may also apply.

Choose **Ask in chat**, **Allow workspace edits**, or **Full access / bypass permissions**
for Claude and Codex. Codex's Ask mode uses a read-only sandbox with native approval
and question responses in chat. Full access disables Codex's sandbox and permission
prompts; workspace and ORC rules still apply. Change permissions for the next message
in conversation settings, or save defaults under Settings → Chat. ACPX follows its
agent's native permission policy. Existing automatic-action settings remain compatible.
The ORC MCP option adds an authenticated
connection for Claude and Codex without exposing credentials to the browser.
Host configuration can include additional MCP servers; choosing host configuration
does not disable those servers. Other ACPX agents require host configuration.

**Conversation settings → Advanced launch options** accepts SDK options for
Claude or a JSON argument array for ACPX and Codex. For example, Claude accepts
`{"permissionMode":"bypassPermissions","maxTurns":20,"effort":"high"}`;
ACPX accepts `["--approve-all","--timeout","120"]`; Codex accepts
`["-c","model_reasoning_effort=\"high\""]`. Apply saves existing conversations
immediately and affects the next message. Each agent keeps its own options.
ORC validates supported options and retains control of the session identity,
working folder, response transport and hooks. Credentials stay in host configuration;
available native flags depend on the installed agent version.

Use the history icon to continue a saved chat or an ended Claude/Codex coding
session. The terminal's speech-bubble icon continues in chat; chat's terminal icon
continues in a terminal using the same existing resume flow. On phones the terminal
action is in Terminal options. Synced sessions use the existing verified repository/commit handoff;
provide missing checkout details before importing. Native history stays with the
agent, while chat pages through imported history in batches of 500 messages. An active source session
must end before chat resumes it. Resume failures never trigger a fresh session.
New chats use the API working directory locally or the selected SSH host's home;
resumed chats retain their execution host and folder. New conversation keeps the
previous chat in history.

Responses show provider-supplied text, collapsible thinking summaries and tool
input/results as they arrive, with a responding indicator during quiet periods.
Some providers emit complete blocks rather than individual tokens. Conversation
messages and activity are saved in the ORC database. Full-screen mode preserves
the conversation; phones and tablets use a full-screen chat sheet automatically.

> [!TIP]
> The database is created automatically at `~/.orc/orc.db` on first run. No setup needed.

### Web dashboard

The web dashboard ships inside the `orc` binary and is served by the API process at the root path. REST routes live under `/api/<route>` - the SDK, CLI and MCP clients add that prefix themselves - which leaves the root path free for the SPA.

| Route                              | Served from                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                            | `index.html` (web SPA shell)                                                                                                   |
| `GET /assets/*`                    | Built JS/CSS bundles                                                                                                           |
| `GET /api/*`                       | All REST routes                                                                                                                |
| `GET /openapi.json`, `GET /docs`   | Swagger UI                                                                                                                     |
| `GET /mcp`                         | MCP server (streamable HTTP)                                                                                                   |
| `GET /tasks/<id>`, `/knowledge`, … | `index.html` again - a navigation request matching no static file falls back to the SPA shell, so dashboard links are shareable |

`/mcp?mode=meta` serves three meta-tools (`tool_search`, `tool_describe`, `tool_invoke`) instead of the full tool list, which keeps client context small; the model finds a tool, reads its schema, then calls it through `tool_invoke` with the same validation as a direct call. Stdio `orc mcp` serves meta mode by default; pass `--mode full` for the whole tool list. Any other `mode` value returns HTTP 400.

Use `/mcp?project=orc` to set connection-wide defaults for project-aware tools,
including context, tasks, jobs, memories, knowledge and archived-session search.
Use `/mcp?projects=orc,project2` to select several projects in priority order;
combine it with `&mode=meta` if desired. Lists/searches combine the selected
projects before limiting or paginating, and shared global skills/KBs appear once.
Memories remain project-only. New resources default to the first project; an
explicit tool `project` (or supported `project_id`) can select another project
from the connection. ID-targeted operations keep the resource's existing owner.
Global-only reads remain available where the tool supports `scope: "global"`.
Unbound connections keep the existing activeProject/config behavior.

Select at most 50 projects. Names are trimmed, validated and deduplicated
case-insensitively while preserving order; unknown projects reject the request.
Pass either `project` or `projects`, not both. Explicit tool overrides cannot
select projects outside the URL. This is resource scoping, not tenant authorization.

Override the served dist directory with `ORC_WEB_DIST=/path/to/web/dist` if you want to host a custom build (e.g. a fork). If no dist is found, the server runs in pure-API mode.

### Desktop app

`packages/desktop` is the Electron app described under [Install](#install). It attaches to a daemon already answering `/api/health` on the configured port (`api.port`, default 7700) or starts the bundled `orc` binary, and stops only a daemon it started. Its daemon output goes to `~/.orc/desktop-daemon.log`. Launching the app executable with `--quit` quits the running instance (and the daemon it started), which is what installers and scripts should use; `--hidden` starts it without opening a window.

Hardening: sandboxed renderer with context isolation and no Node integration, permission requests denied except clipboard, `<webview>` blocked, navigation locked to the daemon origin (everything else opens in the system browser), Electron fuses that disable `ELECTRON_RUN_AS_NODE` and Node CLI/env options.

`orc daemon start` merges the login shell's `PATH` into its own on macOS and Linux, so `claude`, `codex` and `cursor-agent` are found when the daemon is started by launchd, systemd or a Finder-launched app.

```bash
bun run --filter @orc/desktop bin --only host   # build the orc binary for this machine
bun run --filter @orc/desktop dev               # run the app from source
bun run --filter @orc/desktop dist              # installer for this machine -> packages/desktop/release
bun run --filter @orc/desktop dist:mac          # also dist:win, dist:linux
bun packages/desktop/scripts/smoke.ts           # end-to-end check of the packaged app
```

Builds are unsigned and there is no auto-update yet. Building binaries needs `bun >= 1.4.2` on `PATH` ahead of any `node_modules/.bin/bun`.

## Docker

Run ORC in a container with the published image:

```bash
docker run -d --name orc \
  -p 7700:7700 \
  -v orc-data:/data \
  -e ORC_API_SECRET=$(openssl rand -hex 32) \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  niradler/orc:latest
```

> The container binds `0.0.0.0`. Set a strong `ORC_API_SECRET` before exposing the
> mapped port beyond localhost — without it, every endpoint (including job execution,
> which runs arbitrary shell commands) is open to anyone who can reach the port.

Or with [docker-compose.yml](docker-compose.yml):

```bash
docker compose up -d
```

The source Docker image includes Node, ACPX, Claude Code and Codex CLI, with versions pinned in the Dockerfile. Its default backend is `claude` through the Anthropic SDK. Tool installation alone does not supply authentication: provide `ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` or a container-local Codex login for `codex-cli`, and the credentials required by whichever agent ACPX launches. Mount your repository and use its **container path** as the project folder. Agent configuration/session files can persist in the Compose `orc-home` volume. Existing ORC policies still apply; native Codex rule interception is not certified by CLI/tool availability. These source changes do not update an already published image.

To delegate to an agent running on the host instead, set `ORC_AGENT_LOOP_DEFAULT_BACKEND=agentapi` and run [coder/agentapi](https://github.com/coder/agentapi) on the host:

```bash
agentapi server --allowed-hosts '*' -- \
  claude --allowedTools all \
         --mcp-config '{"mcpServers":{"orc":{"type":"http","url":"http://localhost:7700/mcp"}}}'
```

The `--mcp-config` flag wires the host agent back to ORC's [HTTP MCP endpoint](#mcp-tools) so it can call `task_update`, `memory_*`, `knowledge_*`, etc. `host.docker.internal` lets the container reach agentapi on the host.

## Connect your agent

For coding-agent access, check the installed `spec` CLI bridge first (`spec --help`,
`spec specs`). It can call ORC's MCP server without configuring MCP separately in
each agent. Use an existing ORC registration or an inline endpoint for your selected
installation:

```sh
spec call --mcp-http http://127.0.0.1:7700/mcp context --data '{"project":"my-app"}'
spec call --mcp-http http://127.0.0.1:7700/mcp skill_read --data '{"name":"orc-sdlc","project":"my-app"}'
```

For authenticated servers, use existing secure secret references in spec configuration;
do not put secrets in command arguments. Use `SPEC_NO_CACHE=1` when refreshing live
context and effective skills. Direct MCP connections below remain supported when
already configured. Check the CLI bridge before reporting ORC unavailable.

Lifecycle hooks and MCP registration are separate. The hook examples below record
session activity; also register ORC in the client's supported MCP configuration
using `orc mcp` (stdio) or `<origin>/mcp` (HTTP). Preserve existing servers and
configure authentication privately. Verify tool discovery and a project-scoped
`context` call in each client; installed hooks alone do not establish MCP access.

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|StrReplace|EditNotebook|Bash|Shell|Agent|EnterPlanMode|ExitPlanMode|mcp__orc__task_|mcp__orc__memory_create|mcp__orc__memory_delete|mcp__orc__job_run|mcp__orc__job_create|mcp__orc__job_update",
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/orc/hooks/post-tool-use.ts"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/orc/hooks/pre-compact.ts"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/orc/hooks/session-start.ts"
          }
        ]
      }
    ]
  },
  "env": { "ORC_API_BASE": "http://127.0.0.1:7700", "ORC_PROJECT": "" }
}
```

> [!NOTE]
> Replace `/path/to/orc/` with the path to your ORC clone or the installed package location (run `npm root -g` to find global installs). Hooks handle session events and snapshots automatically.

### Cursor

Add to `.cursor/mcp.json`:

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

<details>
<summary>Codex, Gemini CLI, and other MCP agents</summary>

**Codex** - Copy `hooks/codex/settings.json` to `~/.codex/settings.json` and update the path.

**Gemini CLI / any MCP agent** - Add to your MCP config:

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

</details>

## Usage

### How agents use ORC

```
1. Agent starts          → context() returns active tasks + key memories
2. Agent works           → creates tasks, stores decisions, records events
3. Agent submits work    → task_update(status: "review", comment: "summary")
4. You review            → approve or request changes via CLI / Telegram / Slack
5. Agent continues       → picks up next task or resumes with feedback
6. Session ends          → session_log() records what happened
```

When a context window fills up, `session_snapshot` captures current state into a compact 2KB blob that `session_restore` injects back after compaction - the agent picks up where it left off.

### Agent orchestration

The task loop automatically picks up queued tasks and spawns worker agents:

```bash
# Create a task with a workflow and backend
orc task add "Implement user auth" --skill orc-sdlc --backend claude --priority high

# Or batch-create with dependencies via MCP
task_batch_create({ tasks: [
  { ref: "design", title: "Design schema", skill_name: "orc-sdlc" },
  { ref: "api", title: "Implement API", skill_name: "orc-sdlc", depends_on: ["design"] },
  { ref: "tests", title: "Verify API integration", skill_name: "orc-sdlc", depends_on: ["api"] }
]})
```

The loop handles concurrency, session resume on feedback, review round limits, stale claim cleanup, and backend routing.
Each task's configured flow handles its review; a separate review task is unnecessary.

Every task runs a **flow graph** (see [Task flows](#task-flows)); `orc-default` is the build → review → done pipeline described above.

#### Agent backends

| Backend         | Needs                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `claude`        | Nothing to install: runs **in-process** via [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), which ships with orc. Uses the Claude Code CLI's stored credentials, or `ANTHROPIC_API_KEY`. The default. |
| `acpx`          | The [ACP CLI](https://github.com/openclaw/acpx) — 14+ agents (Codex, Gemini, Copilot, Kiro, Cursor, …). Installed as an optional dependency, so a normal `npm i -g orc-ai` gets it. ORC prefers that bundled version, then falls back to `PATH`. Point `ORC_ACPX_PATH` at a specific copy to override. |
| `agentapi`      | A [coder/agentapi](https://github.com/coder/agentapi) server on the host (HTTP+SSE), wrapping any local coding agent. `AGENTAPI_URL` if it is not on the default port. |
| `a2a`           | A remote [A2A](https://github.com/google/A2A) endpoint, supplied per task/session — nothing local.            |
| `claude-cli`    | The `claude` binary on `PATH`. The pre-SDK path, kept for when driving the real CLI matters.                  |
| `codex-cli`     | The `codex` binary on `PATH`, driven natively instead of through acpx.                                        |
| _anything else_ | Passed to acpx as its agent name, so `--agent-backend gemini` means "acpx driving gemini".                    |

Which of these actually work on a given machine depends on what is installed, so orc probes them rather than making you guess:

```bash
orc doctor          # per backend: usable or not, what it resolved to, what a missing one needs
orc doctor --json   # same, machine-readable
```

The dashboard shows the same probe: the agent-backend field on a task is a picker that marks each backend ready or unavailable, and names the one a task with no backend of its own will use. `GET /api/backends` is the endpoint behind both.

Standalone executables embed the SDK adapter, but its native Claude executable is
external. Install Claude Code on `PATH` to use `claude` in a standalone build; an
API key alone does not supply that executable. The npm distribution uses the SDK's
installed optional executable. Windows npm shims require their `cli.js` and Node
or Bun; missing executable prerequisites are reported before launching a session.

Enable the task loop in `~/.orc/config.json`:

```json
{
  "agent_loop": {
    "enabled": true,
    "poll_interval_minutes": 5,
    "max_workers": 1,
    "default_backend": "claude",
    "session_idle_timeout_minutes": 20,
    "worker_auto_approve": true,
    "default_flow": "orc-default",
    "review_flow": "orc-review-only"
  }
}
```

### Projects

Projects group tasks, memories, and jobs. Set an active project and all commands auto-scope:

Projects can also store an optional Git remote URL in the create/edit dialog or through `--git-remote-url`. HTTPS and SSH addresses are supported without embedded credentials. The address is project metadata; setting it does not clone a repository or change a checkout's remote. Clear it in the editor, send `git_remote_url: null` through the API, or use `orc project update my-app --clear-git-remote-url`.

```bash
orc project add my-app -d "Main application"
orc project use my-app       # set active

orc task list                 # scoped to my-app
orc mem list -q auth          # scoped to my-app
orc task list -p infra        # override to different project
orc task list --no-project    # see everything
```

**Resolution order:** explicit `-p <name>` > `activeProject` from config > error

MCP tools follow the same logic - pass `project: "name"` to scope, or omit to use the active project.

### Memory

A memory is a short project fact worth knowing next session: ports, conventions, gotchas,
decisions, pointers. Each has a lowercase-hyphenated `name` (unique per project), a
`description` saying when it matters, `content` (up to 800 characters by default) and an
optional `priority` from 0 to 100. `context` loads the top 30 memories by priority; agents
then read the ones they need. Procedures and long guidance belong in skills.

```bash
orc mem add ulid-ids -d "Check before adding a table or ID field" -c "All IDs are ULIDs" --priority 90
orc mem list -q ids                    # search names and descriptions
orc mem show ulid-ids
orc mem edit ulid-ids --priority 80 -r "Narrower than we thought"
orc mem history ulid-ids               # every change, with before/after
orc mem revert ulid-ids <change-id> --expected-change-id <latest-change-id> -r "Undo mistaken edit"
```

### Knowledge bases

Knowledge bases hold human reference documents for agents to search and cite. A knowledge base belongs to a project or is global. Add documents by uploading files (PDF, Word, PowerPoint, Excel, HTML, CSV, Markdown, text), writing Markdown in the dashboard, or registering a folder whose files are copied in. ORC never writes the folder: a copy follows its file on each scan until it is edited in ORC, and a file deleted from the folder keeps its copy. Documents have folders, labels and `[[links]]` with backlinks.

```bash
orc kb create Runbooks --project my-app
orc kb add Runbooks ./docs/*.pdf          # upload and parse
orc kb sources add Runbooks ./handbook    # copy a folder in, rescanned periodically
orc kb editable-by Runbooks ui,cli,api    # agents (mcp) may read but not edit
orc kb search "rollback procedure"        # cited passages
orc kb evidence "how do we rotate keys"   # budgeted evidence pack
orc kb usage Runbooks                     # reads by source (mcp, api, cli, ui)
```

Comments on a knowledge base or one of its documents ask for a change: a correction, a source to digest, a lesson to record. Each has an author and source, a status (open, resolved, dismissed) and one closing reply.

Any knowledge base can have a digest: an agent (Claude, Codex, ...) that follows the knowledge base's own instructions on a schedule, handling open comments first and then reading memories, session summaries and audit records to add, correct and clean up documents. The schedule is an ordinary ORC job (cron or manual) with run history. In the dashboard choose **Add digest** on a knowledge base; it starts from a generic template. Scheduled runs are skipped when nothing new happened. Each active project gets a starter **Learnings** knowledge base with a daily 03:00 digest.

```bash
orc kb comment add Learnings "Digest https://example.com/postmortem"
orc kb digest template > digest.md        # edit, then:
orc kb digest set Runbooks -b codex --cron "0 3 * * *" -i digest.md
orc kb digest run Runbooks
```

Search combines title/path matches, SQLite full-text search and, when embeddings are configured (Ollama or an OpenAI-compatible API), vectors stored with sqlite-vec. Set the embedding URL, model and API key or token in Settings or with `orc kb settings`; the key is stored encrypted and never returned by the API. Results cite passages as `kb:<doc>@<rev>#<n>`. Every read is counted per document and source.

The built-in parser handles all formats without extra installs. For better PDF layout, tables and OCR, install the optional [Docling](https://github.com/docling-project/docling) parser from Settings or with `orc kb docling install` (about 2 GB); in `auto` mode it is then used for PDFs and images. Each knowledge base can override the parser.

Each knowledge base lists the call sources that may change its documents (`editable_by`: `ui`, `cli`, `api`, `mcp`; all four by default). Agents write with `kb_write` and `kb_document` (partial edits by exact text or line range) where `mcp` is allowed; every change is a revision recording its source and session. Knowledge base settings and knowledge settings cannot be changed over MCP, so an agent cannot widen its own access. Rendered Markdown shows remote images as links instead of loading them.

To back up knowledge bases, stop ORC and copy `~/.orc/orc.db` (with its `-wal` and `-shm` files) and `~/.orc/knowledge/originals/`, plus `~/.orc/secret.key`, without which a saved embedding API key cannot be decrypted and must be entered again. The search index, parse results and Markdown copies are rebuilt on the next start.

**MCP tools:** `kb_list`, `kb_search`, `kb_evidence`, `kb_read`, `kb_documents`, `kb_write`, `kb_document`, `kb_comment`, `kb_manage`, `kb_digest`, `kb_maintenance`

### Task status flow

```
todo → queued → doing → review → done
                  │         │
                  v         v
               blocked    changes_requested → doing
                  │
                  v
                paused
```

Tasks with `required_review: true` (default) need your approval before moving to `done`. Set `max_review_rounds` to auto-pause tasks that cycle through too many revision rounds.

`queued` means a node is waiting for a worker slot — the task is claimed but nothing is running on it yet, so it counts as pending rather than in progress (the dashboard's board shows it under Todo, labelled `queued`). It becomes `doing` when a session actually starts, which is what keeps the board from showing more work in flight than `agent_loop.max_workers` allows.

<img src="assets/TaskFlow.gif" alt="Task Flow" width="600" />

### Task flows

That pipeline is not hardcoded — it is a **flow graph** named `orc-default`. A flow is nodes joined by conditional edges that may cycle, so a task can run whatever shape its work actually needs: a plan → build → verify loop, a bug-fix-then-confirm loop, an executor with an independent supervisor, or three reviewers in parallel joined before a decision.

The graph itself is deterministic; only the nodes are agents. That means loops, branches, and fan-out behave predictably and are fully unit-testable, while the agents just do the work and report a verdict.

```bash
orc flow list                                    # what graphs are available
orc flow show orc-default              # nodes, edges, limits
orc task add "Fix the flaky test" --flow orc-default --skill orc-sdlc
orc flow status <taskId>                         # active nodes + the ledger of outcomes
orc flow resume <taskId> --outcome approved      # resolve a human gate
orc flow halt <taskId>                           # stop it and kill live nodes
```

| Built-in workflow | Use it for |
| --- | --- |
| `orc-default` | Development: understand, plan as needed, implement, verify and independently review; bounded rework. `required_review: false` explicitly skips agent review. |
| `orc-human-review` | The same development process plus human sign-off. Agent review and human approval are always required, even if `required_review` is false. |
| `orc-review-only` | Review existing work; approve, request changes, or pause when evidence is insufficient. |

**Nodes** are `agent` (runs a session with a skill), `gate` (deterministic branching, fan-out, join points), `human` (waits for you), or `terminal` (ends the run and sets the task's final status). **Edges** carry declarative conditions — `outcome`, `visits`, `var`, `elapsed_secs`, composed with `all`/`any`/`not` — which are data, never evaluated code.

Loops always terminate. Per-node `max_visits`, a per-run node-execution budget, a wall clock, plus deadlock and stall detection each halt the run and hand the task back to you with an explanation of which rail tripped.

#### Custom graphs per task

For work no named flow fits, attach a bespoke graph to a single task:

```bash
orc flow validate --file ./my-graph.json          # catch mistakes before running anything
orc flow attach <taskId> --file ./my-graph.json --start
```

Definitions are JSON, validated on load: unknown edge targets, unreachable nodes, a graph that can never finish, or an edge shadowed by an earlier catch-all are all rejected up front rather than discovered mid-run. Reusable flows go in `~/.orc/flows/<name>/flow.json` (or `./.orc/flows/` to pin one per repo), and a user flow shadows a built-in of the same name — that is how you customise `orc-default` without patching orc.

Agents can do all of this themselves via the `flow_list`, `flow_read`, `flow_create`, `flow_attach`, `flow_status`, and `flow_report` MCP tools, so a planner can design the pipeline for the work it just decomposed.

#### In the web dashboard

A task's **Flow** section draws the graph the run froze at start next to its ledger: which node is active, the verdict each visit produced, how many visits a node has spent of its budget, per-node timings and errors, a link to each node's agent transcript, and — when a rail tripped — which one and why. Loopbacks are drawn as edges that go backwards, so a rework cycle looks like one.

When a run parks on a human gate, that panel is where you answer it: pick one of the outcomes the node's own edges can route, add a comment, and the flow continues. `Halt` stops a run and kills its live sessions. The **Flows** page lists every graph available with its source, marks the one a task with no flow of its own will run, shows any definition, and reports flows that failed validation along with the errors — so a broken graph is visible before a task tries to run it.

### Jobs

```bash
orc job add deploy    --command "bun run deploy"    --trigger manual
orc job add nightly   --command "bun run test"      --trigger cron --cron "0 22 * * *"
orc job add on-change --command "bun run lint"      --trigger watch --watch "./src"
orc job add on-push   --command "bun run ci"        --trigger webhook
```

Jobs separate **what runs** from **when it runs**. Choose **Run command**,
**Run agent**, or **Create task** in the dashboard. Command is required only for
Run command. Agent jobs save instructions, backend, optional model and explicit
tool approval; each run links to its tracked session. Task jobs save a task title
and instructions and link to the created task. **Start the task flow automatically**
is off by default, so generated tasks wait for a manual flow start.
The CLI accepts typed actions through `--action-config <json>`.

New jobs are disabled by default. Select **Enable this job immediately** during
creation or pass `orc job add ... --enable` to opt in. Jobs supports enable/disable
directly in the list and for selected rows. Projects shares the selection toolbar
for activate, pause and archive actions; select-all applies only to displayed rows.
Failed bulk updates remain selected so you can retry them.

### Webhooks

Open **Activity → Webhooks** to see all configured event sources and their connected
jobs. Create a source without a job, copy its URL and one-time signing secret, then
register them with the provider. Sources belong to the selected project, or are
shared across projects when created in All projects.

In **Jobs → New job** (or Edit), choose **Webhook** as the trigger, select an
existing source or create one inline, and set this job's event/action filters.
One source can trigger multiple enabled jobs, each with its own filters and action.
The Webhooks page shows source enablement, connected jobs and recent deliveries,
including individual run results and links to generated tasks or agent sessions.
Deleting a job disconnects it while preserving the reusable source.

For command jobs, accepted JSON is passed unchanged on stdin; bounded metadata is
also available as `ORC_WEBHOOK_*` environment variables. Agent and task jobs receive
up to 50,000 characters of event data, explicitly marked as untrusted input, alongside
the configured instructions. Delivery history stores event metadata and a payload
hash, not the payload body or signing secret; generated tasks and agent prompts can
contain the supplied event data.

Generic endpoints verify `X-Orc-Signature-256: sha256=<HMAC-SHA256 of the raw body>`.
Use `X-Orc-Event` for event filtering and `X-Orc-Delivery` (or
`Idempotency-Key`) for deduplication. GitHub endpoints use
`X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery` directly.
Event names and payload `action` values are configurable, so PR lifecycle,
reviews, workflow runs, releases, or later providers use the same job trigger.

Signing secrets are encrypted at rest and shown only when an endpoint is created or
rotated. The receiver is intentionally outside normal ORC bearer authentication;
the per-endpoint HMAC is its authentication boundary. Management remains under the
authenticated API.

### Channels (Telegram / Slack)

Use **Settings → Channels** to configure connections, verify bot/workspace identity,
pair approved recipients, and define ordered inbound rules that invoke agents.
Rules support simple predicates and nested AND/OR/NOT groups; authorization runs
before routing, and the first matching rule wins. Agent replies return to the
original conversation. Agents can also send independently through `channel_send`
over MCP or `POST /api/channels/messages`.

Common Markdown renders automatically. Optional `overrides` accepts the provider's
native JSON message options, including Slack Block Kit and Telegram HTML/keyboards.
Connections, recipients and routes live in SQLite; credentials are encrypted or
referenced through server environment variables. Pairing grants messaging access
only; inbound invocation and Attention notifications are separate opt-ins.

See the [channel setup, routing, API/MCP and native payload reference](skills/orc-platform/references/channels.md).

### Legacy gateway (Telegram / Slack)

Approve agent work from your phone, search memory, or start a live AI session.

```json
{
  "gateway": {
    "telegram": {
      "enabled": true,
      "token": "7123456789:AAF...",
      "authorized_users": [123456789]
    }
  }
}
```

**Commands:** `/status`, `/tasks`, `/approve <id>`, `/reject <id>`, `/jobs`, `/run <name>`, `/mem <query>`, `/agent <claude|codex>`

> [!TIP]
> Create a Telegram bot via [@BotFather](https://t.me/BotFather) and find your user ID via [@userinfobot](https://t.me/userinfobot).

<details>
<summary>Slack setup</summary>

```json
{
  "gateway": {
    "slack": {
      "enabled": true,
      "bot_token": "xoxb-...",
      "app_token": "xapp-...",
      "authorized_users": ["U01ABCDEF"]
    }
  }
}
```

Same commands as Telegram. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps) with Socket Mode enabled.

</details>

## Skills

ORC ships two entry-point skills. Their supporting references load only when needed; custom skills and packages remain supported.

### Install skills

```bash
# Install all ORC skills into your agent
npx skills add niradler/orc --all

# Or pick specific ones
npx skills add niradler/orc --skill orc-platform orc-sdlc

# Global install
npx skills add niradler/orc --all -g
```

### Entry-point skills

| Skill | Purpose |
| --- | --- |
| `orc-platform` | Operate ORC domains: setup/interfaces/auth, memory and maintained KBs/digests/embeddings, work/operations, sessions/SSH/Git/chat, rules and agent packages |
| `orc-sdlc` | Requirements → risk/complexity classification → direct work or plan → implementation → tests/completeness → review/rework → authorized Git delivery, with shared learning throughout |

Start with the relevant entry point and read only its selected reference. Platform
guidance groups related domains while keeping memory, execution and rules independently
loadable; SDLC has planning, development and review/delivery references. Clear low-risk
work can execute directly; assigned managed nodes preserve roles and flow contracts.

### Built-in skill templates

Skill templates live in `skills/*/SKILL.md` (built-in) and `~/.orc/skills/` (user-defined). Agents discover them via `skill_list` and load with `skill_read`.

Skills can be assigned to several projects; no assignments means global. Connect
to `/mcp?project=orc` or `/mcp?projects=orc,project2` to discover and read only
the selected projects' skills plus global skills. Add `&mode=meta` for meta mode.
Project names are case-insensitive; unknown projects are rejected. Tool arguments
can narrow the selection to one project from the URL. Shared skills appear once;
project-specific instructions use the first applicable override in URL order,
then global instructions. An explicit tool `project` selects that project's version.
Named reads, supporting files, compatibility aliases and downloads follow the same
assignment rule. Project-specific instruction overrides remain independent of assignments.
MCP `skill_create` inherits the selected project; unscoped creation is global.

Manage assignments with `orc skill projects <name> --set <project-id> <project-id>`;
use `--global` to clear assignments, or omit flags to inspect them. The API exposes
authenticated `GET`/`PUT /api/skills/{name}/projects` with `{ "project_ids": [] }`.
Existing skills remain global until assigned. Reassign skills before deleting a project.
The project selector controls discovery, not API authentication or tenant authorization.

`skill_list({ q: "code review", limit: 30, offset: 0 })` searches names and
descriptions with weighted BM25, prefixes, English stemming, phrase matches,
substrings and bounded typo tolerance. Every term must match; results are sorted
by descending relevance score, with names breaking ties. Scores are relative
relevance, not probabilities; no embedding service is required. Without `q`,
the existing reads/recent sorting applies. MCP responses show `total`, `offset`,
`limit` and `next_offset`; pass the next offset to fetch another page. API
`GET /api/skills?q=...&limit=30&offset=0` returns `skills` plus those fields;
`next_offset: null` means the end. Default page size is 30, maximum 500.
CLI equivalents are `orc skill list -q "code review" --project-id <id> --limit 30 --offset 0`.

On the **Skills** page, every skill has an **Agent discovery** toggle, including
built-in, user/imported and modified skills. Visibility applies across the installation
and defaults to visible. Hidden skills stay on the Skills page for management and
remain readable by name, including supporting files; existing task flows continue to
use them. **Modified** means its instructions have an authored global/project edit.

The policy is saved under `skills.hidden_skills` in `~/.orc/config.json` and
read afresh for discovery, including by existing MCP processes. `GET /api/skills`
omits hidden skills; `include_hidden=true` returns the management catalog with
`discovery_hidden` metadata. `GET /api/skills/settings/visibility` reads the policy and
`PUT /api/skills/settings/visibility` replaces its `hidden_skills` array using the usual
API authentication. This installation-wide preference ignores project config.
New skills default to visible until hidden explicitly. Legacy `hidden_builtins` settings
remain supported with their original built-in-only behavior; modified instructions
remain discoverable under that legacy setting unless explicitly hidden via `hidden_skills`.

Retired built-in names (such as `orc-coder` and `orc-reviewer`) remain readable
as compatibility routes for saved tasks, authored overrides and frozen flows, but
are not additional discovery entries. New tasks and built-in flows use
`orc-sdlc`; the node role selects implementation versus independent review.
Applicable authored legacy worker/coder/reviewer/knowledge instructions remain
role-scoped supplements with revision provenance, including on resume. Other authored
legacy domain guidance is indexed from the canonical effective read and loads by name
when relevant. Conflicts are surfaced rather than silently rewriting stored overlays.

Add custom skills by creating a `SKILL.md` in `~/.orc/skills/my-workflow/SKILL.md`.

Skills are complete folders, following the [Agent Skills format](https://agentskills.io/specification). Keep the entry instructions in `SKILL.md` and reference supporting files with paths relative to the skill root:

```text
my-workflow/
  SKILL.md
  references/guide.md
  references/topics/details.md
  scripts/check.py
  assets/template.json
```

`skill_list` loads metadata only. `skill_read` returns the entry instructions plus a recursive `files` inventory; supporting content loads on demand. For example, `skill_read({ name: "my-workflow", ref: "scripts/check.py" })` reads a script without executing it. Bare reference filenames such as `ref: "guide.md"` remain supported. Binary assets are transported as base64 with `encoding: "base64"`.

```bash
# Import the whole folder through the API
orc skill create my-workflow --directory ./my-workflow
orc skill read my-workflow --ref references/topics/details.md
orc skill validate ./my-workflow
orc skill export my-workflow ./exported/my-workflow
```

Import GitHub skills from **Skills → Import from GitHub**. Paste a repository URL, `owner/repo`, a GitHub skill-folder URL, or a `https://skills.sh/owner/repo/skill` link, discover the skills, then select which to import. Private repositories use `gh` credentials on the configured execution host (local by default, remote when `ssh.host` is set), falling back to `ORC_GITHUB_TOKEN` / `github.token` on the ORC server; credentials need access to the repository. Without credentials, public repositories still work. ORC copies each complete folder at the displayed commit, including nested documentation, scripts and binary assets. Existing names are never overwritten by an import. Select up to 16 skills per import (64 MiB total).

```bash
orc skill import vercel-labs/agent-skills --list
orc skill import vercel-labs/agent-skills --skill web-design-guidelines
orc skill sync web-design-guidelines
```

Imported skills remain editable: open the skill, choose `SKILL.md` or a supporting text file, then **Edit** and **Save changes**. **Sync from GitHub** fetches the source again and compares each file against its last imported version. Local edits are kept when upstream has not changed that file. If both sides changed the same file, the whole sync pauses and lists conflicts. **Review override → Replace listed files** requires confirmation and replaces only those conflicts with upstream versions; unrelated local edits remain. If the local files or upstream commit changed since review, ORC requires a new sync check. Sync retains the previous folder under `~/.orc/skill-sync-backups/`; import provenance and upstream baselines live under `~/.orc/skill-imports/`. These backups are retained until manually removed. Private repositories and non-GitHub sources are not supported by this importer.

The dashboard can import a skill folder or add supporting files individually, then open each file from the detail sheet. API `POST /api/skills` and MCP `skill_create` accept optional `files: [{ path, content, encoding? }]` alongside `name` and the full `SKILL.md` `content`. Encoding defaults to `utf8`. Bundles allow 512 supporting files, 8 MiB per file and 16 MiB total. Paths must stay inside the skill folder; symlinks are excluded and cannot be read. The legacy `references` inventory is retained for existing clients. Worker prompts include the skill's entry path and file inventory so relative links resolve from the skill directory.

### Shared agents and portable packages

ORC shares authored definitions across coding agents through one library. An agent profile describes the specialist; a backend selects the coding agent that runs it. Profiles use [APM's `.agent.md` format](https://microsoft.github.io/apm/producer/author-primitives/instructions-and-agents/): YAML frontmatter with a required `description`, optional `name`, `model`, `tools`, `color`, and `handoffs`, followed by Markdown instructions. Unknown agent fields are preserved. Standalone profiles live in `~/.orc/agents/`; project profiles in `.apm/agents/` override matching shared IDs.

An imported package keeps its entire directory under `~/.orc/packages/<name>/`, including `apm.yml`, `.apm/agents/`, `.apm/skills/<name>/SKILL.md`, `.apm/instructions/`, scripts, references, and binary assets. Root `SKILL.md` packages are supported too. Manifest validation uses Microsoft's pinned OpenAPM v0.1 schema; the v0.1.41 schema is supported when explicitly selected with `$schema`. Import/export preserves dependency declarations, scripts, and extension fields. Import does not resolve dependencies or execute lifecycle scripts; use APM for those operations before importing the resulting package.

```bash
orc agent-package import ./team-agents
orc agent list
orc agent read team-agents/reviewer
orc agent-package export team-agents ./exported/team-agents
orc agent create reviewer --file ./reviewer.agent.md
orc agent export reviewer ./exported/reviewer.agent.md
```

Select a shared profile independently of its backend in an ORC flow:

```json
{ "kind": "agent", "agent": "team-agents/reviewer", "backend": "codex-cli", "outcomes": ["pass", "fail"] }
```

The same profile instructions and relative file locations reach every backend. Pinned models are supported by Claude SDK, Claude CLI, Codex CLI, and ACPX. Tool allowlists are enforced by Claude SDK and Claude CLI; other adapters reject profiles declaring tool restrictions. Unsupported model/tool settings fail before launch. Tool names and model IDs must be valid for the selected coding agent. Explicit session/flow model choices override the profile's model. Handoffs remain authored declarations; ORC flow edges control execution. Package instructions without `applyTo` are included automatically; scoped instructions retain their original glob strings or arrays in an on-demand index, which the coding agent applies when working on matching files.

The dashboard's **Packages** page imports OpenAPM and portable Agent Plugins v1.0.0 folders, inspects/exports their files, and saves reusable agent setups. **Run with → Open in ORC terminal** prepares the selected packages through Microsoft APM or Vercel skills, then opens the coding agent. Deployment persists in the chosen project; normal upstream trust and authentication prompts remain. Whole portable plugins activate through APM/Copilot; skills-only plugins can use Vercel with Claude, Codex or Copilot. See [Reusable agent packages](docs/agent-packages.md) for requirements and supported combinations.

The **Agents** page creates/reads specialist profiles. API `/api/agents` and `/api/agent-packages`, SDK clients, CLI, and MCP all access the same files. MCP tools are `agent_list`, `agent_read`, `agent_create`, `agent_package_list`, `agent_package_read`, and `agent_package_import`. Package agent IDs are namespaced as `<package>/<file-stem>`.

## MCP tools

Agents can fetch original skill scripts/assets with
`skill_read({name: "orc-platform", ref: "scripts/upload-session.py", download: true, project: "my-app"})`.
It returns a signed ten-minute `download_url`, `sha256`, `size_bytes` and expiry
instead of the file body. Download to a local file and verify the hash; do not
reconstruct scripts from tool text. The URL authorizes only that file version and
does not contain the API secret. Keep it private. Expiry, API restart or file changes
require a new URL. Downloading never executes scripts. The authenticated REST mint
endpoint is `POST /api/skills/<name>/download` with `ref` and optional scope.

Tools are available to any connected agent. Start every session with `context`.

| Category      | Tools                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project**   | `project_list`                                                                                                                              |
| **Memory**    | `context`, `memory_list`, `memory_read`, `memory_create`, `memory_update`, `memory_delete`, `memory_history`, `memory_revert`                |
| **Task**      | `task_list`, `task_get`, `task_create`, `task_update`, `task_batch_create`                                                                  |
| **Skill**     | `skill_list`, `skill_read`, `skill_create`                                                                                                  |
| **Agent**     | `agent_list`, `agent_read`, `agent_create`, `agent_package_list`, `agent_package_read`, `agent_package_import`                               |
| **Flow**      | `flow_report`, `flow_status`, `flow_list`, `flow_read`, `flow_create`, `flow_attach`                                                        |
| **Knowledge** | `kb_list`, `kb_search`, `kb_evidence`, `kb_read`, `kb_documents`, `kb_write`, `kb_maintenance`                                               |
| **Search**    | `search`                                                                                                                                    |
| **Job**       | `job_list`, `job_run`, `job_status`                                                                                                         |
| **Session**   | `session_event`, `session_snapshot`, `session_restore`, `session_log`                                                                       |

## REST API

Runs on port 7700 with auto-generated OpenAPI spec.

- **Swagger UI:** `GET /docs`
- **OpenAPI spec:** `GET /openapi.json`

<details>
<summary>Full endpoint list</summary>

| Method                  | Path                           | Description                    |
| ----------------------- | ------------------------------ | ------------------------------ |
| `GET`                   | `/health`                      | Health check                   |
| `GET/POST/PATCH/DELETE` | `/projects`                    | CRUD projects                  |
| `GET`                   | `/projects/by-name/{name}`     | Lookup by name                 |
| `GET`                   | `/projects/{id}/summary`       | Task/memory/job counts         |
| `GET/POST/PATCH/DELETE` | `/tasks`                       | CRUD tasks                     |
| `GET/POST`              | `/tasks/{id}/notes`            | Task notes                     |
| `GET/POST/DELETE`       | `/tasks/{id}/links`            | Task dependencies              |
| `GET/POST`              | `/memories`                    | List (`q`, `sort`) / create    |
| `GET/PATCH/DELETE`      | `/memories/{name}`             | Read / update / delete by name |
| `GET`                   | `/memories/{name}/history`     | Change history                 |
| `POST`                  | `/memories/{name}/revert`      | Revert a change                |
| `GET`                   | `/knowledge/search`            | Search documents (BM25/hybrid) |
| `GET`                   | `/knowledge/documents/{id}`    | Get document by docid          |
| `GET/POST/DELETE`       | `/knowledge/collections`       | CRUD collections               |
| `POST`                  | `/knowledge/update`            | Re-index collections           |
| `GET`                   | `/knowledge/status`            | Index status                   |
| `GET/POST`              | `/jobs`                        | CRUD jobs                      |
| `POST`                  | `/jobs/{id}/trigger`           | Trigger a job                  |
| `GET`                   | `/jobs/{id}/runs`              | Run history                    |
| `GET`                   | `/jobs/{id}/runs/{runId}/logs` | Run logs                       |
| `GET`                   | `/skills`                      | Skill templates                |
| `GET`                   | `/backends`                    | Agent backends + usability     |
| `GET/POST`              | `/flows`                       | List/create flow graphs        |
| `GET`                   | `/flows/{name}`                | Read a flow definition         |
| `POST`                  | `/flows/validate`              | Validate without saving        |
| `GET/POST`              | `/tasks/{id}/flow`             | Get a task's run / attach one  |
| `POST`                  | `/tasks/{id}/flow/resume`      | Resolve a human node           |
| `POST`                  | `/tasks/{id}/flow/halt`        | Stop a running flow            |
| `GET`                   | `/sessions`                    | Agent session logs             |
| `POST`                  | `/mcp/tool`                    | Execute any MCP tool via HTTP  |

</details>

## CLI reference

```
orc daemon start|stop|status     Manage the daemon (API + scheduler + gateway)
orc daemon install|uninstall     Register/remove auto-start on login/boot
orc api                          Start the API server only
orc mcp [--mode meta|full]       Start the MCP server (stdio, meta by default)
orc home                         Show ~/.orc directory and config
orc status                       Show API health and counts
orc doctor                       Check which agent backends are usable here

orc project list|add|show|use|update|archive
orc task list|add|show|update|done|review|approve|reject|delete
orc mem list|show|add|edit|delete|history|revert
orc job list|add|run|runs
orc session list|show|log
orc skill list|show
orc flow list|show|validate|create|attach|status|resume|halt
orc kb search|get|collections|add|remove|update|status
```

> [!NOTE]
> All task/mem/job/kb commands default to the active project. Use `-p <name>` to override or `--no-project` to see everything. Add `--json` for machine-readable output.

## Configuration

ORC merges config in priority order (later wins):

1. `~/.orc/config.json` - user global
2. `./.orc/config.json` - project-local
3. Environment variables

<details>
<summary>Environment variables</summary>

| Variable                         | Default               | Description                                       |
| -------------------------------- | --------------------- | ------------------------------------------------- |
| `ORC_DB_PATH`                    | `~/.orc/orc.db`       | SQLite database path                              |
| `ORC_API_HOST`                   | `127.0.0.1`           | API listen host (set to `0.0.0.0` in Docker)      |
| `ORC_API_PORT`                   | `7700`                | API listen port                                   |
| `ORC_API_SECRET`                 | -                     | Bearer token for auth                             |
| `ORC_TERMINALS_ALLOW_WITHOUT_SECRET` | `false`           | Legacy option; no longer needed. Terminals follow API open/authenticated mode |
| `ORC_TELEGRAM_TOKEN`             | -                     | Enables the Telegram gateway when set             |
| `AGENTAPI_URL`                   | `http://127.0.0.1:3284` | URL of host agentapi server (for `agentapi` backend) |
| `ANTHROPIC_API_KEY`              | -                     | Required for the `claude` backend (Anthropic SDK) |
| `ORC_SESSION_ID`                 | `default`             | Per-agent session identifier                      |
| `ORC_LOG_LEVEL`                  | `info`                | `debug`, `info`, `warn`, `error`                  |
| `ORC_LOG_DIR`                    | `~/.orc/logs`         | Log file directory                                |
| `ORC_LOG_FILE`                   | `1`                   | Set to `0` to disable file logging                |
| `ORC_RUNNER_TIMEOUT`             | `300`                 | Default job timeout (seconds)                     |
| `ORC_AGENT_LOOP_ENABLED`         | `false`               | Enable the agent task loop                        |
| `ORC_AGENT_LOOP_POLL_INTERVAL`   | `5`                   | Task loop poll interval (minutes)                 |
| `ORC_AGENT_LOOP_MAX_WORKERS`     | `1`                   | Max concurrent worker agents                      |
| `ORC_AGENT_LOOP_DEFAULT_BACKEND` | `claude`              | Default agent backend                             |
| `ORC_AGENT_LOOP_IDLE_TIMEOUT`    | `20`                  | Session idle timeout (minutes)                    |
| `ORC_AGENT_LOOP_AUTO_APPROVE`    | `true`                | Auto-approve worker tool permissions              |
| `ORC_KNOWLEDGE_ROOT`             | beside `orc.db`       | Knowledge base storage (files, index)             |
| `ORC_KNOWLEDGE_PARSER`           | `auto`                | `auto`, `basic` or `docling`                      |
| `ORC_KNOWLEDGE_EMBEDDING_PROVIDER` | `none`              | `none`, `ollama` or `openai`                      |
| `ORC_KNOWLEDGE_EMBEDDING_URL`    | provider default      | Embedding endpoint                                |
| `ORC_KNOWLEDGE_EMBEDDING_MODEL`  | provider default      | Embedding model                                   |
| `ORC_KNOWLEDGE_EMBEDDING_API_KEY` | -                    | API key for OpenAI-compatible embeddings          |
| `ORC_SQLITE_VEC_PATH`            | bundled               | Path to a sqlite-vec `vec0` library               |

</details>

### Logs

All output goes to **stderr** (colored, human-readable) and **`~/.orc/logs/orc.log`** (JSON lines, machine-readable). Log files rotate at 10 MB with 3 rotated backups (30 MB total).

```bash
# Tail recent errors
grep '"level":"error"' ~/.orc/logs/orc.log | tail -20

# Watch live
tail -f ~/.orc/logs/orc.log | jq .
```

### Running as a background service

The daemon runs the API server, job scheduler, file watchers, and gateway in one process. To start it automatically on login/boot:

```bash
orc daemon install     # register auto-start for your OS
orc daemon uninstall   # remove auto-start registration
```

| Platform    | Mechanism                                                          | Auto-restart on crash |
| ----------- | ------------------------------------------------------------------ | --------------------- |
| **Windows** | Registry Run key (`HKCU\...\Run`)                                  | No                    |
| **macOS**   | launchd (`~/Library/LaunchAgents/com.orc.daemon.plist`)            | Yes                   |
| **Linux**   | systemd user service (`~/.config/systemd/user/orc-daemon.service`) | Yes                   |

No admin/root privileges required on any platform.

```bash
# Manual control
orc daemon start       # start in foreground (API + scheduler + gateway)
orc daemon stop        # stop a running daemon
orc daemon status      # show scheduled jobs
orc api                # start the API server only (no scheduler/gateway)

# Check daemon health
curl http://localhost:7700/health
```

Logs go to `~/.orc/daemon.log`. Config is read from `~/.orc/config.json`.

## Architecture

```
packages/
  core/           Config (Zod), types, logger, ULID IDs
  db/             Drizzle ORM + SQLite (~/.orc/orc.db)
  api/            Hono REST API + OpenAPI spec (:7700)
  sdk/            Typed HTTP client from OpenAPI
  cli/            Commander CLI (the `orc` binary)
  mcp/            MCP server (stdio + Streamable HTTP at /mcp)
  runner/         Job executor + cron/watch scheduler + task loop
  gateway/        Telegram + Slack bridge + agent sessions
  channels/       Provider transport, rendering, pairing and channel delivery
  agent-runtime/  Agent backend registry (claude, acpx, a2a)
  task-service/   Task status transitions + side-effects
  web/            React dashboard (Vite + Tailwind + shadcn + React Query)
```

Data flow: `Agent → MCP → API → DB` / `CLI → SDK → API → DB`

## Development

```bash
bun install       # install all workspace deps
bun dev           # API + CLI + web in watch mode
bun typecheck     # typecheck all packages
bun check         # biome lint + format
bun test          # run all tests
bun build         # build all packages
```

See the [development guide](./docs/development.md) for dev ports, servers, testing, and troubleshooting. [AGENTS.md](./AGENTS.md) contains session-wide agent instructions and coding conventions. For releases and installation upgrades, follow the [release protocol](./docs/releases.md).

## Learn more

- [Knowledge learning loop](./docs/knowledge-loop.md) - memories, knowledge base digests and comments, skill edits, and human revert
- [Agent Rules](./docs/agent-rules.md) - opt-in tool protection, revision history, deterministic job actions, and evidence-based skill evaluation
- [Usage Guide](./docs/usage-guide.md) - best practices for memory, tasks, multi-agent workflows, and configuration
- [Vision](./docs/vision.md) - why ORC exists and the problem it solves
- [Roadmap](./docs/roadmap.md) - what shipped and what's next
- [Agent Orchestration Design](./docs/agent-orchestration-design.md) - architecture spec for the task loop and multi-agent workflow
- [Task Flows](./docs/task-flows.md) - flow graphs: nodes, conditional edges, bounded loops, fan-out and joins, and how to author your own

### Knowledge learning

Session review records verified lessons, and each project's Learnings knowledge base has a daily digest that turns memories, session summaries and comments into documents. Reuse them through ordinary KB search and skill reads. The dashboard shows learning history, audit records and manual skill revert. See [Knowledge learning loop](docs/knowledge-loop.md) for scopes, scheduling and validation limits.
