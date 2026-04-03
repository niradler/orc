---
name: orc-knowledge
description: Use when storing project knowledge, decisions, rules, or discoveries in ORC, when searching for past context, when recalling architectural decisions or conventions, when multiple agents need shared knowledge, or when building a persistent knowledge base. Trigger on "remember", "recall", "what did we decide", "store this", when making architectural decisions, or when you need past context before starting work.
allowed-tools: ["mcp__orc__memory_search", "mcp__orc__memory_get", "mcp__orc__memory_store", "mcp__orc__memory_update", "mcp__orc__search"]
---

# ORC Knowledge Workflow

ORC's memory layer is a shared, searchable knowledge store backed by FTS5 full-text search. All agents read/write the same store, scoped by project.

## Why Use ORC Memory

CLAUDE.md is for static conventions. ORC memory is for living knowledge — decisions made during work, discoveries from debugging, rules that emerge from experience. It survives across sessions, is searchable by any agent, and important entries float to the top of every `context()` call.

---

## When to Store

**Store as `rule`** (highest priority in context): Conventions and must-follow constraints.
> "All IDs are ULIDs", "never use `any` in TypeScript"

**Store as `decision`** (high priority): Choices with rationale — future agents need the *why*.
> "Use Hono over Express — runs natively in Bun"

**Store as `discovery`** (medium): Findings from debugging or exploration.
> "FTS5 porter stemmer doesn't handle camelCase"

**Store as `fact`** or **`event`** (low): General knowledge, things that happened.

### Write good titles

Title appears in search results and context — it's how agents decide which memories to read. One short sentence: what it is + when to use it.

Good: `title: "JWT over sessions — check before touching auth"`
Bad: `title: "auth decision"`

### Before storing, always search first to avoid duplicates.

If `memory_store` finds a similar existing memory, it will warn you. Use `memory_update` to merge instead of creating duplicates.

---

## Updating Memories

Use `memory_update(id, {fields})` to correct or evolve a memory in place. This preserves history (created_at, access_count) and is preferred over delete+recreate.

**Decisions and rules should rarely be deleted** — append corrections to the content instead. Future agents need the historical rationale.

---

## Source Metadata

The `source` field is auto-detected from the agent environment (e.g. "claude-code@session_abc"). You can override it with an explicit `source` param for more context (e.g. "code-review", "debugging-session").

---

## What NOT to Store

Not everything belongs in memory. Skip:
- **Code patterns and conventions** derivable from reading the codebase
- **Git history** — use `git log` / `git blame` instead
- **Debugging solutions** — the fix is in the code, the commit message has context
- **Anything already in CLAUDE.md** or project docs
- **Ephemeral task details** — use tasks for in-progress work

Store only what's surprising, non-obvious, or cross-session relevant.

---

## Content Size

Keep individual memories under ~2000 characters. If you need more, split into multiple related memories with the same scope and tags.

---

## When to Search

- Before starting work — check what decisions have been made
- When you need to understand past context or rationale
- When the user asks "what did we decide about X"
- When you encounter something that might have been solved before

The 3-layer cascade (porter stemming, trigram, LIKE) finds things even when wording varies. Use keywords, not exact phrases.

The unified `search` tool searches across both memories and tasks in one call — use it when you're not sure where the information lives.

---

## Scopes

Use scopes to organize: `architecture`, `code-style`, `api`, `security`, `database`, `gateway`, `mcp`, `ops`, `bugs`. Scopes make search faster on large stores.

---

## Prompts as Knowledge

Built-in prompts (`prompt_list`) encode workflow knowledge — how to do code review, planning, bug fixing. Use `prompt_get` to load a specific workflow when you need structured guidance. Store project-specific workflow tweaks as `rule` memories.

---

## ORC Memory vs CLAUDE.md

| ORC memory | CLAUDE.md |
|------------|-----------|
| Runtime decisions during sessions | Up-front project conventions |
| Findings from debugging | Static architectural docs |
| Cross-agent shared knowledge | Agent-specific instructions |
| Things that change | Things that rarely change |
| "We decided X because Y" | "Always do X" |

---

## CLI Fallbacks

```bash
orc mem search "why ULID" --scope architecture
orc mem add "Always use strict mode" --type rule --scope code-style --importance critical
orc mem list --limit 20
```

---

## Token Economics

Know the cost of your actions:

| Tool | Cost | Use when |
|------|------|----------|
| `context()` | ~200 tokens | Always call first — cheap overview |
| `memory_search` | ~50-100 tokens/result | Targeted keyword search |
| `search` | ~50-100 tokens/result | Unified search across memories + tasks |
| `memory_get` | ~500-1000 tokens/item | Full content — **expensive, filter first** |
| `memory_update` | ~50 tokens | Update fields in place — cheap |

**NEVER call `memory_get` without filtering via `memory_search` or `search` first.** Always: search → pick IDs → `memory_get(ids)`. This is 10x more token-efficient than fetching everything.

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Storing everything as `fact` | Use `rule`/`decision` — they get priority in context |
| Searching with exact phrases | Use keywords; the stemmer handles variations |
| Storing duplicates | Search first |
| Missing rationale in decisions | Future agents need the *why*, not just the *what* |
| Skipping scopes | Scopes make search faster |
| Calling `memory_get` without filtering | Search first, then fetch only the IDs you need |
| Deleting decisions/rules to "fix" them | Use `memory_update` to correct — preserve the history |
| Storing code patterns or git history | Derive from codebase/git — don't duplicate in memory |

---

## Related

- **orc-session** skill — session start protocol, recording events
- **orc-tasks** skill — task lifecycle and HITL review
- Built-in prompts: `orc-requirements` (skill) gathers requirements and stores in task body, `orc-report` (skill) builds status summaries from memories and tasks
