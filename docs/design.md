# SIDEKICK

### Local-First Human ↔ AI Collaboration Hub

> One Bun binary. Persistent memory · Task management with HITL review ·
> Generic job runner · Prompt/skill library · Telegram bridge · MCP server.
> The shared brain for Claude Code, Cursor, Codex, Gemini CLI — and you.

---

## System Architecture

```mermaid
graph TB
    subgraph BINARY["sk binary  (bun build --compile)"]
        CLI["CLI<br/>commander"]
        DAEMON["Daemon<br/>croner + watchers"]
        TUI["TUI<br/>OpenTUI + React"]
        MCP["MCP Server<br/>@modelcontextprotocol/sdk"]
        BRIDGE["IM Bridge<br/>Grammy (Telegram)"]
        RUNNER["Job Runner<br/>Bun.spawn + logs"]
    end

    subgraph STORE["SQLite (single file ~/.sk/sk.db)"]
        TASKS["tasks<br/>+ subtasks<br/>+ reviews"]
        JOBS["jobs<br/>+ job_runs<br/>+ run_logs"]
        MEM["memories<br/>FTS5 BM25<br/>sqlite-vec"]
        PROMPTS["prompts<br/>+ skills"]
        SESSIONS["sessions<br/>+ snapshots"]
        BRIDGE_DB["bridge_chats<br/>+ approvals"]
    end

    subgraph AGENTS["AI Agents"]
        CC["Claude Code"]
        CURSOR["Cursor"]
        CODEX["Codex CLI"]
        GEMINI["Gemini CLI"]
    end

    subgraph HUMAN["Human Interfaces"]
        TERM["Terminal<br/>(TUI + CLI)"]
        TG["Telegram"]
        OBS["Obsidian Vault"]
    end

    CLI --> STORE
    DAEMON --> RUNNER
    RUNNER --> STORE
    DAEMON --> BRIDGE
    BRIDGE --> STORE
    MCP --> STORE

    AGENTS -- "MCP stdio/HTTP" --> MCP
    AGENTS -- "sk hook *" --> SESSIONS

    TERM --> CLI
    TERM --> TUI
    TG <--> BRIDGE
    OBS <-.->|sync| MEM
```

---

## Task Lifecycle (HITL State Machine)

```mermaid
stateDiagram-v2
    direction LR

    [*] --> todo : created by human or agent

    todo --> doing : agent picks up\nor human starts

    doing --> review : agent calls\ntask.submitForReview()
    doing --> blocked : dependency\nor missing info
    doing --> cancelled : dropped

    blocked --> doing : unblocked

    review --> done : human approves\n(Telegram / CLI)
    review --> changes_requested : human taps\nRequest Changes + note

    changes_requested --> doing : agent picks up\nwith note attached

    done --> [*]
    cancelled --> [*]

    note right of review
        HITL checkpoint.
        Notification sent to Telegram.
        Agent may await or continue other tasks.
    end note
```

---

## Job Execution Flow

```mermaid
flowchart TD
    TRIGGER["Trigger fires\n(cron / manual / webhook /\nwatch / bridge-msg)"]
    APPROVE{"require_approval\n= true?"}
    NOTIFY_APPROVAL["Send Telegram approval card\n▶ Run  ✗ Cancel"]
    WAIT_HUMAN{"Human responds"}
    PENDING["status = pending"]
    OVERLAP{"overlap\ncheck"}
    SKIP["status = skipped\n(previous still running)"]
    RUNNING["status = running\nspawn process\nstream logs → job_run_logs"]
    TIMEOUT{"timeout\nexceeded?"}
    EXIT{"exit code\n= 0?"}
    SUCCESS["status = success\nparse output for\n[DONE: taskId] markers"]
    FAILED["status = failed\nCapture stderr"]
    RETRY{"max_retries\nremaining?"}
    NOTIFY["Notify via\nconfigured channel\n(Telegram / stdout)"]
    UPDATE_TASKS["Auto-close tasks\nfound in output"]

    TRIGGER --> APPROVE
    APPROVE -- yes --> NOTIFY_APPROVAL
    NOTIFY_APPROVAL --> WAIT_HUMAN
    WAIT_HUMAN -- approved --> PENDING
    WAIT_HUMAN -- denied --> SKIP
    APPROVE -- no --> PENDING
    PENDING --> OVERLAP
    OVERLAP -- previous running, skip --> SKIP
    OVERLAP -- ok --> RUNNING
    RUNNING --> TIMEOUT
    TIMEOUT -- yes --> FAILED
    TIMEOUT -- no --> EXIT
    EXIT -- yes --> SUCCESS
    EXIT -- no --> FAILED
    FAILED --> RETRY
    RETRY -- yes --> PENDING
    RETRY -- no --> NOTIFY
    SUCCESS --> UPDATE_TASKS
    SUCCESS --> NOTIFY
```

---

## Memory Search Pipeline (FTS5 BM25)

> No external embedding deps. SQLite FTS5 with porter stemming gets 98% context savings with zero infra.

```mermaid
flowchart LR
    Q["User / Agent Query\n&quot;auth token strategy&quot;"]

    subgraph FTS["SQLite FTS5 — no external deps"]
        PORTER["Layer 1: Porter stemming\nBM25 ranked MATCH\n&quot;caching&quot; = &quot;cached&quot; = &quot;caches&quot;"]
        TRIGRAM["Layer 2: Trigram fallback\nSubstring match\n&quot;useEff&quot; → &quot;useEffect&quot;"]
        LIKE["Layer 3: LIKE fallback\nLast resort if FTS index\nnot yet populated"]
    end

    DECAY["Temporal decay\nrecent = higher score\nunless importance=critical"]

    subgraph LAYERS["3-Layer Progressive Disclosure"]
        L1["Layer 1: IDs + snippets\n~5 tokens/result\ncheap, always call first"]
        L2["Layer 2: Timeline context\nwhat was stored around it\nchronological window"]
        L3["Layer 3: Full content\n~500 tokens/result\nbatch IDs, fetch only what you need"]
    end

    Q --> PORTER
    PORTER -->|no results| TRIGRAM
    TRIGRAM -->|no results| LIKE
    PORTER --> DECAY
    TRIGRAM --> DECAY
    DECAY --> L1
    L1 -->|drill in| L2
    L2 -->|need full text| L3
```

---

## Telegram HITL Review Flow

```mermaid
sequenceDiagram
    participant Agent as Claude / Cursor
    participant SK as sk (MCP + bridge)
    participant DB as SQLite
    participant TG as Telegram Bot
    participant Human as You (phone)

    Agent->>SK: task.submitForReview(id, summary)
    SK->>DB: status = "review", write review record
    SK->>TG: Send review card with inline keyboard
    TG->>Human: 🔍 Review: Fix auth bug\n[✅ Approve] [↩️ Changes]

    alt Human approves
        Human->>TG: tap ✅ Approve
        TG->>SK: callback: approve:taskId
        SK->>DB: status = "done", resolved_at
        SK->>TG: Edit message → ✅ Approved
        SK->>Agent: task.checkReviewStatus() → "approved"
    else Human requests changes
        Human->>TG: tap ↩️ Changes
        TG->>Human: Bot asks: "What needs changing?"
        Human->>TG: "Add timeout test case"
        TG->>SK: callback: changes:taskId note:"Add timeout..."
        SK->>DB: status = "changes_requested", note saved
        SK->>TG: Edit → ↩️ Sent back with note
        SK->>Agent: task.checkReviewStatus() → {status:"changes", note:"Add timeout..."}
        Agent->>Agent: Picks up task, reads note, fixes issue
        Agent->>SK: task.submitForReview(id, "Added TestTokenRefresh_Timeout")
    end
```

---

## Agent Permission Approval Flow

```mermaid
sequenceDiagram
    participant Job as Running Job\n(claude --dangerous...)
    participant SK as sk daemon
    participant TG as Telegram
    participant Human as You

    Job->>SK: permission_request event\n{tool: "Bash", cmd: "rm -rf ./dist"}
    SK->>TG: ⚠️ Permission Request\nTool: Bash\nCommand: rm -rf ./dist\n[✅ Allow] [✅ Session] [❌ Deny]
    TG->>Human: Shows approval card

    alt Allow
        Human->>TG: tap ✅ Allow
        TG->>SK: callback approve
        SK->>Job: write "allow" to approval pipe
        Job->>Job: continues execution
    else Deny
        Human->>TG: tap ❌ Deny
        TG->>SK: callback deny
        SK->>Job: write "deny" to approval pipe
        Job->>Job: skips command, continues
    end
```

---

## Multi-Agent Context Handoff

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant SK as sk
    participant DB as SQLite
    participant CURSOR as Cursor

    Note over CC: Session working on auth bug

    CC->>SK: hook: posttooluse (file edits, task updates)
    SK->>DB: store session events
    CC->>SK: hook: precompact (context window full)
    SK->>SK: Build ≤2KB XML snapshot\n(tasks, files, decisions, errors)
    SK->>DB: store snapshot

    Note over CC: Session ends

    Note over CURSOR: New Cursor session starts
    CURSOR->>SK: MCP: context.layer1()
    SK->>DB: fetch active tasks + recent memory
    SK-->>CURSOR: Compact index\n• #tk_01 Fix auth mutex [doing]\n• #mm_02 "use sync.RWMutex" [2h ago]

    CURSOR->>SK: MCP: memory.get(["mm_02"])
    SK-->>CURSOR: Full content of memory
    CURSOR->>SK: MCP: session.restore()
    SK-->>CURSOR: Last session snapshot XML
    Note over CURSOR: Continues with full context.\nNo copy-paste needed.
```

---

## Nightly Review Scheduled Job

```mermaid
sequenceDiagram
    participant CRON as croner (daemon)
    participant SK as sk runner
    participant TMPL as Template engine
    participant DB as SQLite
    participant CLAUDE as claude process
    participant TG as Telegram

    Note over CRON: 22:00 — cron fires

    CRON->>SK: trigger job "nightly-review"
    SK->>DB: status = "running", create job_run
    SK->>DB: fetch active tasks, recent memory
    SK->>TMPL: render calendar.md skill\nwith {{tasks.active}} {{memory.search(...)}}
    TMPL-->>SK: rendered prompt string

    SK->>CLAUDE: spawn: claude --print "<prompt>"
    CLAUDE->>SK: stdout stream (line by line)
    SK->>DB: append each line → job_run_logs
    SK->>TG: 🔄 nightly-review running...

    CLAUDE-->>SK: process exits 0
    SK->>SK: parse output for [DONE: tk_01] markers
    SK->>DB: update task statuses
    SK->>DB: status = "success", ended_at
    SK->>TG: ✅ nightly-review (28s)\n"Focus tomorrow: auth bug (#23).\n2 tasks closed."
```

---

## OpenTUI Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  sk  [Tasks]  [Jobs]  [Memory]  [Bridge]        ⬡ daemon: running  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  TASKS                                           REVIEW QUEUE       │
│  ──────                                          ────────────────   │
│  TODO (3)          DOING (2)    REVIEW (1)       🔍 Fix auth bug    │
│  ┌──────────────┐  ┌──────────┐  ┌──────────┐       by claude      │
│  │ Update README│  │ Auth bug │  │ Auth bug │       3m ago         │
│  │ low · api    │  │ high·api │  │ high·api │   [✅ Done]           │
│  └──────────────┘  └──────────┘  └──────────┘   [↩ Changes]        │
│  ┌──────────────┐  ┌──────────┐                                     │
│  │ Deploy review│  │ Deploy   │                  JOBS               │
│  │ normal · api │  │ normal   │                  ────────────────   │
│  └──────────────┘  └──────────┘                  ● nightly-review  │
│                                                    ✅ 22:01  28s    │
│                                                   ● standup-notify  │
│  MEMORY SEARCH                                     ✅ 09:01  12s    │
│  ──────────────                                   ● sync-vault      │
│  🔍 [auth strategy_____________]                   ❌ 08:45  timeout│
│                                                                     │
│  • "use sync.RWMutex for token refresh" [api]    BRIDGE STATUS      │
│  • "session tokens expire in 1h"        [api]    ─────────────────  │
│  • "auth issue: race on refresh"        [api]    ✅ Telegram active │
│                                                   1 pending review  │
└─────────────────────────────────────────────────────────────────────┘
 [tab] switch panel  [/] search  [n] new  [enter] expand  [q] quit
```

---

## Technology Stack

| Layer             | Choice                    | Why                                                            |
| ----------------- | ------------------------- | -------------------------------------------------------------- |
| **Runtime**       | Bun                       | Single binary via `--compile`, cross-platform, Anthropic-owned |
| **Language**      | TypeScript (strict)       | Same as Claude Code, Codex, Gemini CLI — whole ecosystem       |
| **TUI**           | **OpenTUI + React**       | Native Zig core, powers OpenCode, built-in Code/Diff/ScrollBox |
| **CLI parsing**   | commander                 | Lightweight, typed, battle-tested                              |
| **Database**      | bun:sqlite                | Built into Bun, fastest SQLite binding, zero deps              |
| **ORM / schema**  | Drizzle ORM               | Zero runtime overhead, TS types = schema                       |
| **Cron**          | croner                    | No deps, best TS API, named jobs, pause/resume                 |
| **Telegram**      | Grammy                    | Modern TS-first, conversations plugin for multi-step HITL      |
| **MCP**           | @modelcontextprotocol/sdk | Official Anthropic SDK                                         |
| **IM bridge**     | claude-to-im              | npm install, reuse directly — no rewrite                       |
| **Embeddings**    | @ollama/ollama            | Local-first, no API key, falls back to OpenAI                  |
| **Vector search** | sqlite-vec extension      | Same file as main DB, zero infra                               |
| **Full-text**     | SQLite FTS5 native        | BM25 ranking built in                                          |
| **Process exec**  | Bun.spawn                 | Native, PTY support, streaming stdout/stderr                   |
| **File watching** | chokidar                  | Cross-platform, solid, minimal                                 |
| **Testing**       | bun:test                  | Built in, fast                                                 |

---

## Project Structure

```
sk/
├── src/
│   ├── cli.ts                  ← entry: bun build --compile
│   ├── daemon.ts               ← entry: croner + bridge + watchers
│   │
│   ├── db/
│   │   ├── schema.ts           ← Drizzle schema (source of truth for all types)
│   │   ├── client.ts           ← bun:sqlite + drizzle instance singleton
│   │   └── migrations/
│   │
│   ├── commands/               ← one file per CLI command group
│   │   ├── task.ts
│   │   ├── job.ts
│   │   ├── mem.ts
│   │   ├── prompt.ts
│   │   ├── skills.ts
│   │   ├── context.ts
│   │   ├── bridge.ts
│   │   ├── hook.ts             ← sk hook posttooluse/precompact/sessionstart
│   │   └── obsidian.ts
│   │
│   ├── core/
│   │   ├── runner.ts           ← job executor: Bun.spawn + log streaming
│   │   ├── scheduler.ts        ← croner wrappers + trigger routing
│   │   ├── search/
│   │   │   ├── bm25.ts         ← FTS5 queries
│   │   │   ├── vector.ts       ← sqlite-vec cosine search
│   │   │   └── hybrid.ts       ← RRF fusion
│   │   ├── embed/
│   │   │   ├── ollama.ts
│   │   │   └── openai.ts
│   │   ├── context/
│   │   │   ├── layers.ts       ← 3-layer progressive disclosure
│   │   │   ├── template.ts     ← {{tasks.active}} etc.
│   │   │   └── snapshot.ts     ← ≤2KB precompact XML builder
│   │   └── skills/
│   │       ├── loader.ts       ← scan dirs, parse SKILL.md frontmatter
│   │       └── render.ts       ← template variable substitution
│   │
│   ├── bridge/
│   │   ├── telegram.ts         ← Grammy bot setup + command handlers
│   │   ├── hitl.ts             ← review/approval flows + inline keyboards
│   │   ├── streaming.ts        ← edit-in-place response streaming
│   │   └── router.ts           ← mode: direct / agent:claude / job:<n>
│   │
│   ├── mcp/
│   │   ├── server.ts           ← MCP server (stdio + HTTP)
│   │   └── tools.ts            ← all tool definitions
│   │
│   └── tui/                    ← OpenTUI + React components
│       ├── App.tsx             ← root: tab navigation
│       ├── Dashboard.tsx       ← overview: tasks + jobs + review queue
│       ├── JobMonitor.tsx      ← live status + log tail (Code component)
│       ├── TaskBoard.tsx       ← kanban by status
│       ├── MemBrowser.tsx      ← searchable memory list
│       └── ReviewQueue.tsx     ← pending HITL items
│
├── skills/                     ← built-in starter skills (SKILL.md format)
│   ├── calendar/SKILL.md
│   ├── standup/SKILL.md
│   └── code-review/SKILL.md
│
├── skill/SKILL.md              ← sk itself as a Claude Code / Codex skill
│
├── hooks/                      ← drop-in hook configs for agents
│   ├── claude-code/settings.json
│   ├── gemini-cli/settings.json
│   └── cursor/mcp.json
│
├── build.ts                    ← cross-compile all targets
├── package.json
└── tsconfig.json
```

---

## Build & Distribution

```typescript
// build.ts — produces binaries for all platforms
const targets = [
  { target: "bun-linux-x64", out: "dist/sk-linux-x64" },
  { target: "bun-linux-arm64", out: "dist/sk-linux-arm64" },
  { target: "bun-darwin-arm64", out: "dist/sk-mac-arm64" },
  { target: "bun-darwin-x64", out: "dist/sk-mac-x64" },
  { target: "bun-windows-x64", out: "dist/sk.exe" },
];

for (const { target, out } of targets) {
  await Bun.build({
    entrypoints: ["./src/cli.ts"],
    outfile: out,
    target: target as Parameters<typeof Bun.build>[0]["target"],
    compile: true,
    minify: true,
  });
}
```

**Install options for users:**

```bash
# macOS / Linux (curl install)
curl -fsSL https://get.sidekick.sh | sh

# Homebrew
brew install sidekick/tap/sk

# Manual: download binary from GitHub Releases, chmod +x, move to PATH
```

---

## OpenTUI vs Ink: Why OpenTUI Wins Here

|                  | Ink                | **OpenTUI**                                           |
| ---------------- | ------------------ | ----------------------------------------------------- |
| Core             | Pure JS            | **Native Zig** — faster, lower memory                 |
| Powers           | GitHub CLI, Prisma | **OpenCode** — exact ecosystem match                  |
| Code rendering   | None               | **Built-in tree-sitter** — perfect for job logs       |
| Diff rendering   | None               | **Built-in Diff component** — perfect for HITL review |
| Scroll           | Limited            | **ScrollBox** — handles long job output               |
| React support    | ✅                 | ✅                                                    |
| `bun create tui` | ❌                 | ✅                                                    |
| Maturity         | Stable v5          | v0.1 but production in OpenCode                       |

The `Code` and `Diff` components are what make OpenTUI the right call.
When reviewing a task in the TUI, you want to see the actual diff of what
Claude changed — syntax-highlighted, scrollable — not a wall of text.

---

## Key Design Decisions

| Decision      | Choice                 | Reason                                                      |
| ------------- | ---------------------- | ----------------------------------------------------------- |
| Runtime       | Bun                    | Single binary, Anthropic-owned, whole AI ecosystem is TS    |
| TUI           | OpenTUI + React        | Powers OpenCode, native Zig core, Code/Diff components      |
| Cron          | croner in-process      | Cross-platform, no OS scheduler, named jobs, pause/resume   |
| SQLite        | bun:sqlite + Drizzle   | Built into Bun, typed schema, zero overhead                 |
| Telegram      | Grammy + conversations | Multi-step HITL flows are first-class                       |
| HITL gate     | `review` status        | Explicit holding state, auditable, works for subtasks       |
| MCP           | Official SDK           | Direct Anthropic support, works with all agents             |
| Skills format | Standard SKILL.md      | Compatible with Claude Code, Codex, Gemini CLI              |
| IM bridge     | claude-to-im (reuse)   | Already solves bidirectional bridge, streaming, permissions |
| Context       | 3-layer progressive    | Never dump raw data — agents pull only what they need       |
