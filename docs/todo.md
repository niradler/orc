# ORC Improvement Tracker

## Completed (PR #2 — feature/project-management)

### Core features
- [x] **Projects as organizing hub** — `project_id` FK on tasks, memories, jobs. CLI `orc project` command with add/use/show/list/update/archive
- [x] **Readable project names everywhere** — MCP tools accept `project: "name"` instead of `project_id: "ULID"`. Auto-resolves from `activeProject` in config
- [x] **project_create + project_update MCP tools** — agents can manage projects without CLI
- [x] **context() shows project header** — `## Project: <name>` when scoped
- [x] **task_delegate MCP tool** — any-agent-to-any-agent delegation (Claude→Claude, Claude→Codex, etc.) with optional job trigger

### Code review fixes
- [x] **By-name lookup** — uses `COLLATE NOCASE` instead of full table scan
- [x] **DB-level filtering** — job_list and context push project_id filter to SQL (was in-memory, truncating results)
- [x] **UpdateProjectSchema** — regex/length parity with CreateProjectSchema
- [x] **SDK type cleanup** — removed phantom fields (coordination_mode, working_agreement, etc.) not in DB schema

### Documentation
- [x] **README** — project-oriented rewrite, 25 MCP tools with name-based params
- [x] **Task links** — documented in README (blocks, subtask_of, etc.)
- [x] **Task notes** — documented in README (collaboration trail, note kinds)
- [x] **Prompt templates** — documented in README (versioning, skill mode, rendering)
- [x] **Voice integration** — documented in README (STT/TTS, providers)
- [x] **Terminal UI** — documented in README (WIP status, components)
- [x] **Webhook triggers** — documented in Jobs section of README
- [x] **Project dashboard** — documented in Project Management section
- [x] **AGENTS.md** — updated to 25 tools, name-based project params
- [x] **All 5 skills updated** — orc-agent-protocol, orc-task-workflow, orc-memory-knowledge, orc-collab-gateway, orc-dev-contributing

## Future improvements

- [ ] Add MCP tools for task notes (currently API-only, no MCP tool)
- [ ] Add MCP tools for task links (currently API-only, no MCP tool)
- [ ] Add MCP tool for prompt rendering
- [ ] `orc project show` in TUI dashboard
- [ ] Webhook trigger setup documentation with examples (GitHub, CI)
- [ ] End-to-end multi-agent delegation example (Claude→Claude with job trigger)
- [ ] SDK `project` param support (currently SDK still uses `project_id` internally)
