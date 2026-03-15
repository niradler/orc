# ORC Improvement Tracker

## Completed (PR #2 — feature/project-management)

- [x] **Agent onboarding friction** — MCP tools now accept `project: "name"` (readable) instead of `project_id: "ULID"`. Auto-resolves from `activeProject` in config when omitted.
- [x] **No MCP tool to create/manage projects** — Added `project_create` and `project_update` MCP tools. Agents can fully manage projects without CLI.
- [x] **context() doesn't say which project** — Now shows `## Project: <name>` header when scoped to a project.
- [x] **Multi-agent delegation** — Added `task_delegate` MCP tool. Creates task + optionally triggers a job to launch another agent. Works for any delegation: Claude→Claude, Claude→Codex, Cursor→Claude, etc.

## Remaining — undocumented capabilities

These features exist in the codebase but are not documented in the README or skills:

### Task links (`blocks`, `subtask_of`, etc.)
- Tables: `task_links` in schema.ts
- API: `/tasks/{id}/links` routes exist
- CLI: `orc task link` command exists
- **What to document**: link types (blocks, blocked_by, relates_to, duplicates, clones, subtask_of, parent_of), how agents should use them for dependency tracking

### Task notes/threads
- Table: `task_notes` in schema.ts
- API: `/tasks/{id}/notes` routes exist
- **What to document**: how notes create a collaboration trail between agents and humans, note kinds (comment, checkpoint, handoff, review, claim, system)

### Prompt/skill templates
- Table: `prompts` in schema.ts
- API: `/prompts` routes exist
- CLI: `orc prompt` command exists
- **What to document**: storing reusable prompt templates in DB, versioning, rendering with variables, skill_dir/skill_version fields

### Webhook job triggers
- Schema supports `trigger_type: "webhook"`
- API: webhook trigger endpoint
- **What to document**: how to set up a webhook-triggered job, use cases (GitHub webhooks, CI callbacks)

### Voice integration (Telegram)
- Gateway supports speech-to-text and TTS
- Config: `speech` and `tts` sections in config schema
- Providers: OpenAI, Groq, Qwen
- **What to document**: setup, provider configuration, voice-only mode vs always mode

### Terminal UI (TUI)
- Package: `packages/tui/`
- Components: TaskBoard, JobMonitor, MemBrowser, Dashboard
- **What to document**: `orc tui` command, what each panel shows, current status (WIP)

### `orc project show` dashboard
- Shows task counts by status, memory count, job count
- Color-coded task grouping in `orc task list`
- **What to document**: project dashboard CLI usage, status grouping
