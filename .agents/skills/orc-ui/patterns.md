# ORC web component, mobile, and test patterns

## Shared primitives to reuse

Always inspect existing components in `packages/web/src/components/` before creating a new one:

| Need | Shared ORC pattern |
| --- | --- |
| View header | `ViewHeader` — compact title, concise count, optional adjacent `HelpPopover`, main action |
| Search & filters | Aligned filter region + `ResponsiveFilters` (retains phone filter state and active count) |
| Long configuration forms | `FormDialog` (up to `960px`, multi-column desktop, single ordered phone column, scrollable body, sticky footer, errors above footer, dirty-state protection on Cancel/Escape/backdrop/Back/reload, committed close callback, tabbed steps with cross-tab validation) |
| Field/section guidance | `HelpPopover` (<= 260 chars, hover + focus + tap) |
| Icon-only buttons | Shared `Button` / `ActionHelp` wrapper (accessible name, hover/focus tooltip, touch hold-to-explain without executing) |
| Secondary disclosures | Quiet collapsed summary row -> slim expanded rows -> editors on demand |
| Markdown rendering | Shared `Markdown` component (with chat/link preview props as appropriate) |

## Chat and session list rules

- Show one selected conversation at a time; align assistant and composer columns (including `16px` phone insets).
- Session history has exactly two sections: **Recents** (flat list, newest activity first) and **Projects** (grouped by project + Unassigned). Do not add Open/Earlier, source, or date groups.
- Opening a session keeps its position; only new activity moves a row up. While hovered or keyboard-focused, freeze row order and surface a quiet `"N updated"` control instead of jumping rows under the pointer.
- Filters (`All`, `Needs you`, `Working`, `Done`) narrow the active section without introducing extra sections.
- Keep agent and model pickers in the composer; infrequent conversation actions live in one named menu. Provider/model catalogs come from live API contracts — never hardcode preview model lists.
- Never nest interactive elements (e.g., place a session `<a href>` link as a sibling of a card `<button>`, never inside it).

## Mobile and phone (`< 768px`) rules

- One useful working pane at a time; navigation lives in the drawer; detail surfaces fill the viewport width.
- Never squeeze multi-column tables onto a phone; default repeated lists (like Tasks) to slim title-first rows with a single named row-action menu.
- **Notifications are a full page on phone (`/notifications`)**, never a modal, with a compact back bar and inline human-request answer cards.
- **Chat on phone** is a full-screen sheet with one compact header row (`Sessions` trigger, truncated title + `project · host` subtitle, actions). Pending permissions and questions stay pinned above the composer with `44px` answer controls; opening chat must not force the on-screen keyboard.
- Every view/tab/filter/detail URL must be shareable and restore cleanly on reload and browser Back/Forward.

## Web unit and Playwright E2E structure

- **Pure helpers belong in `packages/web/src/lib/`** so Bun unit tests in `packages/web/tests/unit/*.test.ts` can import them via relative paths (`../../src/lib/...`) without requiring Vite `@/` path aliases.
- **Playwright specs live in `packages/web/tests/e2e/*.e2e.ts`**:
  - Select elements exclusively by `data-testid`.
  - Seed isolated synthetic data per test (use `crypto.randomUUID()` for `chatThread` IDs since URL links validate UUID format).
  - Run one spec quickly with:

```bash
PW_SHARDS=1 bun packages/web/scripts/run-e2e.ts tests/e2e/<spec>.e2e.ts
```

  - Verify zero horizontal overflow on phone (`390x844`): `document.documentElement.scrollWidth <= document.documentElement.clientWidth`.
  - Add `@sanity` to the test title when adding a new critical user flow.
