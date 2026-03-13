---
name: orc-memory-knowledge
description: Use when storing project knowledge, decisions, rules, or discoveries in ORC, when searching for past context about a project, when an agent needs to recall architectural decisions or conventions, when multiple agents need shared knowledge, or when building a persistent knowledge base across long-running sessions. Trigger when user says "remember", "recall", "what did we decide", "store this", or when you make an important architectural or process decision.
---

# ORC Memory & Knowledge Management

ORC's memory layer is a shared, searchable knowledge store backed by FTS5 full-text search in SQLite. All agents and humans read from and write to the same store. Think of it as a team's collective long-term memory — decisions stay, events fade.

---

## Memory Types (Choose Deliberately)

| Type | Weight in `context()` | Use for |
|------|----------------------|---------|
| `rule` | **Highest** | Conventions: "all IDs are ULIDs", "never use `any`", "commits must be signed" |
| `decision` | **High** | Choices with rationale: "use Hono over Express because it runs in Bun natively" |
| `discovery` | Medium | Findings: "token refresh has race condition when <100ms apart" |
| `fact` | Low | General knowledge: "API port is 7700", "DB path is ~/.orc/orc.db" |
| `event` | Lowest | Log entries: "deployed v0.1.0 on 2025-03-10" |

Rules and decisions float to the top of every agent's context. Store your most important constraints as rules.

---

## Storing Memories

```typescript
// Store an architectural decision
memory_store({
  content: "We use ULID (not UUID) for all primary keys. ULIDs are sortable by time, which gives us chronological ordering for free. Import from @orc/core/ids.",
  type: "decision",
  title: "ID format: ULID everywhere",
  scope: "architecture",      // optional: group memories by area
  importance: "high"          // low | normal | high | critical
})

// Store a rule
memory_store({
  content: "Never use TypeScript `any`. Use `unknown` and narrow with type guards. Violations fail CI.",
  type: "rule",
  title: "No any in TypeScript",
  scope: "code-style"
})

// Store a discovery
memory_store({
  content: "FTS5 porter stemmer doesn't handle camelCase well — 'useCallback' won't match 'callback'. Use trigram search for code identifiers.",
  type: "discovery",
  scope: "search"
})
```

### Importance levels

| Level | Use for |
|-------|---------|
| `critical` | Must-follow constraints, security rules |
| `high` | Key architectural choices, important conventions |
| `normal` | Useful context, typical decisions |
| `low` | FYI entries, minor notes |

---

## Searching Memories

ORC uses a 3-layer cascade search — it finds things even if wording varies:

1. **Porter stemming AND** — "caching" matches "cache", "cached" — best precision
2. **Porter stemming OR** — any word in query matches — more recall
3. **Trigram AND** — substring match — great for code identifiers like "useCallback"
4. **Trigram OR** — any trigram matches
5. **LIKE fallback** — last resort substring

```typescript
// Semantic search
memory_search({ query: "why did we choose SQLite over PostgreSQL" })

// Code identifier search (trigrams handle camelCase)
memory_search({ query: "useCallback", scope: "frontend" })

// Filter by type
memory_search({ query: "database", type: "decision", limit: 5 })

// Filter by scope
memory_search({ query: "auth", scope: "security", importance: "high" })
```

Returns: array of `{ id, title, snippet, type, importance, created_at, score }`

### Get full content

Search returns snippets. For full content:
```typescript
memory_get({ ids: ["mem_01HXYZ...", "mem_01HABC..."] })
```

Batching multiple IDs in one call saves tokens vs. sequential calls.

---

## Memory Scopes

Scopes are free-form strings for organizing memories. Suggested scopes for an ORC project:

| Scope | Contains |
|-------|---------|
| `architecture` | System design decisions |
| `code-style` | TypeScript rules, formatting conventions |
| `api` | API contract decisions |
| `security` | Auth, secrets, permissions |
| `database` | Schema decisions, migration notes |
| `gateway` | Telegram/Slack integration |
| `mcp` | MCP tool design choices |
| `ops` | Deployment, infra, environment |
| `bugs` | Known issues, workarounds |

---

## Memory Timeline (Context Around a Finding)

When you find a relevant memory, understand what was happening when it was stored:
```typescript
memory_timeline({ id: "mem_01HXYZ...", before: 3, after: 3 })
// Returns: 3 memories stored before + this one + 3 after
```

This helps reconstruct the reasoning behind a decision, not just the conclusion.

---

## CLI Memory Operations

```bash
# Search
orc mem search "why ULID"
orc mem search "database schema" --scope architecture --limit 5

# Store
orc mem add "Session snapshots are capped at 2KB to fit in hook stdout" --type fact --scope mcp
orc mem add "All gateway messages must be redacted before logging" --type rule --scope security --importance critical

# List recent
orc mem list
orc mem list --limit 20
```

---

## Memory Expiration

For time-sensitive memories (e.g., "current sprint goal", "today's deploy freeze"):
```typescript
memory_store({
  content: "Deploy freeze until Monday 2025-03-17 — no merges to main",
  type: "rule",
  importance: "critical",
  expires_at: "2025-03-17T23:59:59Z"
})
```

Expired memories are excluded from search results automatically.

---

## When to Store vs. When to Use CLAUDE.md

| Use **ORC memory** for | Use **CLAUDE.md** for |
|----------------------|----------------------|
| Runtime decisions made during a session | Up-front project conventions |
| Findings from debugging or exploration | Static architectural docs |
| Cross-agent shared knowledge | Claude Code–specific instructions |
| Things that change over time | Things that rarely change |
| "We decided X because Y" | "Always do X" |

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Storing everything as `fact` | Use `rule`/`decision` for important things — they get priority in context |
| Searching with exact phrases | Use keywords; the stemmer handles variations |
| Storing duplicate memories | Search first before storing — `memory_search({ query: "your topic" })` |
| Not including rationale in decisions | Future agents need the *why*, not just the *what* |
| Forgetting scopes | Scopes make search much faster for large memory stores |
| Using `memory_get` without searching first | Search → get IDs → fetch full content; don't fetch blind |
