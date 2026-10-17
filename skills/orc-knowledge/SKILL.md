---
name: orc-knowledge
description: Use when looking up reference material in ORC knowledge bases (uploaded files, registered folders), answering a question with cited evidence, or writing to a knowledge base agents may edit. Trigger on "search the docs", "what do our docs say about X", "cite the runbook".
allowed-tools: mcp__orc__kb_list mcp__orc__kb_search mcp__orc__kb_evidence mcp__orc__kb_read mcp__orc__kb_documents mcp__orc__kb_write mcp__orc__kb_maintenance
---

# ORC Knowledge Workflow

Knowledge bases (KBs) hold human reference documents. A KB belongs to a project or is global. Its documents are uploaded files (PDF, Word, PowerPoint, Excel, HTML, CSV, Markdown, text), Markdown written in the dashboard, or copies of files from a registered folder. ORC never writes the folder; a copy follows its file until someone edits it in ORC. Search combines exact title/path matches, full-text and, when embeddings are configured, vectors.

KBs are different from memory and the wiki:

| Knowledge bases                      | Memory / Wiki                                     |
| ------------------------------------ | ------------------------------------------------- |
| Human reference documents and files  | What agents decided, discovered and learned       |
| Edited from the sources each KB allows | Written by agents (`memory_create`, `wiki_write`) |
| `kb_search` / `kb_evidence` / `kb_read` | `memory_list` / `wiki_search`                  |

Every read is counted per document and per source (mcp, api, cli, ui), so pass `session_id` when you have one.

## Core workflow

### 1. Search

```
kb_search({ query, project?, scope?, kb_ids?, labels?, mode?, limit? })
```

Returns documents with short passages and citation handles `kb:<doc>@<rev>#<n>`. By default it searches the project's KBs plus global ones; `scope: "all"` searches every project. `mode: "auto"` uses vectors when embeddings are ready.

### 2. Answer with evidence

```
kb_evidence({ query, token_budget? })
```

Returns a budgeted pack of cited passages from several documents. Cite the handles in your answer. Passages from agent-written summaries are flagged as derived, so don't count them as independent corroboration.

### 3. Read only what you need

```
kb_read({ citation: "kb:01J...@3#4" })    // one passage
kb_read({ id, heading: "Rollback" })      // one section
kb_read({ id })                           // whole document, can be long
```

A handle names a revision. If the document has changed since, read it again by ID.

### 4. Browse

```
kb_list({ project? })                     // KBs with document counts; "editable" or "read-only" for you
kb_documents({ kb_id, folder?, label? })  // documents with path, labels, revision, reads
```

## Writing documents

Each KB lists the call sources that may change its documents (`editable_by`: ui, cli, api, mcp). Your MCP calls are source `mcp`; `kb_list` marks each KB "editable" or "read-only" for you. Reading and search are open everywhere. Agents cannot change KB settings, so ask a person when a KB you need is read-only.

```
kb_write({
  kb_id, title, content,             // create: Markdown
  path?, labels?,                    // e.g. runbooks/deploy.md
  note,                              // why, kept in the revision history
  derived_from?: [document_ids],     // sources this summarises; it goes stale when they change
})
kb_write({ document_id, expected_revision, content, note })   // replace
```

Every write is a new revision recorded with your session, so nothing is lost. Never list the document you are rewriting in `derived_from`. A stale `expected_revision` is a conflict: read the document again and redo the change. `kb_maintenance({ kb_id })` lists stale derived documents, failed files and links to missing documents.

## CLI equivalents

```bash
orc kb list
orc kb search "rollback procedure"
orc kb evidence "how do we rotate the signing key"
orc kb get kb:01J...@3#4
orc kb add Runbooks ./docs/*.pdf
orc kb sources add Runbooks ./handbook
orc kb editable-by Runbooks ui,cli,api
orc kb usage <kb-id>
orc kb status
```

## Common mistakes

| Mistake                                   | Fix                                                        |
| ----------------------------------------- | ---------------------------------------------------------- |
| Reading whole documents first             | Search, then read a citation or heading                    |
| Answering without handles                 | Use `kb_evidence` and cite `kb:` handles                   |
| Storing your own decisions in a KB        | Use `memory_create` or `wiki_write`                        |
| Retrying a write after a conflict as-is   | Read the current revision and reapply your change          |
| Searching with whole questions in lexical mode | Use key terms; `mode: "auto"` adds vectors when ready |

## Related

- **orc-memory**: storing decisions, rules and discoveries
- **orc-wiki**: compiling verified lessons
- **orc-session**: session start and end
