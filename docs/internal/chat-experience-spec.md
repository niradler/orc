# Chat experience wave 1-3

Status: waves 1 and 2 delivered (#361, #363, #364); wave 3 delivered on
`feat/chat-items-windowing` (#376). Owner decisions locked 2026-11-15; this
document records them, it does not re-open them.

## Current state

- `ChatActivity` (`packages/core/src/chat.ts`) has exactly three kinds:
  `thinking`, `tool`, `status`. Every item carries `id`; `appendChatActivity`
  merges tool events by id and caps the list at 200.
- A turn is `ChatTurn` (`startedAt`, `finishedAt`, `durationMs`, `outcome`). The
  server demotes buffered assistant text to a `narration` event when the agent
  starts a tool call (`packages/api/src/routes/chat.ts` emit loop), so the final
  answer stays separate from pre-tool prose.
- The transcript UI renders each assistant turn as one collapsed summary line
  (`foldTurn`/`foldLabel` in `packages/web/src/lib/chat-activity.ts`) with the
  activity list inside. Tool rows are kinded in
  `packages/web/src/lib/chat-tools.ts` (`edit` / `command` / `lookup` /
  `generic`) from the tool name and input, and only edits produce diffs.
- Plans have no representation. ACP `session/update` `plan` entries are joined
  into a `system_status` string (`packages/agent-runtime/src/acp.ts`), and Codex
  `turn/plan/updated` entries are joined the same way
  (`packages/agent-runtime/src/codex-app.ts`). Nothing structured reaches the
  transcript, so no checklist can be rendered.
- The assistant message does not record which model produced it; the model is
  only on `thread.config.model`, and switching models mid-session leaves no
  record in the transcript.
- Header and meta: `ChatPanel.tsx` owns the header, `ChatConversationInfo` (in
  `ChatControls.tsx`) owns the settings sheet with a Session analytics tab, and
  `ChatMessageActions.tsx` renders duration beside copy/fork. Context and cache
  figures live only in that analytics tab.
- Unknown activity kinds: the discriminated union rejects them, `ChatStore.get`
  parses stored threads with `ChatThreadSchema.parse` (so one unknown item throws
  for the whole thread), and `ChatActivityList` silently drops items that fail
  `safeParse`.

## Normalized-item policy

1. **One provider-agnostic vocabulary.** Chat renders kinds, not provider
   event names. `tool`, `thinking`, `status` and now `plan` mean the same thing
   whatever agent produced them.
2. **A new behavior is a new kind.** Never encode a new concept as text in
   `status`. `status` is for provider-independent prose (a rule gap, a stopped
   turn), not for structured data the UI could render.
3. **Adapters normalize, the UI does not guess.** Provider mapping lives in
   `packages/agent-runtime` (and the provider-specific readers it calls). The web
   layer maps a kind to a renderer; it does not detect providers.
4. **Never invent progress.** If a provider emits no plan, turn, or tool signal,
   the adapter emits nothing. No synthesized steps, no inferred statuses.
5. **Identity and nesting now, paging later.** Every item has a stable `id` and
   an `ordinal`; `parentId` reserves nesting (a tool call inside a plan step).
   Paging and history windows are wave 3, and nothing depends on them yet.
6. **Unknown kinds survive.** A kind this build does not know must not throw and
   must not be dropped on re-save. It is kept as a `provider` passthrough
   (`{ kind, id, data }`) beside the typed activity, so an older client can save
   a newer session without losing the agent's data.
7. **Additive only.** New fields are optional, so stored transcripts keep
   parsing and no migration runs.

## Wave 1 — contracts and adapters (S1) + rendering (S2, S3)

S1 merges first; S2 and S3 code against its contract:

```ts
ChatActivity = thinking | tool | status
  | { type: "plan"; id: string; title?: string;
      entries: { id: string; status: "pending"|"in_progress"|"completed"|"failed";
                 content: string }[] }
ChatMessage += model?: string          // additive, no migration
ChatItem = { id; ordinal; kind; parentId?; status?; ...per-kind payload }
                                        // produced by buildChatItems (wave 3)
```

### S1 `feat/chat-contracts-adapters` — contracts and adapters

Owns `packages/core/src/chat.ts`, `packages/api/src/sessions/chat-history.ts`,
`packages/api/src/routes/chat.ts` (assistant `model` only), the plan adapters in
`packages/agent-runtime/src`, and `packages/db/src/chat.ts` for tolerant reads.

Ships: the `plan` activity and `plan` stream event; `model` on the assistant
message; ACP `plan`, Codex `turn/plan/updated`, Claude `TodoWrite` and OpenCode
`todowrite` mapped to one plan activity; tolerant transcript reads.

Acceptance: unit tests per adapter mapping and for `appendChatActivity` plan
merge (last-wins per entry id, no duplicate on repeated identical updates, entry
cap); a stored-thread fixture with an unknown activity kind still parses and
re-saves with the passthrough intact; no provider without a plan signal emits
one; `bun run ci:pr` green.

### S2 `feat/chat-tool-cards` — tool cards, groups, filters, plan card

Owns `packages/web/src/lib/{chat-tools.ts,chat-activity.ts}`,
`packages/web/src/components/chat-ui/tool-renderers.tsx`,
`packages/web/src/components/ChatActivityList.tsx`.

Ships: the full tool-kind map (read/edit/write/search/run/mcp/browser/todo/plan/
question), inline image results from tool output, Files/Git/PR links from file and
branch results, better group summary sentences, filters inside the expanded fold
(All / Changes / Commands / Failed plus a remembered "hide successful"), and the
plan checklist card.

Acceptance: every kind has a renderer and a unit test; an unknown tool still
falls back to the raw view; filters change only the expanded fold, persist across
reload, and never hide a failure in the collapsed summary; the plan card reflects
entry status without inventing steps; desktop and phone screenshots on the PR;
`bun run ci:pr` green.

### S3 `feat/chat-session-surface` — header, turn meta, dividers

Owns `packages/web/src/components/ChatPanel.tsx` (header only), new
`ChatSessionStrip.tsx` and `ChatTurnMeta.tsx`,
`packages/web/src/components/ChatMessageActions.tsx`, and `ChatConversationInfo`.

Ships: a quiet header strip (agent, model, context % with a help popover, state),
per-turn meta beside the duration (model, tokens/cache/cost/duration/stop reason,
absent fields omitted rather than zero), a model-switch divider, a compaction
divider sourced from the existing usage API, and removal of the duplicated
analytics card.

Acceptance: absent usage shows no zeroed figures; the header strip stays on one
line at desktop widths and collapses into the existing phone header without
moving Send/Stop; dividers appear only where a change actually happened; the
duplicated analytics surface is gone with its tests updated; desktop and phone
screenshots on the PR; `bun run ci:pr` green.

## Wave 2 — orc-ui catalog v2 (delivered, #364)

Metric, Progress, Table, Sparkline, Chart (Recharts), KeyValue, Callout, inline
sandboxed Html, and a live `SessionUsage` component, added to
`packages/core/src/chat-ui.ts` plus renderers and the agent-facing catalog text.
Acceptance: every component validates through `parseChatUiSpec`; charts follow
DESIGN.md (Recharts, tooltip, legend or direct labels, series tokens); sandboxed
Html cannot reach the app origin; the catalog text stays within the current
prompt budget; no change to the existing components (the catalog has seven, not
six: Stack, Button, Task, TaskList, Job, SessionList, Scratchpad — all frozen).

## Wave 3 — normalized items and the deferred surface work

Delivered as one branch (`feat/chat-items-windowing`) in four stacked commits,
tracked by #367.

Queue visibility was already delivered by the pending-message disclosure above
the composer (count, paused state, edit/move/force/remove, documented in
`docs/docs/desktop-and-web.md`); wave 3 verified it and adds no second surface.

### W3a — `ChatItem` producer and windowing

`buildChatItems(message)` in `packages/core/src/chat.ts` is the single producer:
one item per known activity, plus one `provider` item per unknown activity that
wave 1 preserved. Items keep the activity id, carry `ordinal` (position in the
turn), `parentId` only where the provider states a parent (never invented), and
`status: "failed"` on a tool call that errored. `ChatActivityList`, the fold summary and the
filters read items instead of raw activity, so counts and failures cannot drift
between the collapsed and expanded views. Unknown kinds render as a quiet,
expandable row instead of disappearing.

Paging is two-level and both levels stay honest:

- History pages stay as they are (`historyBefore`, "Load older messages"), so a
  fresh read is one bounded window and older pages merge by message id.
- Inside one turn, an expanded fold renders the last `CHAT_ITEM_WINDOW` (80)
  items and offers "Show all N activities"; the collapsed summary always counts
  every item, including failures beyond the window.

Acceptance: a 500-message thread opens without loading all of it; a turn with
>80 items expands in one click without rendering all of them; provider rows
survive a re-save and are visible; no existing e2e selector changes meaning.

### W3b — context compaction (#354)

- `SessionCacheUsage.compactions[]` gains `trigger: "manual" | "auto" | null`.
  Claude's `compactMetadata.trigger` is read; providers that do not record a
  trigger leave it null rather than guessing.
- The timeline divider reads `Context compacted automatically · 182k → 24k
  tokens`, `manually`, or plainly when the trigger is unknown.
- A small capability map in core (`supportsManualCompaction(agent)`) decides
  whether ORC offers the Compact action; ORC never invents a policy the adapter
  does not expose.
- The size of the context is already shown with the newest turn's meta, so this
  wave adds no separate hint above the composer.
- Auto-compaction stays an agent/provider capability (Codex
  `model_auto_compact_token_limit`, Pi's own settings, Claude's internal
  behaviour); the chat docs say where each adapter's setting lives.

Acceptance: the divider states trigger and drop when recorded; the newest turn's
meta states the latest request's context size; analytics and the session strip
still agree with the divider.

### W3c — selection toolbar (#355)

Selecting prose in a message shows a transient toolbar: Ask about this, Create
task, Save, Copy as Markdown. Escape dismisses it; the same actions exist in the
message actions menu, so keyboard-only and phone users are not dependent on a
floating overlay. Ask about this appends a blockquote plus attribution to the
composer draft (survives a tab switch) and focuses it; Create task opens the
existing create-task dialog prefilled and links back to the session; Save reuses
the existing scratchpad or memory flow rather than a second implementation; Copy
as Markdown adds a source line. The toolbar never appears while a terminal text
layer owns the selection.

### W3d — focus and motion

- **Focus chat (zen)**: a per-tab toggle that hides the header detail, queue
  disclosure and background work while keeping errors, permissions and
  questions visible; Escape exits. Available from session actions, not as a
  global mode.
- **Draft hero**: an empty thread centres the empty state and composer; the
  first send docks it. One composer, layout-only change.
- **Composer handoff**: the hero-to-docked move animates as a FLIP transition
  (180 ms) and is skipped under `prefers-reduced-motion`.
- **Streaming blocks**: a running message splits markdown at stable top-level
  block boundaries, memoizes completed blocks so only the tail re-renders (the
  split itself still scans the accumulated text once per update);
  fences and display math are never split. Rendering stays progressive.

Acceptance per item with desktop and phone coverage; every new selector uses
`data-testid`; all existing chat e2e coverage preserved.

## Kickoff prompts

Both prompts assume `origin/master` current with S1 merged (S2's plan card needs
the `plan` kind).

Execution note (2026-11-15): S2 and S3 were started stacked on S1's commit
`feat/chat-contracts-adapters` in `.orc/worktrees/chat-tool-cards` and
`.orc/worktrees/chat-session-surface`. Their PRs target S1's branch until it
merges, then retarget to `master`; no branch is rebased or force-pushed.

### S2 kickoff

You are implementing session S2 ("tool cards, groups, filters, plan card") of
ORC's chat-experience wave 1. Read `AGENTS.md`, `DESIGN.md` and
`docs/internal/chat-experience-spec.md` first.

Context: `ChatActivity` in `packages/core/src/chat.ts` has `thinking`, `tool`,
`status` and (wave 1) `plan`. Turns render as one collapsed summary
(`ChatActivityList` + `foldTurn`/`foldLabel`) with the activity list inside.
`chat-tools.ts` currently maps tool names to `edit`/`command`/`lookup`/`generic`
only, and `tool-renderers.tsx` renders those four. The design rules for rows,
icons, touch targets and help live in DESIGN.md; follow the existing tokens
(`text-on-surface`, `border-outline-variant`, `focus`, 32px desktop / 44px phone
rows).

Worktree: `git worktree add .orc/worktrees/chat-tool-cards -b feat/chat-tool-cards origin/master`
and work there. Merge `origin/master` to stay current; never rebase or
force-push.

You own exactly: `packages/web/src/lib/chat-tools.ts`,
`packages/web/src/lib/chat-activity.ts`,
`packages/web/src/components/chat-ui/tool-renderers.tsx`,
`packages/web/src/components/ChatActivityList.tsx`, plus their unit tests under
`packages/web/tests/unit/` and the matching `docs/docs/` page.

Do not touch: `packages/web/src/components/ChatPanel.tsx`, anything under
`packages/core/`, `packages/api/`, `packages/agent-runtime/`,
`packages/web/src/components/scratchpad/`, `packages/web/src/components/ScratchpadArtifact.tsx`,
`packages/web/src/lib/orc-kit*`, or the chat-ui catalog and registry (that is
wave 2). Do not add a global zen mode; filters live inside the expanded fold.

Deliverables: (1) tool-kind mapping for read, edit, write, search, run, mcp,
browser, todo, plan and question, each with a renderer and a unit test, unknown
tools keeping the raw view; (2) inline image results from tool output (bounded
size, expandable, never fetched from an untrusted URL); (3) Files/Git/PR links
built from file paths and branch/PR results, resolving inside the session folder;
(4) better group summary sentences (what changed, how many, what failed); (5)
filters inside the expanded fold — All / Changes / Commands / Failed plus a
remembered "hide successful" — that never hide a failure in the collapsed
summary and persist across reload; (6) the plan checklist card rendering the
`plan` activity's entries and statuses without inventing steps.

Acceptance: run `bun run ci:changed` while iterating and `bun run ci:pr` before
requesting review. Every user-visible change updates the matching page under
`docs/docs/` in the same PR (chat rendering is documented in
`docs/docs/desktop-and-web.md`). New E2E selectors use `data-testid`. Attach
desktop and phone screenshots of the changed states to the PR — do not commit
screenshots. Report changed files, the exact commands you ran, and anything you
had to decide. Do not merge the PR; the owner merges.

### S3 kickoff

You are implementing session S3 ("session surface") of ORC's chat-experience wave
1. Read `AGENTS.md`, `DESIGN.md` and `docs/internal/chat-experience-spec.md`
first.

Context: `ChatPanel.tsx` owns the chat header (phone two-line header, desktop
single line, `headerWide` breakpoint, actions popover). `ChatConversationInfo`
currently lives in `ChatControls.tsx` and owns the settings sheet, including a
Session analytics tab with counts and `SessionCacheUsage`. `ChatMessageActions.tsx`
renders a turn's duration next to copy/fork. Wave 1 added `ChatMessage.model`
and the `plan` activity. DESIGN.md requires a quiet header, one compact control
per need, help behind the shared `HelpPopover` (hover, focus, tap), 44px phone
targets, and absent data omitted rather than shown as zero.

Worktree: `git worktree add .orc/worktrees/chat-session-surface -b feat/chat-session-surface origin/master`
and work there. Merge `origin/master` to stay current; never rebase or
force-push.

You own exactly: `packages/web/src/components/ChatPanel.tsx` (header only), new
`packages/web/src/components/ChatSessionStrip.tsx` and
`packages/web/src/components/ChatTurnMeta.tsx`,
`packages/web/src/components/ChatMessageActions.tsx`,
`packages/web/src/components/ChatConversationInfo.tsx` (extract it out of
`ChatControls.tsx`), plus tests under `packages/web/tests/` and the matching
`docs/docs/` page.

Do not touch: `packages/web/src/lib/chat-activity.ts`,
`packages/web/src/components/chat-ui/*`, anything under `packages/core/` or
`packages/api/`, and all scratchpad files (`scratchpad/*`, `orc-kit*`,
`ScratchpadArtifact.tsx`). Do not change composer behavior, queue semantics or
the services that back the header.

Deliverables: (1) a quiet header strip showing agent, model, context percentage
(with a `HelpPopover` explaining the figure) and session state — context hidden
entirely when unknown; (2) per-turn meta on the turn row beside the duration
(model, tokens, cache, cost, duration, stop reason) with missing fields omitted;
(3) a model-switch divider when the assistant model changes between turns; (4) a
simple compaction divider with a header context percentage, sourced from the
existing usage API — the full compaction feature is issue #354, do not build it;
(5) removal of the duplicated analytics card with its tests updated.

Acceptance: run `bun run ci:changed` while iterating and `bun run ci:pr` before
requesting review. Every user-visible change updates the matching page under
`docs/docs/` in the same PR (`docs/docs/desktop-and-web.md`, and
`docs/docs/api.md` only if a contract changes). New E2E selectors use
`data-testid`. Attach desktop and phone screenshots of the changed states,
including a populated session and a session with unknown usage, to the PR — do
not commit screenshots. Report changed files, the exact commands you ran, and
anything you had to decide. Do not merge the PR; the owner merges.