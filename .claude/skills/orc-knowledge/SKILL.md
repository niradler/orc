---
name: orc-knowledge
description: Use when storing project knowledge, decisions, rules, or discoveries in ORC, when searching for past context, when recalling architectural decisions or conventions, when multiple agents need shared knowledge, or when building a persistent knowledge base. Trigger on "remember", "recall", "what did we decide", "store this", when making architectural decisions, or when you need past context before starting work.
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

### Before storing, always search first to avoid duplicates.

---

## When to Search

- Before starting work — check what decisions have been made
- When you need to understand past context or rationale
- When the user asks "what did we decide about X"
- When you encounter something that might have been solved before

The 3-layer cascade (porter stemming → trigram → LIKE) finds things even when wording varies. Use keywords, not exact phrases.

The unified `search` tool searches across both memories and tasks in one call — use it when you're not sure where the information lives.

---

## Scopes

Use scopes to organize: `architecture`, `code-style`, `api`, `security`, `database`, `gateway`, `mcp`, `ops`, `bugs`. Scopes make search faster on large stores.

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

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Storing everything as `fact` | Use `rule`/`decision` — they get priority in context |
| Searching with exact phrases | Use keywords; the stemmer handles variations |
| Storing duplicates | Search first |
| Missing rationale in decisions | Future agents need the *why*, not just the *what* |
| Skipping scopes | Scopes make search faster |
