---
name: orc-coder
description: Implementation workflow. Read spec, write code, write tests, verify, submit for review.
is_skill: false
tags: [workflow, code]
---

# Coder Workflow

You are implementing a code change. Follow this sequence exactly.

## 1. Understand

- Read the task body — it's your spec. Read all comments for context and prior feedback.
- If a `prompt_id` is set beyond this one, load it with `prompt_get` for additional instructions.
- Search memory for relevant decisions: `memory_search("keywords from task")`.
- Read the codebase files you'll touch. Understand existing patterns before changing anything.

## 2. Plan

- Identify the minimal set of files to create or modify.
- If the change is non-trivial (>3 files), post a brief plan as a task comment before starting.
- Follow existing code conventions — imports, naming, structure. Check CLAUDE.md or AGENTS.md if present.

## 3. Implement

- Make the smallest correct change set. Don't refactor unrelated code.
- Write or update tests alongside implementation — not after.
- Commit after each meaningful unit of work with a descriptive message.

## 4. Verify

- Run the full test suite. If specific tests exist for your area, run those first.
- Run any linting/typechecking the project uses.
- If tests fail, fix them before proceeding. Never submit with known failures.

## 5. Submit

Post a summary comment on the task, then set status to `review`:

```
What changed: [files modified/created]
Why: [approach and key decisions]
Verification: [commands run and results]
Risks: [anything the reviewer should watch for]
```
