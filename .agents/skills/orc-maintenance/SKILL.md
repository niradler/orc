---
name: orc-maintenance
description: Perform recurring ORC repository upkeep — worktree cleanup, bounded disk hygiene, orphan docs screenshot audits, branch syncing, dependency and workspace version alignment, and VitePress docs builds/deploys. Use when cleaning up after merges, freeing disk space, auditing docs screenshots, updating dependencies, or deploying docs.
---

# ORC repository maintenance

Keep the workspace lean, clean, and consistent without breaking active work or rewriting shared git history.

## Start with a read-only audit

Run the diagnostic audit first (never deletes anything):

```bash
bash .agents/skills/orc-maintenance/scripts/audit-repo.sh
```

It reports:
- Worktrees outside allowed paths or already merged into `origin/master`.
- Unreferenced images in `docs/public/screens/`.
- Workspace version drift across `package.json` and `packages/*/package.json`.
- Disk usage of local worktrees and Playwright/test artifact directories plus free disk space.

## Maintenance rules

- **Worktree discipline**: keep worktrees only under `.orc/worktrees/<name>`, `.claude/worktrees/<name>`, or `~/.codex/worktrees/`. Remove a worktree you created once merged, respecting Nir's deletion rules (surface cleanup commands for confirmation rather than running destructive `rm` silently).
- **Bounded disk**: reuse active checkouts and existing operational scripts; never create duplicate dependency trees, retry worktrees, or extra browser profiles. Check available disk space before large builds.
- **Git sync**: keep branches current by merging `origin/master` (`git fetch origin master && git merge origin/master`). **Never force-push** (`--force` or `--force-with-lease`) and **never rebase** pushed commits.
- **Local server binding**: bind all local dev, test, fixture, and preview servers explicitly to `127.0.0.1` (`vitepress dev docs --host 127.0.0.1`, `vitepress preview docs --host 127.0.0.1`), verify listener addresses, and avoid firewall prompts.

## Detailed runbooks

Read [runbooks.md](runbooks.md) for step-by-step procedures on:
- Worktree pruning and recovery
- Orphan `docs/public/screens/` cleanup
- Dependency updates (`bun install`, `bun run knip:deps`, workspace version alignment)
- Docs build and `gh-pages` deployment (`bun run docs:build`, `bun run docs:deploy`)

## Keep this skill true

Update `runbooks.md` or `scripts/audit-repo.sh` when repo paths, docs deploy scripts, or external CLI runtime dependencies change.
