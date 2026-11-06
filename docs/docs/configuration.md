# Configuration

## Usage in Settings

Open **Settings → Usage** for session token history and account quotas. History
shows lifetime token totals for imported native sessions started in the last 7,
30 or 90 days, or all time, across all projects. Daily rows use UTC session start
dates; they do not represent tokens consumed that day. Missing counts are reported
separately, Cursor counts are estimates, and these totals are not billed costs.
The existing session importers determine which tokens are counted; this view does
not rescan transcripts or include managed gateway sessions a second time.

![Usage in Settings with demo data](/screens/settings-usage.png)

Account quotas show percentage used and reset times for local Codex and Claude
accounts on the API host. ORC reads the existing CLI login from
`CODEX_HOME/auth.json` (default `~/.codex/auth.json`) or
`CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude/.credentials.json`) and
requests quota data from the provider over HTTPS. Credentials stay on the server
and are never returned to the browser. Keychain-only, API-key and SSH-host logins
are not supported. Missing logins, expired access and unsupported provider
responses display an unavailable state. Sign in again using the provider CLI
when access expires; ORC does not refresh or modify provider credentials.

The authenticated read-only routes `GET /api/usage/history?days=30` and
`GET /api/usage/quotas` expose the same data. History accepts `7`, `30`, `90`, or
`0` (all time). Quota requests share a 60-second server cache and an 8-second
provider timeout. The Usage panel polls quotas once a minute while open; Refresh
retries both views while respecting that cache. Provider quota interfaces can
change; unavailable quota data does not prevent session history from loading.

Where ORC keeps its config and data, every config key and environment variable you are likely to set, logs, running as a background service, and authentication.

## Files and directories

| Path | Holds |
| --- | --- |
| `~/.orc/config.json` | Global config. The CLI (`orc project use`), the dashboard and the desktop app write here. |
| `./.orc/config.json` | Optional config read from the directory the process starts in |
| `~/.orc/orc.db` | SQLite database (`db.path`) |
| `~/.orc/knowledge/` | Knowledge base files and index (beside the database) |
| `~/.orc/secret.key` | Key that encrypts stored secrets. Back it up with the database. |
| `~/.orc/logs/orc.log` | Structured log |
| `~/.orc/daemon.log` | Daemon stdout/stderr when run as a launchd or systemd service |
| `~/.orc/daemon.pid` | PID of the running daemon |
| `~/.orc/desktop-daemon.log` | Daemon output when the desktop app started it |
| `~/.orc/bin/` | CLI installed by the desktop app |

`~` is `HOME` (`USERPROFILE` on Windows). Show the resolved paths and daemon state:

```bash
orc home
```

## Precedence

Later wins:

1. `~/.orc/config.json`
2. `./.orc/config.json`
3. Environment variables
4. Global CLI flags (`--port`, `--host`, `--db`, `--secret`, `--log-level`, `--runner-timeout`, `--runner-max-jobs`, `--snapshot-max-bytes`)

An invalid config file stops ORC with `Invalid orc config` and the failing key.

## Example config

```json
{
  "api": { "port": 7700, "host": "127.0.0.1", "secret": "change-me" },
  "activeProject": "my-app",
  "agent_loop": { "enabled": true, "default_backend": "claude", "max_workers": 2 },
  "runner": { "default_timeout_secs": 300, "max_concurrent_jobs": 5 },
  "rules": { "enabled": true }
}
```

## Config keys

### `api`

| Key | Default | Env | Purpose |
| --- | --- | --- | --- |
| `api.port` | `7700` | `ORC_API_PORT` | API, dashboard and MCP port |
| `api.host` | `127.0.0.1` | `ORC_API_HOST` | Bind address. `0.0.0.0` exposes ORC on the network. |
| `api.secret` | none | `ORC_API_SECRET` | Bearer secret. Unset means no auth. |
| `api.session_days` | `30` | `ORC_API_SESSION_DAYS` | Dashboard sign-in and default token lifetime (1-365) |
| `api.cors_origins` | `[]` | `ORC_API_CORS_ORIGINS` (comma-separated) | Extra browser origins allowed to call the API |

### `db`, `activeProject`

| Key | Default | Env | Purpose |
| --- | --- | --- | --- |
| `db.path` | `~/.orc/orc.db` | `ORC_DB_PATH` | SQLite file |
| `activeProject` | none | `ORC_ACTIVE_PROJECT` | Default project for CLI and MCP calls |

### `agent_loop`

The task loop picks up `todo` and `changes_requested` tasks and runs agents on them.

| Key | Default | Env |
| --- | --- | --- |
| `agent_loop.enabled` | `false` | `ORC_AGENT_LOOP_ENABLED` |
| `agent_loop.poll_interval_minutes` | `5` | `ORC_AGENT_LOOP_POLL_INTERVAL` |
| `agent_loop.max_workers` | `1` | `ORC_AGENT_LOOP_MAX_WORKERS` |
| `agent_loop.default_backend` | `claude` | `ORC_AGENT_LOOP_DEFAULT_BACKEND` |
| `agent_loop.session_idle_timeout_minutes` | `20` | `ORC_AGENT_LOOP_IDLE_TIMEOUT` |
| `agent_loop.session_max_lifetime_minutes` | `120` | `ORC_AGENT_LOOP_MAX_LIFETIME` |
| `agent_loop.worker_auto_approve` | `true` | `ORC_AGENT_LOOP_AUTO_APPROVE` |
| `agent_loop.default_flow` | `orc-default` | `ORC_AGENT_LOOP_DEFAULT_FLOW` |
| `agent_loop.review_flow` | `orc-review-only` | `ORC_AGENT_LOOP_REVIEW_FLOW` |
| `agent_loop.max_node_retries` | `2` | `ORC_AGENT_LOOP_MAX_NODE_RETRIES` |
| `agent_loop.max_flow_runs_per_task` | `6` | `ORC_AGENT_LOOP_MAX_FLOW_RUNS` |

Run `orc doctor` to see which backends are usable. See [Task flows](./task-flows.md).

### `runner` (jobs)

| Key | Default | Env |
| --- | --- | --- |
| `runner.default_timeout_secs` | `300` | `ORC_RUNNER_TIMEOUT` |
| `runner.max_concurrent_jobs` | `5` | `ORC_RUNNER_MAX_JOBS` |
| `runner.log_retention_days` | `30` | `ORC_RUNNER_LOG_DAYS` |

### `context`, `memory`

| Key | Default | Env | Purpose |
| --- | --- | --- | --- |
| `context.snapshot_max_bytes` | `2048` | `ORC_SNAPSHOT_MAX_BYTES` | Session snapshot budget |
| `context.layer1_task_limit` | `10` | `ORC_LAYER1_TASKS` | Tasks in the `context` result |
| `context.layer1_memory_limit` | `30` | `ORC_LAYER1_MEMORIES` | Memories in the `context` result |
| `memory.max_content_chars` | `800` | none | Longest memory content |

### `knowledge`

| Key | Default | Env |
| --- | --- | --- |
| `knowledge.root` | beside `db.path` | `ORC_KNOWLEDGE_ROOT` |
| `knowledge.parser` | `auto` | `ORC_KNOWLEDGE_PARSER` |
| `knowledge.embedding.provider` | `none` (`none`, `ollama`, `openai`) | `ORC_KNOWLEDGE_EMBEDDING_PROVIDER` |
| `knowledge.embedding.base_url` | provider default | `ORC_KNOWLEDGE_EMBEDDING_URL` |
| `knowledge.embedding.model` | provider default | `ORC_KNOWLEDGE_EMBEDDING_MODEL` |
| `knowledge.embedding.api_key` | none | `ORC_KNOWLEDGE_EMBEDDING_API_KEY` |
| `knowledge.max_upload_bytes` | `104857600` (100 MB) | none |

Most knowledge settings are also editable under **Settings → Knowledge**.

### `terminals`, `ssh`

| Key | Default | Env | Purpose |
| --- | --- | --- | --- |
| `terminals.enabled` | `true` | `ORC_TERMINALS_ENABLED` | Browser terminals |
| `terminals.max` | `8` | none | Concurrent terminals (1-64) |
| `terminals.shell` | unset | `ORC_TERMINALS_SHELL` | Shell to launch |
| `ssh.host` | none | `ORC_SSH_HOST` | `~/.ssh/config` host alias to run agents, terminals and git on |
| `ssh.remote_port` | none | `ORC_SSH_REMOTE_PORT` | Port the reverse tunnel opens on the SSH host so agents there reach ORC |

Pick the execution host from **Settings → Execution host**. Switching applies to new actions. When `ORC_SSH_HOST` is set, the selection is fixed.

### `rules`, `mcp`, `github`

| Key | Default | Env | Purpose |
| --- | --- | --- | --- |
| `rules.enabled` | `false` | `ORC_RULES_ENABLED` | Enforce [agent rules](./agent-rules.md) |
| `mcp.default_mode` | `meta` | none | MCP tool surface: `meta` or `full` |
| `github.token` | none | `ORC_GITHUB_TOKEN` | Token for ORC's GitHub calls (pull requests, reviews) |

### `gateway` (Telegram, Slack)

| Env | Effect |
| --- | --- |
| `ORC_TELEGRAM_TOKEN` | Enables the Telegram gateway with this bot token |
| `ORC_SLACK_BOT_TOKEN`, `ORC_SLACK_APP_TOKEN` | Enables the Slack gateway (Socket Mode) |

Channels are configured under **Settings → Channels**.

### `speech`, `tts`

| Env | Purpose |
| --- | --- |
| `ORC_SPEECH_PROVIDER` | `openai`, `groq` or `qwen` |
| `ORC_SPEECH_LANGUAGE` | Transcription language |
| `ORC_TTS_PROVIDER` | `openai` or `qwen` |
| `ORC_TTS_VOICE` | Voice (default `alloy`) |
| `ORC_TTS_MODE` | `voice_only` or `always` |
| `ORC_OPENAI_API_KEY`, `ORC_GROQ_API_KEY`, `ORC_QWEN_API_KEY` | Speech provider keys |

Setting any `ORC_SPEECH_*` or provider key enables speech; setting any `ORC_TTS_*` enables text-to-speech.

## Other environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORC_HOME` | `~/.orc` | Location of `daemon.pid` and `daemon.log` only. Config and database stay under `~/.orc`. |
| `ORC_API_BASE` | from `api.host`/`api.port` | ORC origin for the CLI, stdio MCP and hooks |
| `ORC_SESSION_ID` | none | Session attribution for MCP and CLI writes |
| `ORC_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ORC_LOG_DIR` | `~/.orc` | Parent of the `logs/` directory |
| `ORC_LOG_FILE` | on | `0` disables the log file |
| `ORC_WEB_DIST` | bundled | Serve a different dashboard build |
| `ORC_SQLITE_VEC_PATH` | bundled | sqlite-vec library for vector search |
| `AGENTAPI_URL` | `http://localhost:3284` | agentapi server for the `agentapi` backend |
| `ANTHROPIC_API_KEY` | none | `claude` backend |

## Ports

| Port | Serves |
| --- | --- |
| `7700` | REST API (`/api/*`), dashboard (`/`), MCP (`/mcp`), OpenAPI (`/openapi.json`), Swagger UI (`/docs`) |

Change it with `api.port`, `ORC_API_PORT` or `orc --port <n> daemon start`. The desktop app reads the same setting.

Health check (no auth needed):

```bash
curl -s http://127.0.0.1:7700/api/health
```

## Logs

`~/.orc/logs/orc.log` holds JSON lines. It rotates at 10 MB and keeps three rotated files (`orc.log.1` to `orc.log.3`). The terminal gets the same entries in readable form on stderr.

```bash
grep '"level":"error"' ~/.orc/logs/orc.log | tail -20
tail -f ~/.orc/logs/orc.log | jq .
orc --log-level debug daemon start
```

## Run as a background service

`orc daemon start` runs in the foreground. To start it at login and keep it running:

```bash
orc daemon install     # register and start now
orc daemon uninstall   # remove the registration
```

| Platform | Mechanism | Restarts on crash |
| --- | --- | --- |
| macOS | launchd agent `~/Library/LaunchAgents/com.orc.daemon.plist` | Yes |
| Linux | systemd user service `~/.config/systemd/user/orc-daemon.service` | Yes (on failure) |
| Windows | Registry Run key `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\OrcDaemon` | No |

No admin rights needed. Service output goes to `~/.orc/daemon.log` on macOS and Linux.

```bash
orc daemon stop                       # stop the running daemon
orc daemon status                     # list scheduled jobs and their last runs
orc status                            # API health and counts
launchctl list | grep orc             # macOS
systemctl --user status orc-daemon    # Linux
```

`orc daemon install` refuses an `orc` that lives under nvm, fnm, volta, asdf or nodenv paths. Install a [pre-built binary](./install.md#pre-built-binary), or pass `--force`.

`orc daemon start` merges your login shell's `PATH` on macOS and Linux, so agent CLIs such as `claude`, `codex` and `cursor-agent` are found when the daemon runs as a service.

If a daemon already answers on the port, the desktop app uses it instead of starting its own.

`orc api` starts only the API server, without the scheduler, watchers, gateway or task loop.

## Authentication

With no secret, ORC accepts every request. Keep `api.host` on `127.0.0.1` in that case.

Set a secret:

```bash
orc --secret "$(openssl rand -hex 32)" daemon start   # one run
```

or put it in `~/.orc/config.json` as `api.secret`, or set `ORC_API_SECRET`. The desktop app generates and saves one for you.

| Client | How it authenticates |
| --- | --- |
| CLI, stdio MCP on the same machine | Reads the secret from config or `ORC_API_SECRET` |
| HTTP clients, HTTP MCP | `Authorization: Bearer <secret or access token>` |
| Dashboard | Asks for the secret once and stores a signed HttpOnly cookie for `api.session_days` |
| Desktop app | Sends the secret it configured |

Unauthenticated paths: `/health`, `/api/health`, `/api/auth/session`, `/api/auth/token`. Handoff upload, session-sync, skill download and scratchpad content URLs skip the secret but check their own signed, expiring link.

### Access tokens

An access token is a signed bearer credential that expires. Use one instead of the raw secret for agents and scripts.

Create one under **Settings → Security**, or:

```bash
curl -s -X POST http://127.0.0.1:7700/api/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"secret":"'"$ORC_API_SECRET"'"}'
```

Returns `{"token": "...", "expires_at": <unix seconds>}`. Pass `expires_at` (unix seconds) to choose the expiry, up to 365 days. Rotating the secret revokes every token.

For exposing ORC beyond localhost, see [Self-hosting](./self-hosted.md).
