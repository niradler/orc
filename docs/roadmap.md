# Roadmap

## What Shipped

### v0.0.1 — Foundation

- SQLite core: tasks, memories, jobs, sessions, prompts, projects
- REST API with auto-generated OpenAPI spec + typed SDK + CLI
- MCP server with memory, task, job, context, and session tools
- Job executor with streaming logs and exit codes
- Hook scripts for Claude Code session continuity

### v0.0.2 — Multi-Agent & Daemon

- Dual FTS5 search: Porter + Trigram with 3-layer cascade
- Memory types (`fact | decision | event | rule | discovery`) with importance-weighted scoring
- Priority-tiered session snapshots (P1/P2/P3, budget-trimmed to 2KB)
- Session event dedup + FIFO eviction
- `orc daemon` with cron scheduler + file-watch triggers
- Multi-agent hook configs: Claude Code, Cursor, Codex

### v0.0.3 — Projects & CRUD

- Projects as organizing hub with `project_id` FK on tasks, memories, jobs
- Readable project names everywhere (MCP tools accept `project: "name"`)
- Full CRUD across CLI, MCP, and API for all resources
- Terminal UI (TUI) with vim-style navigation
- Gateway: Telegram + Slack bridge with agent sessions, HITL review cards, voice

### v0.1.x — Agent Orchestration

- **Task loop** — event-driven orchestrator that polls for queued tasks, spawns worker agents, manages concurrency, handles session resume on feedback
- **Task service layer** — shared status transition engine with side-effects (notifications, unblocking, comment creation) used by both MCP and runner
- **Agent runtime registry** — pluggable backend system extracted to `packages/agent-runtime`
- **Three agent backends**: Claude Code (native CLI), ACPX (14+ agents via ACP protocol), A2A (remote agents via Google Agent2Agent JSON-RPC)
- **Fallback routing** — unknown backend names route through ACPX automatically
- **Prompt-as-skills system** — `SKILL.md` files with reference docs, seeded on startup, discoverable via `prompt_list`/`prompt_get` MCP tools
- **Built-in workflow prompts** — orc-coder, orc-reviewer, orc-planner, orc-bugfix, orc-requirements, orc-report, orc-worker-base, orc-main-base
- **Review flow** — configurable `required_review`, `max_review_rounds` with auto-pause on exceeded rounds
- **Per-project concurrency** — `max_workers` on projects to limit parallel agents
- **Polymorphic comments** — `task_update` with `comment` param writes to shared comments table
- **Skill installation** — `npx skills add niradler/orc` for agent skill distribution
- **TUI polish** — improved navigation, layout, and keybindings
- **91+ automated tests**

### v0.1.x — Memory System Improvements

- **`memory_update` MCP tool** — partial update by ID, preserves created_at and access_count history, FTS auto-re-indexes
- **Source auto-detection** — `source` field auto-populated from agent env (`ORC_AGENT`, `CLAUDE_MODEL`, `ORC_SESSION_ID`), overridable
- **Similarity hint on store** — warns when a near-duplicate memory exists, guides agent to update instead of duplicate
- **Access-count scoring boost** — frequently-accessed memories get up to +2 points in `context()` scoring
- **Title in search results** — `memory_search` Layer 1 now shows title for agent-driven selection
- **Source in memory_get output** — full content view includes source metadata
- **Updated orc-knowledge skill** — guidance on what NOT to store, content size limits, title-as-description pattern, update-vs-delete convention
- **API PATCH /memories/:id** — REST endpoint for partial memory updates
- **SDK + CLI support** — `memories.update()` in SDK, `orc mem edit` in CLI
- **326 tests** (10 new covering update, source, similarity, scoring)

## What's Next

### Short Term

- Task checklist items with auto-transition to review when all checked
- MCP tools for task notes and task links (currently API-only)
- SDK `project` param support (currently uses `project_id` internally)
- End-to-end cross-agent validation (task/memory/session roundtrip across agents)
- Memory cleanup/GC — auto-archive old low-access memories to keep FTS index lean

### Medium Term

- Web dashboard for task board and memory browsing
- Vector search with `sqlite-vec` for semantic memory retrieval
- Permission approval flow — agent pauses at a decision point, human approves
- Webhook trigger setup with examples (GitHub, CI)
- Prompt versioning and management improvements
- Discord bridge
- Push memory scoring into SQL — `context()` currently fetches N×3 into JS for scoring; at thousands of memories this should be a single SQL query with ORDER BY score
- Memory versioning — track previous content on update for undo/audit (investigate SQLite triggers or shadow table)

### Long Term

- Plugin system for custom adapters and integrations
- Multi-user support with role-based permissions
- Obsidian vault sync for memory
