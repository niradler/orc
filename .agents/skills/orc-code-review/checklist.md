# Independent PR review checklist

## 1. Gate and verification truth

- [ ] PR head SHA matches the commit tested by `bun run ci:pr` (GitHub `CI` workflow or local reproduction against the exact head checkout).
- [ ] Failing-first bugfix claims actually fail before the fix commit and pass with it.
- [ ] Every acceptance criterion in the linked issue has a behavior test exercising real SQLite/processes (not mocked internals).
- [ ] No skipped tests (`.skip`), added retries to hide flakes, or loosened assertions.
- [ ] Tests run with isolated `HOME` / `ORC_API_BASE` and clean up owned temp dirs and binaries in teardown (including failure paths after children exit).

## 2. Correctness, contracts, and blast radius

- [ ] Traced all connected callers across `@orc/core`, `@orc/db`, `@orc/agent-runtime`, `@orc/api`, `@orc/mcp`, `@orc/sdk`, and `@orc/web`.
- [ ] DB schema changes are idempotent on existing `~/.orc/orc.db` databases (safe `PRAGMA table_info` + `ALTER TABLE` or additive migration).
- [ ] API route or schema changes include regenerated `packages/sdk/src/openapi.gen.ts` (`bun run sdk:generate`).
- [ ] Local dev/test/fixture/preview servers bind explicitly to `127.0.0.1` (never `0.0.0.0`, `::`, or bare `--host`).
- [ ] Knowledge/memory/KB changes obey `docs/internal/knowledge-loop.md` (no KB content or summaries injected into startup context or runner prompts).
- [ ] Security boundaries intact: no secrets in code/logs/command args, no unvalidated paths/URLs, no unsafe shell interpolation.

## 3. Code craft, docs, and confidentiality

- [ ] No narrating inline comments (code is self-explanatory; user-visible behavior lives in `docs/docs/`, internals in `docs/internal/`).
- [ ] User-visible changes (CLI flags, MCP tools, REST routes, config keys, env vars, UI behavior) update the matching `docs/docs/` page, register any new page in `docs/.vitepress/config.ts`, and pass `bun run docs:build`.
- [ ] No barrel re-exports, top-level imports respected, `bun run check` and `bun run knip:deps` clean.
- [ ] **Zero `./.examples/` leak**: no local reference project name, repo, folder, URL, or path appears anywhere in diff, commit messages, PR title/body, or PR comments.

## 4. UI and `DESIGN.md` (when `packages/web/` changed)

- [ ] Matches `DESIGN.md`: quiet unified surface, no extra card-in-card chrome or loud filled badges, hierarchy survives grayscale.
- [ ] Secondary lists default to quiet collapsed summary -> slim expanded rows -> editors on demand.
- [ ] Long guidance lives in `HelpPopover` (`<= 260` chars, `copy-budget.test.ts` green) working on hover, keyboard focus, tap, and Escape/outside dismiss.
- [ ] Phone (`< 768px`): `44px` touch targets, `16px` input text, zero horizontal overflow, same actions available without desktop-only modals.
- [ ] E2E selectors use `data-testid` only; new critical flows carry `@sanity`.
- [ ] Desktop (dark + light where relevant) and phone (`390px`) **demo-data** screenshots are attached via `gh pr comment --attach`, **never committed** to the branch.
- [ ] Any updated `docs/public/screens/` image is referenced by a docs page and captured from demo data.
- [ ] Nir's visual review of the attached screenshots is explicitly noted as the remaining human UI gate.

## 5. PR format

- [ ] PR is **ready for review** (not draft).
- [ ] Title follows `type(scope): subject`.
- [ ] Body is `<= 40` lines with applicable headings (`Why`, `What changed`, `Scope`, `Tradeoffs`, `Blast Radius`, `Verification`), links the issue (`Closes #N` / `Fixes #N`), and keeps verbose logs/screenshots in PR comments.
