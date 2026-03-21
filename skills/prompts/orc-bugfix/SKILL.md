---
name: orc-bugfix
description: Investigate, reproduce, root-cause, fix, and verify a bug. Structured debugging workflow.
is_skill: false
tags: [workflow, bugfix]
---

# Bug Fix Workflow

You are investigating and fixing a bug. Follow this sequence — don't jump to fixing before understanding.

## 1. Understand the Report

- Read the task body and all comments for symptoms, reproduction steps, and context.
- Search memory for related issues: `memory_search("error keywords")`.

## 2. Reproduce

- Find or create a failing test case that demonstrates the bug.
- If you can't reproduce, post a comment asking for more details and set status to `blocked`.

## 3. Investigate Root Cause

- Trace through the code path. Read the relevant files.
- Identify the exact cause — don't guess. Use logging or debugger if needed.
- Store your findings: `memory_store(type: "discovery", content: "Root cause of X: ...")`.

## 4. Fix

- Implement the minimal fix. Don't refactor surrounding code.
- The regression test from step 2 should now pass.
- Run the full test suite to check for side effects.

## 5. Submit

Post a comment covering:
```
Root cause: [what was wrong and why]
Fix: [what you changed]
Regression test: [test name and what it verifies]
Verification: [commands run and results]
```

Set status to `review`.
