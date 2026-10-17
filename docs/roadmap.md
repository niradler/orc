# Roadmap

## What Shipped

### v0.0.1 - Foundation

- SQLite core: tasks, memories, jobs, sessions, skills, projects
- REST API with auto-generated OpenAPI spec + typed SDK + CLI
- MCP server with memory, task, job, context, and session tools
- Job executor with streaming logs and exit codes
- Hook scripts for Claude Code session continuity

### v0.0.2 - Multi-Agent & Daemon

- Dual FTS5 search: Porter + Trigram with 3-layer cascade
- Priority-tiered session snapshots (P1/P2/P3, budget-trimmed to 2KB)
- Session event dedup + FIFO eviction
- `orc daemon` with cron scheduler + file-watch triggers
- Multi-agent hook configs: Claude Code, Cursor, Codex

### v0.0.3 - Projects & CRUD

- Projects as organizing hub with `project_id` FK on tasks, memories, jobs
- Readable project names everywhere (MCP tools accept `project: "name"`)
- Full CRUD across CLI, MCP, and API for all resources
- Gateway: Telegram + Slack bridge with agent sessions, HITL review cards, voice

### v0.1.x - Agent Orchestration

- **Task loop** - event-driven orchestrator that polls for queued tasks, spawns worker agents, manages concurrency, handles session resume on feedback
- **Task service layer** - shared status transition engine with side-effects (notifications, unblocking, comment creation) used by both MCP and runner
- **Agent runtime registry** - pluggable backend system extracted to `packages/agent-runtime`
- **Three agent backends**: Claude Code (native CLI), ACPX (14+ agents via ACP protocol), A2A (remote agents via Google Agent2Agent JSON-RPC)
- **Fallback routing** - unknown backend names route through ACPX automatically
- **Filesystem-based skills** - `skills/*/SKILL.md` (built-in) and `~/.orc/skills/` (user), discoverable via `skill_list`/`skill_read`/`skill_create` MCP tools
- **Built-in workflow skills** - orc-coder, orc-reviewer, orc-planner, orc-bugfix, orc-requirements, orc-report, orc-worker-base, orc-main-base
- **Review flow** - configurable `required_review`, `max_review_rounds` with auto-pause on exceeded rounds
- **Task flows** - per-task graphs replacing the hardcoded worker/reviewer pipeline: conditional edges, bounded loops, parallel fan-out with `all`/`any` joins, human gates, and a durable per-node ledger. Deterministic engine (`@orc/core/flow-engine`) with five independent termination rails; six built-in flows; user flows in `~/.orc/flows/` and inline per-task graphs. See [Task Flows](./task-flows.md)
- **Per-project concurrency** - `max_workers` on projects to limit parallel agents
- **Polymorphic comments** - `task_update` with `comment` param writes to shared comments table
- **Skill installation** - `npx skills add niradler/orc` for agent skill distribution
- **Web dashboard** - React SPA (Vite + Tailwind + shadcn + React Query) covering tasks, jobs, memories, projects, sessions, knowledge, skills, and chat
- **Single-binary deployment** - CLI build bundles the prebuilt dashboard into `packages/cli/dist/web/`; `orc daemon start` serves the API at `/api/*` and the web UI at `/` from one process
- **TUI removed** - all features migrated to the web dashboard; `@orc/tui` package and `orc tui` command deleted

### Memories redesign

- **Memories work like skills, per project** - identity `(project, name)`, a description that says when the memory matters, content capped at 800 characters by default (longer guidance belongs in a skill), and an optional priority 0-100
- **`context` loads the top 30 memories by priority**; agents read the relevant ones with `memory_read`
- **MCP tools** - `memory_list`, `memory_read`, `memory_create`, `memory_update`, `memory_delete`, `memory_history`, `memory_revert`
- **History and revert** - every change keeps before/after snapshots, reason, author and native session id
- **Read counts per client** (mcp, cli, api, ui) rank memories in lists

### v0.1.x - Standalone Binary & Daemon

- **Embedded web assets** - standalone binaries include all web dashboard files via Bun's `import ... with { type: "file" }` embedding; GH release downloads are a single file, no `dist/web/` directory needed
- **`orc daemon install/uninstall`** - cross-platform auto-start registration (Windows registry Run key, macOS launchd, Linux systemd user service); no admin/root privileges required
- **`@tobilu/qmd` moved to optionalDependencies** - fixes deprecated `prebuild-install` warning; code already lazy-loads it
- **352 automated tests** across 24 test files

## What's Next

### Short Term

- Task checklist items with auto-transition to review when all checked
- MCP tools for task notes and task links (currently API-only)
- SDK `project` param support (currently uses `project_id` internally)
- End-to-end cross-agent validation (task/memory/session roundtrip across agents)

### Medium Term

- Vector search with `sqlite-vec` for semantic memory retrieval
- Permission approval flow - agent pauses at a decision point, human approves
- Webhook trigger setup with examples (GitHub, CI)
- Skill versioning and management improvements
- Discord bridge

### Long Term

- Plugin system for custom adapters and integrations
- Multi-user support with role-based permissions
- Obsidian vault sync for memory
