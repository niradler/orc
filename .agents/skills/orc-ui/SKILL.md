---
name: orc-ui
description: Design, build, test, and visually verify ORC web UI changes following DESIGN.md, shared React/Tailwind patterns, desktop and phone parity, and Nir's mandatory screenshot approval gate. Use when creating or modifying anything in packages/web, styling, layouts, components, or reviewing UI states.
---

# ORC UI craft and visual approval

ORC is a calm, precise daily coding-agent workspace. Content and current work carry the emphasis; chrome stays quiet. Read [DESIGN.md](../../../DESIGN.md) before substantial UI work and load the companion reference for your current step.

## UI development checklist

```text
- [ ] 1. Align with design-system.md (tokens, density, elevation, HelpPopover copy budget)
- [ ] 2. Reuse ORC primitives from patterns.md (ViewHeader, FormDialog, ResponsiveFilters, ActionHelp)
- [ ] 3. Guarantee phone (<768px) parity (44px touch targets, 16px inputs, zero horizontal overflow)
- [ ] 4. Add/update unit tests (packages/web/tests/unit/) and data-testid Playwright E2E specs
- [ ] 5. Capture populated demo-data screenshots (desktop 1440px dark/light + phone 390px + key states)
- [ ] 6. Visually inspect every screenshot yourself and fix defects before uploading
- [ ] 7. Attach screenshots via scripts/attach-screenshots.sh and flag Nir's visual signoff gate
```

## Non-negotiable rules

- **Calm surfaces**: sidebar, header, and main canvas share the same base background. No layered card-in-card dashboard boxes, no decorative gradients, glow, glass effects, or filled pill noise. Hierarchy must survive grayscale.
- **Compact disclosure**: secondary lists start as a quiet collapsed summary, expand to slim rows, and open editors on demand.
- **Help lives in `HelpPopover`**: keep long explanations and field guidance behind an info icon (`<= 260` characters, enforced by `packages/web/tests/unit/copy-budget.test.ts`), working on hover, keyboard focus, tap, and Escape/outside dismiss. Keep labels, values, concise status, validation errors, and essential action warnings visible.
- **Desktop and phone parity**: same actions and logic on both. Phone defaults to compact lists, full-width detail sheets, 44px touch targets, and `/notifications` as a full page (never a modal).
- **No UI PR is done without Nir's visual signoff**: capture synthetic demo-data screenshots (never real workspace data), inspect them yourself, attach them with `gh pr comment --attach`, and never commit approval screenshots into git.

## References and scripts

- [design-system.md](design-system.md) — palette tokens, typography, shapes, spacing, elevation, and `HelpPopover` copy budget
- [patterns.md](patterns.md) — shared ORC components, forms, chat/session list exceptions, mobile rules, and unit/E2E test structure
- [screenshot-gate.md](screenshot-gate.md) — demo-data capture recipe, self-inspection checklist, and Nir's visual approval workflow
- `scripts/attach-screenshots.sh` — validates local screenshots are untracked and uploads them to a PR via `gh pr comment --attach` with the standard demo-data and signoff header

## Keep this skill true

When `DESIGN.md` approves a new shared component, token refinement, or phone pattern, update `design-system.md` or `patterns.md` in the same or follow-up PR.
