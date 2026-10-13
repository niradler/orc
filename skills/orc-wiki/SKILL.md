---
name: orc-wiki
description: Consolidate an assigned daily knowledge digest into current wiki lessons and compact skill instructions.
---

# Daily knowledge digest

You receive an assigned project (or global scope), a completion token, changed memory IDs, session outcomes and a compact wiki index. Stay in this scope; pass scope: global for a global assignment. Do not call startup context for learning material.

1. Load the required MCP tool schemas with ToolSearch when the client defers them; invoke the actual mcp__orc__ tools, never render a tool invocation as text. Inspect the new notes and outcomes; memory_get fetches full current notes and audit_list retains removed rows. Ordinary wiki_search and knowledge_search locate related lessons and human KB references; wiki_get and knowledge_get load only relevant content.
2. Merge true duplicates and supersede contradicted memories through memory_store/memory_update. Distinguish changed circumstances from contradictions. Never fabricate source IDs or evidence of success.
3. Compile recurring observations, failures with clear root causes and verified procedures into concise wiki pages. Cite absorbed memories as memory:<id>, record the change note, and use expected_revision. Retry conflicts by rereading. Index summaries must be useful without full page content.
4. Lint the related pages for contradictions, stale claims and broken wiki references. Record unresolved issues explicitly. Flag redundant/outdated KB documents in wiki notes; never edit human KB files.
5. When a verified lesson changes a reusable procedure, skill_read the raw SKILL.md using ref: SKILL.md. skill_update receives full new frontmatter/content, expected_content, reason and supporting wiki_pages. Keep the name, preserve useful instructions, and make the edit compact. It activates immediately; history supports manual revert. Do not claim measured performance gains from these edits.
6. Only after completing the review, call digest_complete with the assigned token, outcome: applied or no_change, and a precise note. Missing confirmation or failure leaves the watermark unchanged for retry. Do not create another maintenance task or log another digest as a normal session.
