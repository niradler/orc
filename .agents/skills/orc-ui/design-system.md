# ORC design system tokens and visual rules

Authoritative contract: [DESIGN.md](../../../DESIGN.md). Runtime tokens live in `packages/web/src/index.css`; semantic Tailwind aliases and fonts live in `packages/web/tailwind.config.ts`.

## Surface and palette discipline

- **Unified canvas**: sidebar, header, and main workspace share the same base background (`#000000` dark Activity direction; light-mode equivalents via CSS tokens). Never assign a darker sidebar or nested box fills just to create regions.
- **Approved dark tokens**: shell `#000000`, hover `#141414`, selection `#242424`, content `#E5E5E5`, secondary text `#A3A3A3`, primary action fill `#DEDEDE`.
- **Restrained semantics**: status dots are `6px` at full opacity (neutral todo, blue `#8AB4F8` doing/queued, amber review/waiting, rose/error blocked/failed, green done). Use subtle semantic text or a `2px` accent border rather than loud filled badges.
- **Grayscale test**: hierarchy, primary actions, selected state, and errors must remain clear if status colors are removed.
- **Borders and depth**: prefer alignment and spacing over boxes. Use `1px` subtle dividers where structure requires it. Reserve shadows strictly for floating overlays (popovers, menus, dialogs). Never use glow, decorative gradients, glassmorphism, or persistent pulsing outlines.

## Shapes, controls, and typography

- **Border radii**: `4px` tags, `6px` controls, `8px` necessary panels, `12px` dialogs. Do not turn every filter into a pill or nest rounded cards inside rounded cards.
- **Control sizing**: `32px` desktop controls with `13px` labels; `44px` minimum touch hit area on phone/tablet (`34px` painted primary face inside the `44px` hit target is allowed); `16px` input font size on mobile to prevent iOS auto-zoom.
- **Titles**: `16px` for dense list titles; `22px` for standalone page titles.
- **Action hierarchy**: one neutral filled primary action per working area; secondary actions are ghost or restrained outline; infrequent row actions live in a contextual menu; destructive actions are explicit and visually separated.
- **Focus**: visible `2px` focus outline independent of hover or color perception.

## Copy budget and `HelpPopover`

- Do not place explanatory paragraphs below form fields or section headings.
- Put optional guidance, format hints, and examples in the shared `HelpPopover` beside its subject:
  - Opens on hover, keyboard focus, and tap/activation.
  - Stays within the viewport in both dark and light themes, dismissible via Escape and outside click/tap.
  - Keep popover body to 1–2 short sentences (~260 chars max); verify with:

```bash
bun --cwd packages/web test ./tests/unit/copy-budget.test.ts
```

- Always keep visible: field labels, current values, concise status, validation errors, permission/approval decisions, and essential warnings needed before an action.

## Feedback, toasts, and motion

- Transitions stay short (`120–180ms`), user-triggered, and honor `prefers-reduced-motion`.
- **Two-tier notifications**:
  - **Needs you** (question, approval, failure): active toast persisting until acted on or dismissed, with inline actions.
  - **Done**: passive silent toast (~6s, pauses on hover/focus, discoverable in list).
  - Never notify for the session already in view; announce via polite live region without stealing focus.
- Reversible list actions (settle, pin, snooze, mark seen) apply immediately with ~5s Undo + `Ctrl/Cmd+Z`; reserve confirmation dialogs for destructive or irreversible operations.
