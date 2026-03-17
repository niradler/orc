# Roadmap

## What Shipped

### v0.0.1 — Foundation

- SQLite core: tasks, memories, jobs, sessions, prompts, projects
- REST API + SDK + CLI — all commands working end-to-end
- MCP server with 25 tools (memory, task, job, context, session)
- Job executor with streaming logs and exit codes
- Hook scripts for Claude Code session continuity

### v0.0.2 — Multi-Agent & Daemon

- Dual FTS5 search: Porter + Trigram with 3-layer cascade
- Memory types (`fact | decision | event | rule | discovery`) with importance-weighted scoring
- Priority-tiered session snapshots (P1/P2/P3, budget-trimmed to 2KB)
- Session event dedup + FIFO eviction
- `orc daemon` with cron scheduler + file-watch triggers
- Multi-agent hook configs: Claude Code, Cursor, Codex
- 67+ automated tests

### v0.0.3 — Projects & CRUD

- Projects as organizing hub with `project_id` FK on tasks, memories, jobs
- Readable project names everywhere (MCP tools accept `project: "name"`)
- `task_delegate` for agent-to-agent handoff
- Full CRUD across CLI, MCP, and API for all resources
- Terminal UI (TUI) with vim-style navigation
- Gateway: Telegram + Slack bridge with agent sessions, HITL review cards, voice

## What's Next

### Short Term

- MCP tools for task notes and task links (currently API-only)
- MCP tool for prompt rendering
- SDK `project` param support (currently uses `project_id` internally)
- End-to-end cross-agent validation (task/memory/session roundtrip across Claude Code, Cursor, Codex)

### Medium Term

- Permission approval flow — agent pauses at a decision point, human approves via Telegram or CLI
- Obsidian vault sync — notes as a memory source
- Vector search with `sqlite-vec` for semantic memory retrieval
- TUI polish as a primary interface
- Webhook trigger setup with examples (GitHub, CI)

### Long Term

- Web viewer / dashboard
- Discord bridge
- Plugin system for custom adapters
- Multi-user support
