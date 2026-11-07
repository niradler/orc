# Install

How to install ORC as a desktop app, a standalone binary, an npm package, a Docker container or from source, and how to upgrade each.

| Method | Best for | Needs |
| --- | --- | --- |
| [Desktop app](#desktop-app) | Your own machine | Nothing |
| [Pre-built binary](#pre-built-binary) | Servers, CI, headless machines | Nothing |
| [npm](#npm) | Machines that already have Bun | Bun >= 1.4.4 |
| [Docker](#docker) | Containers, shared hosts | Docker |
| [From source](#from-source) | Contributors | Bun >= 1.4.4, git |

## Desktop app

The recommended install. Download the installer for your machine from [GitHub Releases](https://github.com/niradler/orc/releases/latest).

| OS | Installer |
| --- | --- |
| macOS (Apple Silicon) | `orc-<version>-mac-arm64.dmg` |
| Windows (x64) | `orc-<version>-win-x64.exe` |
| Linux (x64) | `orc-<version>-linux-x86_64.AppImage` |
| Linux (ARM64) | `orc-<version>-linux-arm64.AppImage` |

There is no Intel macOS installer. On an Intel Mac, use the `orc-mac-x64` [binary](#pre-built-binary).

On Linux, make the AppImage executable before running it:

```bash
chmod +x orc-*-linux-*.AppImage
./orc-*-linux-*.AppImage
```

::: warning Unsigned builds
On macOS, right-click the app and choose **Open** the first time. On Windows, choose **More info**, then **Run anyway**.
:::

### What the app sets up

On launch the app:

| Step | Detail |
| --- | --- |
| Starts the daemon | Reuses a daemon already healthy on the configured port (`api.port`, default `7700`), otherwise starts the bundled `orc` binary. Only a daemon the app started is stopped when the app quits. |
| Sets an API secret | When no secret is configured and the app starts the daemon, it generates one, saves it as `api.secret` in `~/.orc/config.json` and sends it on every dashboard request. |
| Installs the CLI | Copies `orc` to `~/.orc/bin` (`orc.exe` on Windows). Re-copied when the app version changes. |
| Adds the CLI to `PATH` | zsh: `~/.zshenv`. bash: `~/.bash_profile` (and `~/.bashrc` if present) on macOS, `~/.bashrc` (and `~/.profile` if present) on Linux. fish: `~/.config/fish/conf.d/orc.fish`. Windows: the user `PATH`. Open a new terminal afterwards. |
| Starts at login | Enabled on first run, started hidden. Toggle it from the tray menu. |
| Adds a tray icon | **Open orc**, **Start at login**, **Quit orc**. |

Daemon output goes to `~/.orc/desktop-daemon.log`.

Verify the CLI from a new terminal:

```bash
orc status
```

See [Desktop app and web dashboard](./desktop-and-web.md) for the app tour.

## Pre-built binary

Single-file binaries with the web dashboard embedded. No runtime needed.

```bash
# macOS (Apple Silicon)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-mac-arm64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# macOS (Intel)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-mac-x64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# Linux (x64)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-linux-x64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc

# Linux (ARM64)
curl -L https://github.com/niradler/orc/releases/latest/download/orc-linux-arm64 -o /usr/local/bin/orc && chmod +x /usr/local/bin/orc
```

Windows: download `orc-windows-x64.exe` from the [release page](https://github.com/niradler/orc/releases/latest), rename it to `orc.exe` and put it on your `PATH`.

Each release also publishes `checksums.txt`.

Then start the daemon (foreground) or register it as a service:

```bash
orc daemon start      # foreground
orc daemon install    # start now and at every login
```

See [Configuration](./configuration.md#run-as-a-background-service).

## npm

Needs [Bun](https://bun.sh) >= 1.4.4 on `PATH`.

```bash
npm install -g orc-ai
orc daemon start
```

::: tip
`orc daemon install` refuses to register a service when `orc` lives under a per-shell Node path (nvm, fnm, volta, asdf, nodenv), because that path can disappear. Use a [pre-built binary](#pre-built-binary) for a background service.
:::

## Docker

Published image: `niradler/orc` (`latest` and one tag per version, `linux/amd64` and `linux/arm64`).

```bash
docker run -d --name orc \
  -p 127.0.0.1:7700:7700 \
  -v orc-data:/data \
  -v orc-home:/home/bun \
  -e ORC_API_SECRET=$(openssl rand -hex 32) \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  niradler/orc:latest
```

Or, from a clone of the repository, with the bundled [`docker-compose.yml`](https://github.com/niradler/orc/blob/master/docker-compose.yml):

```bash
docker compose up -d
```

| Item | Value |
| --- | --- |
| Port | `7700`, bound to `0.0.0.0` inside the container |
| Database, config, logs | `/home/bun/.orc/` (persist `/home/bun` as a volume) |
| `/data` | `ORC_HOME`: daemon PID file |
| Health check | `GET /api/health` every 30 s |
| Bundled agent CLIs | Node, ACPX, Claude Code, Codex (versions pinned in the `Dockerfile`) |
| Default backend | `claude` (Anthropic SDK) |

::: warning Set a secret before exposing the port
Without `ORC_API_SECRET` every endpoint is open, including job execution, which runs shell commands. Keep the port on `127.0.0.1` or set a strong secret.
:::

Agent credentials are not included:

| Agent | Provide |
| --- | --- |
| `claude` | `ANTHROPIC_API_KEY` |
| `codex-cli` | `OPENAI_API_KEY` or a Codex login inside the container |
| ACPX agents | Whatever the launched agent requires |

Mount your repositories into the container and use the container path as the project folder.

### Compose environment

`docker-compose.yml` reads these from your shell or a `.env` file:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude backend |
| `OPENAI_API_KEY` | Codex backend |
| `ORC_API_SECRET` | API bearer secret |
| `ORC_TELEGRAM_TOKEN` | Telegram gateway |
| `ORC_AGENT_LOOP_DEFAULT_BACKEND` | Default backend (default `claude`) |
| `AGENTAPI_URL` | agentapi server (default `http://host.docker.internal:3284`) |
| `ORC_SSH_HOST` | `~/.ssh/config` host alias to run agents, terminals and git on |

Compose mounts `~/.ssh` read-only and copies it into the container with safe permissions.

### Run agents on the host instead

Set `ORC_AGENT_LOOP_DEFAULT_BACKEND=agentapi` and run [coder/agentapi](https://github.com/coder/agentapi) on the host, wired back to ORC over MCP:

```bash
agentapi server --allowed-hosts '*' -- \
  claude --allowedTools all \
         --mcp-config '{"mcpServers":{"orc":{"type":"http","url":"http://localhost:7700/mcp"}}}'
```

For running ORC on a shared server, see [Self-hosting](./self-hosted.md).

## From source

```bash
git clone https://github.com/niradler/orc
cd orc
bun install
bun run build
```

Run the CLI from the checkout:

```bash
bun packages/cli/src/index.ts daemon start
```

Build standalone binaries into `packages/cli/dist/`:

```bash
bun run --filter orc-ai build:bin
```

Build the desktop app (needs Bun >= 1.4.2 first on `PATH`):

```bash
bun run --filter @orc/desktop dist        # installer for this machine -> packages/desktop/release
bun run --filter @orc/desktop dev         # run the app from source
```

## Upgrading

To start using Windows or Linux automatic desktop updates, manually install a build that contains the updater once. Earlier desktop builds cannot update themselves into this feature.

Database migrations run automatically when ORC opens the database. Back up `~/.orc/orc.db` first if you want a rollback point.

| Method | Upgrade |
| --- | --- |
| Desktop app | Installed Windows and Linux apps check for updates on their own. **Settings → About** shows the channel and **Restart to update** after the download. You can still quit from the tray (**Quit orc**) and install the new installer over the old one. The app replaces `~/.orc/bin/orc` on first launch. Automatic updates are not offered on macOS yet; install the new disk image manually. |
| Binary | Re-run the `curl` command, then restart the daemon (`orc daemon stop`, then start it again or let the service restart it). |
| npm | `npm install -g orc-ai@latest`, then restart the daemon. |
| Docker | `docker pull niradler/orc:latest` and recreate the container, or `docker compose pull && docker compose up -d`. |
| Source | `git pull`, `bun install`, `bun run build`. |

From the dashboard, **Settings → Server → Restart ORC server** restarts the running server without losing settings. It closes active terminals.

Check the running version:

```bash
orc --version
curl -s http://127.0.0.1:7700/api/health
```
