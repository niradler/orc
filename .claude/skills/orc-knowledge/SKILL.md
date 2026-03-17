---
name: orc-knowledge
description: Use when storing project knowledge, decisions, rules, or discoveries in ORC, when searching for past context about a project, when an agent needs to recall architectural decisions or conventions, when multiple agents need shared knowledge, or when building a persistent knowledge base across sessions. Trigger when user says "remember", "recall", "what did we decide", "store this", when you make an important architectural or process decision, or when you need to look up past context before starting work.
---

# ORC Knowledge Management

ORC's memory layer is a shared, searchable knowledge store backed by FTS5 full-text search in SQLite. All agents and humans read from and write to the same store, scoped by project.

## Why Store Knowledge in ORC

CLAUDE.md is for static conventions. ORC memory is for living knowledge — decisions made during work, discoveries from debugging, rules that emerge from experience. It survives across sessions, is searchable by any agent, and the most important entries float to the top of every `context()` call.

---

## Memory Types (Choose Deliberately)

| Type | Weight in `context()` | Use for | Example |
|------|----------------------|---------|---------|
| `rule` | **Highest** | Must-follow conventions | "all IDs are ULIDs", "never use `any`" |
| `decision` | **High** | Choices with rationale | "use Hono over Express — runs natively in Bun" |
| `discovery` | Medium | Findings from work | "FTS5 porter stemmer doesn't handle camelCase" |
| `event` | Low | Things that happened | "deployed v0.2.0 to staging" |
| `fact` | Low (default) | General knowledge | "API port is 7700" |

Rules and decisions float to the top. Store your most important constraints as rules.

---

## Storing Knowledge

All `memory_store` calls accept `project` — a readable project name (e.g. `"orc"`). Omit to use `activeProject`.

```typescript
// Architectural decision — high weight, surfaces in context()
memory_store({
  content: "We use ULID (not UUID) for all primary keys. ULIDs are sortable by time. Import from @orc/core/ids.",
  type: "decision",
  title: "ID format: ULID everywhere",
  scope: "architecture",
  importance: "high",
  project: "orc"
})

// Convention — highest weight
memory_store({
  content: "Never use TypeScript `any`. Use `unknown` and narrow with type guards.",
  type: "rule",
  title: "No any in TypeScript",
  scope: "code-style",
  project: "orc"
})

// Finding from debugging
memory_store({
  content: "FTS5 porter stemmer doesn't handle camelCase — 'useCallback' won't match 'callback'. Use trigram search for code identifiers.",
  type: "discovery",
  scope: "search",
  project: "orc"
})
```

### Importance Levels

| Level | Use for |
|-------|---------|
| `critical` | Must-follow constraints, security rules |
| `high` | Key architectural choices, important conventions |
| `normal` | Useful context, typical decisions |
| `low` | FYI entries, minor notes |

### Expiration (for time-sensitive knowledge)

```typescript
memory_store({
  content: "Deploy freeze until Monday 2025-03-17",
  type: "rule",
  importance: "critical",
  expires_at: "2025-03-17T23:59:59Z",
  project: "orc"
})
```

Expired memories are excluded from search automatically.

---

## Searching Knowledge

ORC uses a 3-layer cascade — finds things even when wording varies:

1. **Porter stemming AND** — "caching" matches "cache", "cached" — best precision
2. **Porter stemming OR** — any word matches — more recall
3. **Trigram** — substring match — handles camelCase like `useCallback`
4. **LIKE fallback** — last resort

```typescript
// Semantic search
memory_search({ query: "why did we choose SQLite", project: "orc" })

// Filter by type and scope
memory_search({ query: "database", type: "decision", scope: "architecture", limit: 5 })

// Code identifiers (trigrams handle camelCase)
memory_search({ query: "useCallback", scope: "frontend" })
```

Returns: `{ id, title, snippet, type, importance, created_at, score }`

### Get Full Content

Search returns snippets. For the full text:
```typescript
memory_get({ ids: ["mem_01HXYZ...", "mem_01HABC..."] })
```

Batch multiple IDs in one call — saves tokens vs sequential calls.

### Timeline (Context Around a Finding)

```typescript
memory_timeline({ id: "mem_01HXYZ...", before: 3, after: 3 })
```

Returns memories stored before and after — helps reconstruct the reasoning behind a decision.

---

## Scopes

Scopes are free-form strings for organizing memories. Suggested scopes:

| Scope | Contains |
|-------|---------|
| `architecture` | System design decisions |
| `code-style` | TypeScript rules, formatting |
| `api` | API contract decisions |
| `security` | Auth, secrets, permissions |
| `database` | Schema decisions, migrations |
| `gateway` | Telegram/Slack integration |
| `mcp` | MCP tool design choices |
| `ops` | Deployment, infra |
| `bugs` | Known issues, workarounds |

---

## When to Store in ORC vs CLAUDE.md

| ORC memory | CLAUDE.md |
|------------|-----------|
| Runtime decisions made during sessions | Up-front project conventions |
| Findings from debugging or exploration | Static architectural docs |
| Cross-agent shared knowledge | Agent-specific instructions |
| Things that change over time | Things that rarely change |
| "We decided X because Y" | "Always do X" |

---

## CLI Operations

```bash
orc mem search "why ULID"
orc mem search "database schema" --scope architecture --limit 5
orc mem add "Session snapshots capped at 2KB" --type fact --scope mcp
orc mem add "All gateway messages redacted before logging" --type rule --scope security --importance critical
orc mem list
orc mem list --limit 20
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Storing everything as `fact` | Use `rule`/`decision` for important things — they get priority |
| Searching with exact phrases | Use keywords; the stemmer handles variations |
| Storing duplicates | Search first: `memory_search({ query: "your topic" })` |
| Missing rationale in decisions | Future agents need the *why*, not just the *what* |
| Skipping scopes | Scopes make search faster on large knowledge stores |
| Using `memory_get` blindly | Search first → get IDs → fetch full content |
