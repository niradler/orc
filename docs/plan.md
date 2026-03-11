# SIDEKICK — Design Document v3

### Local-First AI Collaboration Hub · Human + Multi-Agent

> **`sk`** — One Go binary. The connective tissue between you, your agents, and your IM.
> Persistent memory · Generic job runner · Skill library · Telegram/Discord bridge ·
> MCP server · Session continuity hooks. Agnostic. Local. Yours.

---

## What v3 Adds

The Claude-to-IM-skill and Claude-to-IM library reveal the right model for
the Telegram integration. It's not a notification sender — it's a **bidirectional
IM bridge** with:

- Full conversation forwarding to any agent runtime
- Streaming response previews in the chat
- **Permission approval via inline buttons** (allow / deny / allow-for-session)
- Platform-native markdown rendering
- Session binding per chat
- Rate limiting, deduplication, retry

And — critically — `sk`'s **skill format should be 100% compatible** with the
standard SKILL.md format used by Claude Code, Codex, Gemini CLI, and OpenCode.
Skills installed for `sk` work in Claude Code and vice versa.

---

## The Full Picture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           sk binary                                  │
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  ┌────────────┐  │
│  │  job runner │  │   memory     │  │  prompts  │  │  IM bridge │  │
│  │  (generic)  │  │  + hybrid    │  │  + skills │  │ (bidirec.) │  │
│  │  scheduler  │  │   search     │  │   SKILL.md│  │            │  │
│  └──────┬──────┘  └──────┬───────┘  └─────┬─────┘  └──────┬─────┘  │
│         └────────────────┴────────────────┴───────────────┘        │
│                                    │                                 │
│                     ┌──────────────┴──────────────┐                 │
│                     │      SQLite (single file)    │                 │
│                     │   FTS5 · sqlite-vec · jobs   │                 │
│                     └─────────────────────────────┘                 │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  MCP Server  (stdio / HTTP)                                  │   │
│  │  memory.* · task.* · job.* · prompt.* · context.* · bridge.*│   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  sk as a Skill  (~/.claude/skills/sk/ or ~/.codex/skills/sk/)│   │
│  │  Claude Code / Codex can manage sk natively via /sk command  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
        │              │              │              │
   Claude Code    Cursor MCP    Codex CLI      Gemini CLI
   (hooks+MCP)   (MCP)          (MCP)          (hooks+MCP)
        │                                           │
        └──────────────┬────────────────────────────┘
                       │
            ┌──────────┴──────────┐
            │     IM Bridge       │
            │  Telegram · Discord │
            │  Feishu · WhatsApp  │
            └──────────┬──────────┘
                       │
              You (phone / desktop)
```

---

## Skill Format Compatibility

The `sk` skill/prompt system is **100% compatible** with the standard agent skill format.
The same `.md` file works in `sk`, Claude Code, Codex, and Gemini CLI.

### The Standard SKILL.md Format

```markdown
---
name: calendar # used as /calendar or sk prompt run calendar
description: Evening review — what's on my list tomorrow?
version: 1.0.0
tags: [daily, review]
author: you
# sk-specific extensions (ignored by other agents):
inject_context: true
vars: [date, project]
notify: telegram
---

Today is {{date}}.

## Active Tasks

{{tasks.active | limit:10 | format:checklist}}

## Memory: Priorities

{{memory.search("tomorrow priorities blockers") | limit:5}}

## Prompt

What should I focus on tomorrow? Check for blockers and suggest one deferral.
```

### Directory Layout (Multi-Agent Compatible)

```
~/.claude/skills/         # Claude Code reads here natively
  sk/                     # sk installed as a skill for Claude Code
    SKILL.md
    scripts/
  calendar/               # Your personal skills
    SKILL.md
  code-review/
    SKILL.md

~/.codex/skills/          # Codex reads here
  sk/
    SKILL.md

~/.sk/skills/             # sk's own search path (global)
  calendar.md             # sk also reads simple single-file format

./                        # Per-project (git-tracked)
  .claude/
    skills/               # Claude Code discovers these automatically
      deploy-check/
        SKILL.md
  .sk/
    skills/               # sk reads these too (project wins over global)
      deploy-check.md
    SIDEKICK.md           # Project instructions (like CLAUDE.md)
```

### Skill Discovery & Progressive Disclosure

Follows the same pattern as the Claude Code skill system:

```
Phase 1 — Metadata scan (~100 tokens per skill)
  sk reads name + description from all SKILL.md frontmatter
  Fast: just parse YAML header, don't load body

Phase 2 — Full load (<5k tokens)
  Only when skill is activated (run, matched, or explicitly called)

Phase 3 — Bundled resources
  scripts/, references/, examples/ loaded only when needed
```

```bash
sk skills ls              # show all discovered skills (metadata only)
sk skills ls --verbose    # show full descriptions
sk skills sync            # rescan all directories
sk skills show calendar   # load + display full skill
sk skills add gh://user/repo-skill   # install from GitHub
sk skills add npx:skills add user/repo # via npx skills CLI
```

---

## IM Bridge: Bidirectional, Not Just Notifications

The bridge is modeled after `claude-to-im`. Architecture:

```
You (Telegram/Discord/Feishu)
        ↕  Bot API
sk daemon (bridge goroutine)
        ↕
Agent runtime (pluggable):
  - "claude"  → claude --print "{{rendered}}"
  - "codex"   → codex run "{{rendered}}"
  - "sk-job"  → sk job run {{job_name}}
  - "direct"  → sk mem search / task list (sk answers directly, no agent spawn)
```

The bridge has **four runtime modes** per chat binding:

| Mode           | What happens when you message                               |
| -------------- | ----------------------------------------------------------- |
| `agent:claude` | Message forwarded to Claude session, response streamed back |
| `agent:codex`  | Message forwarded to Codex session                          |
| `job:<name>`   | Your message becomes the `{{prompt}}` variable, job fires   |
| `direct`       | sk answers directly: memory search, task queries, status    |

### Streaming Response Preview

Long responses are previewed in chunks as they stream, then edited to final:

```
🔄 claude thinking...
> Analyzing your tasks...
> Found 2 blockers on auth work...

[message edited to full response when complete]
```

### Permission Approval Flow

When a job spawns Claude without `--dangerouslySkipPermissions`, or when
Claude Code is in permission-request mode, the bridge intercepts permission
events and sends inline keyboards:

```
⚠️ Claude wants permission:
Tool: Bash
Command: rm -rf ./dist && npm run build

[✅ Allow]  [✅ Allow for session]  [❌ Deny]
```

Tap Allow → response sent back to running agent → execution continues.
This is the **"approve from your phone"** workflow for long-running agents.

### Bot Commands

```
/start                        show welcome + current mode
/mode agent:claude            switch this chat to Claude sessions
/mode direct                  switch to direct sk queries
/run <job_name> [vars...]     fire a job
/run calendar date=today
/task list                    show active tasks
/task done <id>
/task add "Fix the thing" --project api
/mem <query>                  search memory
/context                      dump current context block
/status                       jobs, tasks, memory counts
/jobs                         list jobs + last run status
/job logs <name>              last run output
/approve <token>              approve a pending permission
/deny <token>

# In agent:claude mode — just talk normally:
You: "what did we decide about the auth strategy?"
sk: [searches memory, formats response]
    Found 2 memories:
    • "Use sync.RWMutex for token refresh" [api, 3h ago]
    • "Session tokens expire in 1h" [api, 2d ago]
```

### Multi-Platform

The bridge supports multiple IM platforms simultaneously.
Each platform gets its own bot token and authorized user list.

```toml
# ~/.sk/config.toml
[bridge.telegram]
enabled = true
token = "..."
authorized_users = [12345678]
mode = "agent:claude"          # default mode for new chats

[bridge.discord]
enabled = true
token = "..."
authorized_users = ["username#1234"]
mode = "direct"

[bridge.feishu]
enabled = false
```

---

## sk as a Skill (Install into Claude Code / Codex)

`sk` ships with its own SKILL.md so Claude Code and Codex can manage your
entire sidekick system conversationally:

```
/sk jobs                → show all job statuses
/sk run nightly-review  → fire a job
/sk mem search "auth"   → query memory
/sk task add "Fix bug"  → create task
/sk status              → full system overview
/sk doctor              → diagnose: sqlite-vec, Ollama, Telegram bot
```

Install:

```bash
# Claude Code
git clone https://github.com/you/sk ~/.claude/skills/sk

# Codex
git clone https://github.com/you/sk ~/.codex/skills/sk

# Or via npx
npx skills add your-org/sk
```

The SKILL.md tells the agent: "if the user mentions tasks, jobs, memory,
or asks what's next — use sk tools." The MCP server handles execution.

---

## Job Runner: Full Design

### Trigger Types

```
one-shot     run once now or at datetime
cron         "0 22 * * *" — OS scheduler or built-in
repeat       every N seconds/minutes/hours
watch        file/dir change (FSEvents/inotify)
webhook      HTTP POST to sk's local HTTP server
manual       only via sk job run or /run telegram command
bridge-msg   triggered when a message arrives in IM bridge mode "job:<name>"
```

### Job Status Machine

```
                    ┌──────────┐
              ┌────►│ pending  │
              │     └────┬─────┘
              │          │  scheduler fires
              │     ┌────▼─────┐
   retry?     │     │ running  │──────► stdout/stderr streamed to job_run_logs
              │     └────┬─────┘
              │     ┌────┴──────────────────┐
              │     │                       │
         ┌────┴──┐  ▼                       ▼
         │failed │ success            ┌──────────┐
         └───────┘                    │cancelled │
                                      └──────────┘
             skipped (overlap=skip, previous still running)
```

### Command Template Variables

Any job command can use:

```
{{prompt}}              rendered prompt template
{{date}}, {{time}}
{{job.name}}, {{job.id}}
{{run.id}}              current run ID (for referencing logs)
{{env.VAR_NAME}}        environment variable
{{tasks.count.active}}  live counts
{{msg}}                 (bridge-msg trigger only: incoming IM message)
```

### Real Examples

```bash
# Claude with any flags — fully generic
sk job add "nightly" \
  --command "claude --dangerouslySkipPermissions --print '{{prompt}}'" \
  --prompt calendar \
  --cron "0 22 * * *"

# Codex
sk job add "morning-codex" \
  --command "codex run '{{prompt}}'" \
  --prompt standup \
  --cron "0 9 * * 1-5"

# Shell pipeline — send standup to Telegram
sk job add "standup-notify" \
  --command "sk prompt render standup | sk bridge send --platform telegram" \
  --cron "0 9 * * 1-5"

# Git operations
sk job add "nightly-commit" \
  --command "cd {{env.PROJECT_DIR}} && git add -A && git commit -m 'auto: nightly snapshot'" \
  --cron "0 23 * * *"

# Webhook trigger — CI calls this after deploy
sk job add "post-deploy-review" \
  --command "claude --print '{{prompt}}'" \
  --prompt post-deploy \
  --trigger webhook \
  --notify always

# Watch trigger — auto-import new inbox notes
sk job add "import-inbox" \
  --command "sk mem add --file '{{path}}' --scope global --tag inbox" \
  --watch ~/notes/inbox/

# Bridge trigger — user sends message on Telegram, Claude runs it
sk job add "ask-claude" \
  --command "claude --print '{{msg}}'" \
  --trigger bridge-msg \
  --notify always
```

### OS-Native Install (No Daemon for Cron)

```bash
sk job install nightly       # → writes ~/.sk/launchd/sk.nightly.plist + loads it
sk job install morning-codex # → writes ~/.config/systemd/user/sk.morning-codex.service
sk job install --all         # install all cron/repeat jobs

# What gets generated (macOS):
cat ~/.sk/launchd/sk.nightly.plist
# <?xml ...>
# <key>StartCalendarInterval</key>
# <dict><key>Hour</key><integer>22</integer>...</dict>
# <key>ProgramArguments</key>
# <array><string>sk</string><string>job</string><string>exec</string><string>nightly</string></array>

sk job uninstall nightly     # launchctl unload + remove plist
```

---

## MCP Tools (Complete List)

```
# Memory
memory.search(query, scope?, limit?)        → layer-1 index
memory.timeline(id, window?)               → surrounding context
memory.get(ids[])                           → full content
memory.store(content, scope?, tags?)        → id

# Tasks
task.list(project?, status?, limit?)        → layer-1 index
task.get(ids[])                             → full details
task.create(title, project?, priority?)    → task
task.update(id, status?, note?, priority?) → task

# Projects
project.list()                              → projects[]
project.get(id)                             → full brief + tasks + memory

# Jobs
job.list(status?)                           → jobs + last run status
job.run(name, vars?)                        → run_id (async)
job.status(run_id)                          → status + output
job.logs(run_id, tail?)                    → log lines
job.cancel(run_id)                          → ok

# Prompts / Skills
skill.list()                                → skills[] (metadata only)
skill.render(name, vars?)                   → rendered string
skill.run(name, vars?, agent?)             → fires job with rendered prompt

# Context (3-layer)
context.layer1(project?, tokens?)           → compact index
context.layer2(ids[])                       → timeline/surrounding context
context.layer3(ids[])                       → full content
context.inject(ids[])                       → formatted block ready for prompt

# Bridge
bridge.send(message, platform?, chat_id?)  → ok
bridge.status()                             → connected platforms + chat bindings

# Session (hooks)
session.event(type, data)                   → store hook event
session.snapshot()                          → build precompact XML snapshot
session.restore()                           → get last snapshot for inject
session.log(agent, summary, task_updates?) → session id
```

---

## Database Schema (Complete)

```sql
-- Jobs
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  description   TEXT,
  command       TEXT NOT NULL,
  prompt_id     TEXT REFERENCES prompts(id),
  prompt_vars   TEXT,           -- JSON
  inject_context INTEGER DEFAULT 1,
  trigger_type  TEXT NOT NULL,  -- one-shot|cron|repeat|watch|webhook|manual|bridge-msg
  cron_expr     TEXT,
  repeat_secs   INTEGER,
  watch_path    TEXT,
  run_at        INTEGER,
  timeout_secs  INTEGER DEFAULT 300,
  max_retries   INTEGER DEFAULT 0,
  overlap       TEXT DEFAULT 'skip',  -- skip|queue|kill
  env_vars      TEXT,           -- JSON
  working_dir   TEXT,
  notify_on     TEXT DEFAULT 'failure',  -- never|failure|always
  notify_channel TEXT DEFAULT 'telegram',
  os_installed  INTEGER DEFAULT 0,
  enabled       INTEGER DEFAULT 1,
  last_run_at   INTEGER,
  next_run_at   INTEGER,
  run_count     INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE job_runs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  status      TEXT NOT NULL,    -- pending|running|success|failed|cancelled|skipped
  trigger_by  TEXT,             -- cron|manual|telegram|webhook|watch|bridge-msg
  started_at  INTEGER,
  ended_at    INTEGER,
  exit_code   INTEGER,
  stdout      TEXT,
  stderr      TEXT,
  error_msg   TEXT,
  retry_num   INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE job_run_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL REFERENCES job_runs(id),
  ts      INTEGER NOT NULL,
  stream  TEXT NOT NULL,  -- stdout|stderr
  line    TEXT NOT NULL
);
CREATE INDEX idx_run_logs ON job_run_logs(run_id, ts);

-- Tasks & Projects
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT DEFAULT 'active',
  scope         TEXT,
  tags          TEXT,
  obsidian_path TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id),
  title       TEXT NOT NULL,
  body        TEXT,
  status      TEXT DEFAULT 'todo',
  priority    INTEGER DEFAULT 2,
  due_at      INTEGER,
  tags        TEXT,
  author      TEXT DEFAULT 'human',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE task_notes (
  id         TEXT PRIMARY KEY,
  task_id    TEXT REFERENCES tasks(id),
  content    TEXT NOT NULL,
  author     TEXT DEFAULT 'human',
  created_at INTEGER NOT NULL
);

-- Memory
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  source      TEXT,
  scope       TEXT,
  tags        TEXT,
  importance  INTEGER DEFAULT 2,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags, content=memories, content_rowid=rowid
);
CREATE VIRTUAL TABLE memories_vec USING vec0(embedding FLOAT[384]);

-- Prompts / Skills
CREATE TABLE prompts (
  id            TEXT PRIMARY KEY,
  name          TEXT UNIQUE NOT NULL,
  description   TEXT,
  template      TEXT NOT NULL,
  is_skill      INTEGER DEFAULT 0,    -- loaded from SKILL.md
  skill_dir     TEXT,                 -- path to skill directory
  skill_version TEXT,
  frontmatter   TEXT,                 -- full parsed YAML as JSON
  tags          TEXT,
  version       INTEGER DEFAULT 1,
  pinned        INTEGER DEFAULT 0,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE prompt_runs (
  id          TEXT PRIMARY KEY,
  prompt_id   TEXT REFERENCES prompts(id),
  variables   TEXT,
  agent       TEXT,
  job_run_id  TEXT REFERENCES job_runs(id),
  output      TEXT,
  created_at  INTEGER NOT NULL
);

-- Sessions
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  project_id  TEXT,
  job_run_id  TEXT,
  summary     TEXT,
  events      TEXT,     -- JSON array
  snapshot    TEXT,     -- ≤2KB precompact XML
  tokens_used INTEGER,
  created_at  INTEGER NOT NULL
);

-- Bridge / IM
CREATE TABLE bridge_chats (
  id          TEXT PRIMARY KEY,   -- platform:chat_id
  platform    TEXT NOT NULL,      -- telegram|discord|feishu
  chat_id     TEXT NOT NULL,
  username    TEXT,
  mode        TEXT DEFAULT 'direct',  -- direct|agent:claude|agent:codex|job:<name>
  authorized  INTEGER DEFAULT 0,
  session_id  TEXT,               -- bound agent session
  created_at  INTEGER NOT NULL,
  UNIQUE(platform, chat_id)
);

CREATE TABLE bridge_messages (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT REFERENCES bridge_chats(id),
  direction   TEXT NOT NULL,    -- in|out
  text        TEXT,
  job_run_id  TEXT,
  platform_msg_id TEXT,         -- for editing streaming messages
  created_at  INTEGER NOT NULL
);

CREATE TABLE bridge_permissions (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT,
  job_run_id  TEXT,
  tool        TEXT NOT NULL,
  command     TEXT,
  status      TEXT DEFAULT 'pending',  -- pending|approved|denied|expired
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

-- Webhook tokens
CREATE TABLE webhooks (
  id         TEXT PRIMARY KEY,
  job_id     TEXT REFERENCES jobs(id),
  token      TEXT UNIQUE NOT NULL,
  enabled    INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Telegram / IM credentials (encrypted at rest)
CREATE TABLE bridge_config (
  platform   TEXT PRIMARY KEY,
  config     TEXT NOT NULL,     -- AES-encrypted JSON
  updated_at INTEGER NOT NULL
);
```

---

## Project Layout

```
sk/
├── cmd/
│   ├── root.go
│   ├── job.go
│   ├── task.go
│   ├── mem.go
│   ├── prompt.go
│   ├── skills.go
│   ├── context.go
│   ├── bridge.go           # sk bridge send / status / setup
│   ├── mcp.go
│   ├── hook.go             # sk hook <event> ← agent hooks call this
│   ├── daemon.go           # sk daemon (bridge + watchers)
│   ├── obsidian.go
│   └── doctor.go
├── internal/
│   ├── db/
│   ├── runner/
│   │   ├── executor.go     # PTY + streaming logs
│   │   ├── scheduler.go
│   │   ├── osinstall.go    # launchd / systemd
│   │   └── webhook.go      # HTTP server for webhook triggers
│   ├── search/
│   │   ├── bm25.go
│   │   ├── vector.go
│   │   └── hybrid.go
│   ├── embed/
│   ├── context/
│   │   ├── layers.go
│   │   ├── template.go
│   │   └── snapshot.go
│   ├── skills/
│   │   ├── loader.go       # scan dirs, parse SKILL.md frontmatter
│   │   ├── render.go       # {{tasks.active}} etc.
│   │   └── install.go      # sk skills add gh://...
│   ├── bridge/
│   │   ├── bridge.go       # core bidirectional bridge
│   │   ├── telegram.go     # telegram bot adapter
│   │   ├── discord.go      # discord adapter
│   │   ├── feishu.go       # feishu/lark adapter
│   │   ├── router.go       # mode routing: direct/agent/job
│   │   ├── streaming.go    # chunk + edit in place
│   │   ├── permissions.go  # inline approval keyboards
│   │   └── ratelimit.go
│   ├── mcp/
│   ├── obsidian/
│   └── tui/
├── skill/                  # sk as a Claude Code / Codex skill
│   ├── SKILL.md            # install this into ~/.claude/skills/sk/
│   └── scripts/
│       └── daemon.sh
├── skills/                 # built-in starter skills
│   ├── calendar/
│   │   └── SKILL.md
│   ├── standup/
│   │   └── SKILL.md
│   ├── code-review/
│   │   └── SKILL.md
│   └── debug-session/
│       └── SKILL.md
├── hooks/                  # drop-in hook configs for agents
│   ├── claude-code/
│   │   └── settings.json
│   ├── gemini-cli/
│   │   └── settings.json
│   └── cursor/
│       └── mcp.json
└── go.mod
```

---

## End-to-End Flows

### Flow 1 — Approve from Phone

```
Claude is running a long refactor job.
It hits: needs to delete 47 files.

1. Claude emits permission_request event
2. sk bridge intercepts → sends Telegram:

   ⚠️ Claude wants permission:
   Tool: Bash
   Command: find . -name "*.old" -delete
   Job: refactor-auth (run #47)

   [✅ Allow]  [✅ Session]  [❌ Deny]

3. You tap Allow on your phone
4. sk sends approval back to running Claude process
5. Claude continues execution
6. When done: ✅ refactor-auth (4m12s) — 47 files cleaned, 3 tests updated
```

### Flow 2 — "Ask Claude" from Telegram

```
Your chat is in mode: agent:claude

You: "what's the fastest way to fix the mutex issue in token.go?"
sk: [searches memory for context, prepends to message]
    [spawns: claude --print "<memory context>\n\nwhat's the fastest way..."]
🔄 claude thinking...
> Looking at token.go mutex pattern...
> The issue is double-locking on line 47...
[full response appears as edit to streaming message]
```

### Flow 3 — Codex Picks Up Your sk Context

```
Codex session starts
→ sk MCP server running
→ Codex reads .sk/SIDEKICK.md
→ sk/SKILL.md tells Codex: "use sk MCP for task and memory context"
→ Codex calls context.layer1()
→ Gets compact index: 3 active tasks, 5 recent memories, last session summary
→ Codex calls memory.get([mm_02]) for auth mutex memory
→ Starts work with full context. No copy-paste.
```

### Flow 4 — Skill Reuse Across Agents

```
# You write ONE skill file:
cat ~/.claude/skills/calendar/SKILL.md

# It works in all of these:
/calendar                       # in Claude Code (slash command)
sk prompt run calendar          # in sk CLI
codex run "use the calendar skill and tell me my priorities"
sk job add nightly --prompt calendar --cron "0 22 * * *"
/run calendar                   # in Telegram bot
```

---

## Phase Roadmap

### Phase 1 — Core (2-3 weeks)

- [ ] SQLite schema + migrations + ULID IDs
- [ ] `task` + `project` commands
- [ ] `mem` with BM25 (FTS5) search
- [ ] `job` runner: manual + one-shot
- [ ] Job status lifecycle + run logs table
- [ ] `sk status` + `sk doctor`

### Phase 2 — Jobs & Skills (2 weeks)

- [ ] Cron + repeat + watch triggers
- [ ] launchd/systemd emitter (`sk job install`)
- [ ] SKILL.md loader (parse frontmatter, scan dirs)
- [ ] Prompt template engine ({{tasks.active}} etc.)
- [ ] `sk skills sync` + `sk skills add gh://...`
- [ ] `sk context` 3-layer output

### Phase 3 — Intelligence (2 weeks)

- [ ] sqlite-vec + Ollama embeddings
- [ ] Hybrid search (BM25 + vector, RRF fusion)
- [ ] Session hooks (posttooluse, precompact, sessionstart)
- [ ] Session snapshot builder (≤2KB priority XML)

### Phase 4 — Bridge (2 weeks)

- [ ] Telegram bot adapter (bidirectional)
- [ ] Streaming response preview (edit-in-place)
- [ ] Permission approval inline keyboards
- [ ] Mode routing (direct / agent / job)
- [ ] Webhook trigger + HTTP server
- [ ] Discord adapter (optional Phase 5)

### Phase 5 — Multi-Agent (1 week)

- [ ] MCP server (stdio + HTTP)
- [ ] All MCP tools implemented
- [ ] `sk` as a Claude Code / Codex skill (SKILL.md + scripts)
- [ ] Hook configs for Claude Code, Cursor, Gemini CLI, Codex

### Phase 6 — Visibility

- [ ] Obsidian vault sync
- [ ] Bubbletea TUI (job monitor + mem browser)
- [ ] `sk job logs -f` live tail in terminal

```

```
