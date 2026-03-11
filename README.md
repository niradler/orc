# orc — Human + AI Orchestration Hub

> One binary. Persistent memory · Task management with HITL review ·
> Generic job runner · Prompt/skill library · Telegram bridge · MCP server.
> The shared brain for Claude Code, Cursor, Codex, Gemini CLI — and you.

---

## Packages

| Package | Description |
|---|---|
| [`@orc/core`](packages/core) | Shared types, config system (Zod), logger, ULID IDs |
| [`@orc/db`](packages/db) | SQLite schema (Drizzle ORM), migrations, client |
| [`@orc/api`](packages/api) | Hono REST API with auto-generated OpenAPI spec |
| [`@orc/sdk`](packages/sdk) | Type-safe HTTP client for the API |
| [`@orc/cli`](packages/cli) | Commander CLI using the SDK (`orc` binary) |
| [`@orc/mcp`](packages/mcp) | MCP server for Claude Code, Cursor, Codex, Gemini CLI |
| [`@orc/runner`](packages/runner) | Job executor + cron/repeat/watch scheduler |
| [`@orc/bridge`](packages/bridge) | Telegram IM bridge with HITL approval flows |

Each package is independently usable. The CLI imports the SDK; the SDK calls the API; the API talks to the DB. Every layer can be used standalone.

---

## Quick Start

```bash
# Install dependencies
bun install

# Run DB migrations (creates ~/.orc/orc.db)
bun db:push

# Start API server
bun orc api

# In another terminal — use the CLI
bun orc task list
bun orc task add "Fix the auth bug" --priority high
bun orc mem add "use RWMutex for token refresh" --scope api
bun orc job add nightly --command "echo hello" --cron "0 22 * * *"
bun orc status
```

---

## Architecture

```
orc/
├── packages/
│   ├── core/        @orc/core    — config, types, logger, IDs
│   ├── db/          @orc/db      — Drizzle schema + SQLite client
│   ├── api/         @orc/api     — Hono REST API + OpenAPI spec
│   ├── sdk/         @orc/sdk     — typed HTTP client
│   ├── cli/         @orc/cli     — commander CLI (uses SDK)
│   ├── mcp/         @orc/mcp     — MCP server (tools for agents)
│   ├── runner/      @orc/runner  — job executor + scheduler
│   └── bridge/      @orc/bridge  — Telegram HITL bridge
├── package.json     — Bun workspaces root
├── tsconfig.json    — strict TypeScript base
└── biome.json       — linting + formatting
```

### Data Flow

```
Agent (Claude/Cursor/Codex)
       │
       ▼ MCP (stdio / HTTP)
  @orc/mcp  ─────────────────────────────┐
                                          │
  @orc/cli  ──── @orc/sdk ──── @orc/api ─┤
                                          │
  @orc/runner (cron/watch/webhook) ───────┤
                                          │
  @orc/bridge (Telegram) ────────────────┘
                                          │
                                          ▼
                                    SQLite (~/.orc/orc.db)
                                    @orc/db (Drizzle ORM)
```

---

## OpenAPI → SDK → CLI Flow

1. **API generates spec** at `/openapi.json` using `@hono/zod-openapi`
2. **Generate full SDK types** from the running API:
   ```bash
   bun sdk:generate   # requires API running on :7700
   ```
3. **CLI uses SDK** for all API calls — fully typed end-to-end

---

## Configuration

Config is loaded in priority order (later wins):

1. `~/.orc/config.json` — user global
2. `./.orc/config.json` — project local
3. Environment variables (see below)

```json
{
  "db": { "path": "~/.orc/orc.db" },
  "api": { "port": 7700, "host": "127.0.0.1", "secret": "optional-bearer-token" },
  "mcp": { "transport": "stdio" },
  "embed": {
    "provider": "ollama",
    "ollama_url": "http://localhost:11434",
    "ollama_model": "nomic-embed-text"
  },
  "bridge": {
    "telegram": {
      "enabled": true,
      "token": "BOT_TOKEN",
      "authorized_users": [123456789],
      "mode": "agent:claude"
    }
  }
}
```

**Environment variables:**

| Variable | Description |
|---|---|
| `ORC_DB_PATH` | SQLite database path |
| `ORC_API_PORT` | API port (default: 7700) |
| `ORC_API_SECRET` | Bearer token for API auth |
| `ORC_TELEGRAM_TOKEN` | Telegram bot token |
| `OPENAI_API_KEY` | OpenAI API key (for embeddings) |
| `ORC_LOG_LEVEL` | Log level: debug/info/warn/error |

---

## MCP Setup

Add to your agent's MCP config:

```json
{
  "mcpServers": {
    "orc": {
      "command": "bun",
      "args": ["run", "/path/to/orc/packages/mcp/src/index.ts"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|---|---|
| `memory_search` | Hybrid search: BM25 + semantic |
| `memory_store` | Store a fact/decision for future retrieval |
| `memory_get` | Fetch specific memories by ID |
| `task_list` | List active tasks (compact index) |
| `task_create` | Create a task |
| `task_update` | Update task status/priority |
| `task_submit_for_review` | Trigger HITL review checkpoint |
| `task_check_review` | Poll review result (approved/changes) |
| `job_list` | List jobs with last run status |
| `job_run` | Trigger a job by name |
| `job_status` | Get run status |
| `context_layer1` | Compact context: active tasks + recent memory |
| `session_log` | Log session summary for agent continuity |

---

## Scripts

```bash
bun install          # install all workspace deps
bun dev              # start API server in dev mode
bun typecheck        # typecheck all packages
bun lint             # lint all packages
bun format           # format all packages
bun db:generate      # generate Drizzle migrations
bun db:push          # push schema to DB (dev)
bun db:studio        # Drizzle Studio GUI
bun sdk:generate     # generate SDK types from running API
bun test             # run all tests
bun build            # build all packages
```

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Bun | Single binary, native SQLite, fast |
| Language | TypeScript strict | End-to-end type safety |
| API | Hono + @hono/zod-openapi | Auto OpenAPI spec from Zod schemas |
| Database | bun:sqlite + Drizzle ORM | Zero overhead, typed schema |
| CLI | commander | Lightweight, typed |
| MCP | @modelcontextprotocol/sdk | Official Anthropic SDK |
| Telegram | Grammy | Modern TS-first bot framework |
| Scheduler | croner | In-process cron, no OS deps |
| File watching | chokidar | Cross-platform, reliable |
| Linting | Biome | Fast, opinionated, one tool |

---

## Roadmap

- **Phase 1 (current)** — Core data model, API, CLI, MCP ✓ bootstrapped
- **Phase 2** — Cron/repeat/watch triggers, SKILL.md loader, prompt templates
- **Phase 3** — sqlite-vec embeddings, hybrid BM25+vector search, session hooks
- **Phase 4** — Telegram bridge HITL flows, streaming, permission approvals
- **Phase 5** — Discord adapter, Obsidian vault sync, TUI (OpenTUI + React)
