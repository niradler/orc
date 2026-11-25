---
name: orc-build
description: Execute end-to-end feature and bugfix development in ORC — repo structure, code craft, private local reference research, scoped verification, and pull request creation. Use when implementing features, fixing bugs, verifying changes, or opening pull requests in the ORC repository.
---

# ORC build workflow

One continuous builder lifecycle from issue to merge-ready pull request. Keep each rule in one place and load the companion reference only for the phase you are in.

## SDLC checkpoints

Copy and track progress:

```text
- [ ] 1. Explore & align (issue, callers, optional local ./.examples/ comparison, blockers/trade-offs)
- [ ] 2. Isolate (dedicated worktree under .orc/worktrees/<name> off origin/master)
- [ ] 3. Implement (code-craft.md; also load orc-ui if touching packages/web/)
- [ ] 4. Verify (verify.md: targeted tests -> ci:changed -> ci:pr)
- [ ] 5. UI approval gate (if UI changed: orc-ui demo-data desktop + phone screenshots for Nir)
- [ ] 6. Ship PR (pr-checklist.md + scripts/pr-preflight.sh -> ready PR, never draft)
```

### 1. Explore and align

- Read the issue and trace every affected caller, schema, route, and test before editing.
- When comparing architectures, interaction models, or edge cases, you may inspect local reference projects in `./.examples/` (see [code-craft.md](code-craft.md#private-local-references-examples) for the strict zero-leak rule).
- If you hit a blocker, a real design trade-off, or missing approval for creating/deleting files, stop and surface concise options to Nir before writing code.

### 2. Isolate the workspace

Create one dedicated worktree in an allowed location off an up-to-date `origin/master`:

```bash
git fetch origin master
git worktree add -b <type>/<short-name> .orc/worktrees/<name> origin/master
```

Allowed worktree roots: `.orc/worktrees/<name>`, `.claude/worktrees/<name>`, or `~/.codex/worktrees/`. Never create worktrees beside the repo, under `.worktrees/`, or under `.claude/checkouts/`.

### 3. Implement cleanly

Follow [code-craft.md](code-craft.md) for package boundaries, Zod/DB/SDK contracts, docs-over-comments, and code quality. If your change touches `packages/web/`, also follow the `orc-ui` skill from the start so desktop, phone, and `DESIGN.md` rules are built in rather than retrofitted.

### 4. Verify before push

Follow [verify.md](verify.md):
- Iterate fast with single-file tests and `bun run ci:changed` (no browser).
- Run `bun run ci:pr` as the merge gate (`ci:full` is pre-release only, never a merge gate).
- Update matching `docs/docs/` pages for any user-visible change and run `bun run docs:build`.

### 5. Ship the pull request

Run the preflight script before pushing or opening the PR:

```bash
bash .agents/skills/orc-build/scripts/pr-preflight.sh
```

Then follow [pr-checklist.md](pr-checklist.md) for commit hygiene, PR title/body format, and attaching evidence or screenshots in PR comments.

## References and companion skills

- [code-craft.md](code-craft.md) — package boundaries, contracts, docs over comments, private `./.examples/` rules
- [verify.md](verify.md) — test ladder, CI scoping, Playwright E2E, server binding, teardown hygiene
- [pr-checklist.md](pr-checklist.md) — PR template, branch rules, docs and SDK sync
- `orc-ui` — web design system, shared components, and Nir's screenshot approval gate
- `orc-code-review` — independent review protocol (never self-approve)
- `orc-maintenance` — post-merge worktree cleanup, disk upkeep, orphan screenshot audit, docs deploy

## Keep this skill true

When a verification command, path rule, or workflow trap changes, update this skill or its references in a follow-up PR so future runs do not repeat the mistake.
