# Quick start

Your first five minutes with ORC: start it, create a project, add a task and a memory, open the dashboard and connect a coding agent.

Install ORC first: [Install](./install.md).

## 1. Start ORC

Desktop app: launch it. The daemon starts and the dashboard opens. Skip to step 2.

CLI install:

```bash
orc daemon start
```

This runs in the foreground: the REST API and dashboard on `http://127.0.0.1:7700`, the job scheduler, session watchers, the gateway and the task loop. Leave it running and use a second terminal, or register it as a service with `orc daemon install`.

Check it:

```bash
orc status
```

The database is created on first run at `~/.orc/orc.db`.

## 2. Create a project

```bash
orc project add my-app -d "My application"
orc project use my-app
```

The first project you add becomes the active project. Task, memory, job and knowledge commands default to the active project. Override with `-p <name>`.

## 3. Add a task

```bash
orc task add "Fix the auth bug" --priority high
orc task list
```

Priorities: `low`, `normal`, `high`, `critical`. Tasks move through `todo → queued → doing → review → done`.

To have an agent pick tasks up automatically, enable the task loop (off by default):

```bash
ORC_AGENT_LOOP_ENABLED=true orc daemon start
```

Check which agents can run on this machine:

```bash
orc doctor
```

See [Task flows](./task-flows.md) for what happens after a task is picked up.

## 4. Add a memory

Memories are short project facts that agents load into context at session start.

```bash
orc mem add token-refresh-lock \
  -d "Check before touching token refresh" \
  -c "Use RWMutex for token refresh" \
  --priority 60
orc mem list
```

`-d` (description) and `-c` (content) are required. `--priority` is 0-100; higher loads first. Longer procedures belong in a [skill](./skills.md).

## 5. Add a job (optional)

```bash
orc job add nightly --command "bun run test" --trigger cron --cron "0 22 * * *" --enable
orc job run nightly --wait
```

New jobs are disabled unless you pass `--enable`.

## 6. Open the dashboard

Open [http://localhost:7700](http://localhost:7700). The desktop app shows the same dashboard in its window.

If an API secret is configured, the dashboard asks for it once and keeps a signed session cookie (30 days by default).

Tour of every page: [Desktop app and web dashboard](./desktop-and-web.md).

## 7. Connect an agent

Register ORC's MCP server in your agent. For Claude Code:

```bash
claude mcp add --transport http orc http://127.0.0.1:7700/mcp
```

With an API secret, add `--header 'Authorization: Bearer ${ORC_API_SECRET}'` and export `ORC_API_SECRET` in the agent's environment.

The dashboard builds this snippet for Claude Code, Codex and other clients under **Settings → MCP**.

Then ask the agent to call ORC's `context` tool for `my-app`. It should return your task and memory.

Claude Code and Codex sessions appear under **Sessions** without further setup.

Full instructions per agent: [Connect agents](./connect-agents.md).

## Next

- [Concepts](./concepts.md)
- [CLI reference](./cli.md)
- [Configuration](./configuration.md)
- [Usage guide](./usage-guide.md)
