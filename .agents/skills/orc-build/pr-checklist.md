# Pull request checklist

## Branch and git hygiene

- Work from an isolated worktree under `.orc/worktrees/<name>` (or `.claude/worktrees/<name>` / `~/.codex/worktrees/`).
- **Never force-push** (`--force` or `--force-with-lease`) and **never rebase** commits already on the remote. Keep the branch current with `git fetch origin master && git merge origin/master` and push normally.
- Pre-push hook runs `bun run ci:pr` and requires a completely clean tracked and untracked working tree matching the pushed commit.

## Preflight before opening the PR

1. Run `bash .agents/skills/orc-build/scripts/pr-preflight.sh` and resolve every warning.
2. Confirm `bun run sdk:generate` is up to date if any API route or schema changed.
3. Confirm matching `docs/docs/` pages are updated for user-visible changes and `bun run docs:build` passes with zero dead links.
4. Confirm `bun run ci:pr` passed at the pushed head commit.
5. If `packages/web/` UI changed, complete the `orc-ui` screenshot gate (desktop dark/light + phone 390px demo-data screenshots attached via `gh pr comment --attach`, never committed).
6. Confirm zero `./.examples/` reference project names, paths, or links appear in commits, code, docs, or PR text.

## PR format

- **State**: ready for review, **never draft**.
- **Title**: `type(scope): subject` (e.g., `feat(chat): render deliveries as collapsible cards`).
- **Issue link**: include `Closes #N` or `Fixes #N` in the body (or reference related issues clearly).
- **Body**: **40 lines or fewer** using only the headings that apply (drop empty sections):

```markdown
## Why
<Problem and linked issue: Closes #N>

## What changed
- <Concise bullet per behavior/contract change>

## Scope
<Packages/surfaces touched and what was explicitly left out>

## Tradeoffs
- <Key design decisions and alternatives considered>

## Blast Radius
<Affected callers, migrations, or rollout notes>

## Verification
- <Tests run, ci:pr status, docs:build, UI screenshots comment link>
```

- **Evidence logs and screenshots belong in PR comments**, never inline in the PR body. Link the evidence comment from `## Verification` when useful.
- Do not commit approval screenshots. Only update `docs/public/screens/` when a `docs/docs/` page references that image.
