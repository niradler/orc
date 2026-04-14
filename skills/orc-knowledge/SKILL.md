---
name: orc-knowledge
description: Use when searching indexed document collections, retrieving documentation or markdown files, managing knowledge collections (add/remove directories), or re-indexing after file changes. Trigger on "search the docs", "find in knowledge base", "index this directory", "what does the docs say about X", or when you need to look up reference material from project documentation.
allowed-tools: ["mcp__orc__knowledge_search", "mcp__orc__knowledge_get", "mcp__orc__knowledge_collections", "mcp__orc__knowledge_collection_add", "mcp__orc__knowledge_collection_remove", "mcp__orc__knowledge_update"]
---

# ORC Knowledge Workflow

ORC's knowledge layer indexes directories of documents (markdown, code docs) and makes them searchable via BM25 full-text search or hybrid BM25+vector search. It is distinct from ORC memory — knowledge is for external reference material, memory is for decisions and discoveries made during work.

## Knowledge vs Memory

| Knowledge | Memory |
|-----------|--------|
| External reference documents (docs, wikis, specs) | Decisions and discoveries from working sessions |
| Indexed from filesystem directories | Written by agents during work |
| Read-only (index reflects filesystem) | Read-write (agents store and update) |
| Searched by content similarity | Searched by keyword/concept |
| `knowledge_search` / `knowledge_get` | `memory_search` / `memory_get` |

Use knowledge when you need to look something up in reference material.
Use memory when you need to recall what was decided or discovered.

---

## Core Workflow

### 1. Search first

```
knowledge_search(query, { collection?, mode?, limit? })
```

Returns: `docid`, `path`, `title`, `snippet`, `score` — compact results for scanning.

- Use `collection` to narrow to a specific set of docs
- `mode: "lexical"` = fast BM25 (default); `mode: "hybrid"` = BM25 + vector reranking (better recall, costs more)
- Never fetch full documents until you've identified the right one from search results

### 2. Fetch full content only when needed

```
knowledge_get(id)
```

`id` is the `docid` (e.g. `#abc123`) or the `path` from search results. Full document content is token-expensive — only call this after you know which document you need.

### 3. List collections

```
knowledge_collections({ project? })
```

Shows all indexed collections with name, path, glob pattern, document count, and last modified time.

---

## Managing Collections

### Add a collection

```
knowledge_collection_add({
  name: "docs",
  path: "/absolute/path/to/directory",
  pattern: "**/*.md",   // default
  project: "my-project" // optional
})
```

- `name` is a short label used to filter searches (`collection: "docs"`)
- `path` must be an absolute path to the directory
- `pattern` controls which files get indexed (default: all `.md` files)
- Indexing runs automatically after adding

### Remove a collection

```
knowledge_collection_remove({ name: "docs" })
```

Removes the collection and its indexed documents. Does not delete files from disk.

### Re-index after file changes

```
knowledge_update({ collections: ["docs"] })  // specific collections
knowledge_update({})                          // all collections
```

Run this after adding, editing, or deleting files in an indexed directory. Returns counts: `indexed`, `updated`, `removed`.

---

## CLI Equivalents

```bash
orc kb search "authentication flow"
orc kb get "#abc123"
orc kb collections
orc kb add docs /path/to/docs --pattern "**/*.md"
orc kb remove docs
orc kb update
orc kb status
```

---

## Token Economics

| Tool | Cost | Use when |
|------|------|----------|
| `knowledge_search` | ~50-100 tokens/result | Always use first — cheap overview |
| `knowledge_get` | ~500-5000 tokens | Full document — **expensive, filter first** |
| `knowledge_collections` | ~50 tokens | See what's indexed |
| `knowledge_update` | ~50 tokens | Trigger re-index after file changes |

**Pattern: search → identify docid → get.** Never call `knowledge_get` blindly. The snippet in search results often has what you need without fetching the full document.

---

## Search Tips

- Use keywords and phrases, not questions: `"JWT refresh token"` not `"how does JWT refresh work"`
- Narrow with `collection` when you know which collection has the answer
- Use `mode: "hybrid"` when lexical search returns poor results — it adds vector similarity
- Scores above 0.5 are usually relevant; below 0.2 are likely noise

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Calling `knowledge_get` without searching first | Always search first, then fetch by docid |
| Using relative paths when adding collections | `path` must be absolute |
| Expecting stale results after file changes | Run `knowledge_update` after filesystem changes |
| Storing agent decisions in knowledge | Use `memory_store` for decisions — knowledge is read-only reference |
| Searching with full sentences | Use keywords; BM25 matches terms, not intent |

---

## Related

- **orc-memory** skill — storing and retrieving decisions, rules, and discoveries made during work
- **orc-session** skill — session start protocol
- **orc-tasks** skill — task lifecycle and HITL review
