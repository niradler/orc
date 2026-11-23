---
name: orc-code-review
description: Perform an independent, evidence-backed pull request review in ORC at the exact PR head SHA. Use when reviewing a pull request, auditing branch changes against repo standards, verifying CI gates and UI screenshot evidence, or producing a formal review verdict.
---

# ORC independent code review

Evaluate the actual PR artifact cold at its exact head commit. The reviewer **never edits files, never implements fixes, and never approves its own work**.

## Review workflow

Copy and track progress:

```text
- [ ] 1. Gather PR snapshot & CI truth at exact head SHA (scripts/review-context.sh <pr>)
- [ ] 2. Verify ci:pr gate at PR head (never trust builder's local claim alone)
- [ ] 3. Reproduce failing-first claims and run scoped tests against the real head
- [ ] 4. Audit correctness, contracts, docs, comments, and zero ./.examples leak (checklist.md)
- [ ] 5. If UI changed, audit DESIGN.md compliance and attached desktop/phone screenshots
- [ ] 6. Emit exactly one outcome with file:line evidence (verdict-template.md)
```

### 1. Gather PR context at the exact head SHA

```bash
bash .agents/skills/orc-code-review/scripts/review-context.sh <pr-number>
```

The script fetches `headRefOid`, draft status, title/body format, CI check runs at the head SHA, changed files, SDK/docs drift signals, attached screenshot comments, and scans the PR diff for any accidental local `./.examples/` leaks.

### 2. Verify the merge gate at the exact head

- Confirm GitHub's `CI` job (which runs `bun run ci:pr` on the `homelab` runner) passed **at the exact PR head SHA**.
- Note: `.github/workflows/ci.yml` restricts jobs to `github.actor == 'niradler' && github.triggering_actor == 'niradler'`. If a bot pushed the head commit and CI skipped, run `bun run ci:pr` locally against that exact head commit (or request Nir to dispatch CI) before approving.
- Never approve on stale CI from an earlier commit.

### 3. Inspect code and behavior deeply

Walk through [checklist.md](checklist.md):
- Verify every acceptance criterion has real behavior test coverage (real SQLite/processes, no mocking the unit under test).
- Check connected callers, Zod schemas, DB migration idempotency, SDK regeneration, MCP tool contracts, and `docs/docs/` updates.
- Verify comment hygiene (no narrating comments) and zero `./.examples/` reference names/paths/links in code, commits, docs, or PR text.
- For UI changes, verify `DESIGN.md` rules, `copy-budget.test.ts`, attached demo-data desktop + phone screenshots (`gh pr comment --attach`, none committed), and that Nir's visual approval gate is explicitly preserved.

### 4. Report exactly one verdict

Use [verdict-template.md](verdict-template.md) and return **one** outcome:
- `approved` — head SHA verified green, all criteria & contracts proven, no blocking defects (note if Nir's UI visual approval remains the human gate).
- `changes_requested` — concrete blocking defects with `file:line` references and exact reproduction/fix expectations.
- `insufficient_evidence` — missing head-SHA `ci:pr` run, missing UI screenshots, unverified repro claim, or draft PR.

## References and scripts

- [checklist.md](checklist.md) — complete engineering, contract, security, UI, and PR format audit criteria
- [verdict-template.md](verdict-template.md) — canonical output format for `approved`, `changes_requested`, and `insufficient_evidence`
- `scripts/review-context.sh` — automated PR metadata, CI head-SHA, format, screenshot, and leak pre-check

## Keep this skill true

When a real review catches a recurring bug class or false pass, add it to `checklist.md` in a follow-up PR.
