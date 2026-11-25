# Repository maintenance runbooks

## 1. Worktree cleanup

Allowed worktree locations:
- `.orc/worktrees/<name>`
- `.claude/worktrees/<name>`
- `~/.codex/worktrees/<name>`

Never place worktrees beside the repo, under `.worktrees/`, or under `.claude/checkouts/`.

Inspect active worktrees:

```bash
git worktree list
git branch --merged origin/master
```

After a branch merges and you confirm no uncommitted work remains in that worktree, remove it cleanly (or hand the command to Nir if deletion requires approval):

```bash
git worktree remove .orc/worktrees/<name>
git branch -d <merged-branch>
git worktree prune
```

## 2. Bounded disk and test artifact cleanup

- Check free disk space before large desktop/CLI builds (`df -h .`).
- Reuse active checkouts and existing operational scripts; never duplicate `node_modules` or browser profiles for retries.
- Tests must clean owned temporary directories and compiled binaries in teardown, including failure paths, after child processes exit.
- Common local scratch paths safe to retire once verified:
  - `packages/web/test-results/`
  - `packages/web/playwright-report/`
  - `output/playwright/`
  - `/tmp/orc-*-screens/`

## 3. Orphan `docs/public/screens/` audit

Every image committed in `docs/public/screens/` must be referenced by at least one `docs/` page (and captured from demo data, never a real workspace).

Run `bash .agents/skills/orc-maintenance/scripts/audit-repo.sh` to list unreferenced files, or check directly:

```bash
for img in docs/public/screens/*; do
  base="$(basename "$img")"
  rg --fixed-strings "$base" docs --glob '!docs/public/screens/**' >/dev/null || echo "ORPHAN: $img"
done
```

Remove confirmed orphans in a cleanup PR (never delete images still referenced by docs).

## 4. Branch sync, dependencies, and workspace versions

- Sync a feature branch with master without rewriting history:

```bash
git fetch origin master
git merge origin/master
```

- Install/update dependencies via Bun workspaces only:

```bash
bun install
bun run knip:deps
```

- Keep `version` aligned across root `package.json` and every `packages/*/package.json`.
- Keep CLI runtime dependencies that resolve files relative to their own package external to the bundle and declared in `packages/cli/package.json` (`@anthropic-ai/claude-agent-sdk`, `sqlite-vec`, `zod`, enforced by `packages/cli/scripts/validate-package.ts`).

## 5. Docs build and deployment

- Local preview (explicit loopback binding):

```bash
bun run docs:dev
```

- Validate all internal relative links (`./cli.md`) before merging:

```bash
bun run docs:build
```

- Publish to `https://niradler.github.io/orc/` (`gh-pages` branch) **only from `master` after a docs PR merges**:

```bash
git checkout master
git pull origin master
bun run docs:deploy
```
