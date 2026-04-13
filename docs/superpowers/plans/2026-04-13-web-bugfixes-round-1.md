# Web Dashboard Bugfix Round 1 — Fresh Session Prompt

> **For the next session:** This is a self-contained brief. Do not assume prior context. Start by reading this file, then explore the current state before making changes.

## Context

The ORC web dashboard at `packages/web/` has a React 19 + Vite + Tailwind + shadcn/ui SPA. Recent commits added:
- Kanban board with `@dnd-kit` drag-and-drop (`packages/web/src/components/board/`)
- SSE chat panel that spawns `acpx` (`packages/api/src/routes/chat.ts`, `packages/web/src/components/ChatPanel.tsx`, `packages/web/src/hooks/useChat.ts`)
- Collapsible sidebar with project selector
- Project scoping across Tasks, Jobs, Memories, Sessions, Knowledge, Dashboard views

QA uncovered the bugs listed below. None were caught by typecheck or by the prior agent-browser smoke test.

## Bugs to Fix

### Bug 1: "All Projects" scope filters too aggressively in Jobs and Memories views

**Symptom:** When the sidebar project selector is set to **"All Projects"**, the **Jobs** view and **Memories** view do not display every job/memory in the database. Items appear filtered even though "All" was chosen.

**Likely cause:** The views are passing `projectId` directly to the API (or to `useJobs` / `useMemories`) without translating the sentinel value `"all"` to "no filter" (`undefined`). In `Tasks.tsx` the translation is done via `apiProjectId = projectId === "all" ? undefined : ...`. The same pattern must be applied in every view that accepts `projectId`.

**Files to check:**
- `packages/web/src/views/Jobs.tsx`
- `packages/web/src/views/Memories.tsx`
- `packages/web/src/views/Sessions.tsx` (verify too)
- `packages/web/src/views/Knowledge.tsx` (verify too)
- `packages/web/src/views/Dashboard.tsx` (verify too)
- `packages/web/src/hooks/useJobs.ts`, `useMemories.ts`, etc.

**Acceptance:** With project selector on **All Projects**, every view shows the same full set as calling the underlying API with no `project_id` filter. With **Unassigned**, views show only items where `project_id` is null. With a specific project, views show only items matching that project ID.

### Bug 2: Project field on create dialogs should be a dropdown of existing projects

**Symptom:** In some create dialogs (new task works correctly, but new job / new memory / others may use a free-text input or missing field), the "project" field is either absent or a plain text input. It must be a **dropdown populated from `useProjects()`** with options: `None` (unassigned) + each project by name.

**Files to check:** Every dialog that creates an entity scoped to a project — review:
- `packages/web/src/views/Jobs.tsx` (CreateJobDialog)
- `packages/web/src/views/Memories.tsx` (CreateMemoryDialog)
- `packages/web/src/views/Knowledge.tsx` (add collection form)
- Any other create dialogs in views

Reference implementation: `CreateTaskDialog` inside `packages/web/src/views/Tasks.tsx` uses a Select with options from `useProjects()` — copy that pattern.

**Acceptance:** Every create-entity dialog that supports a project has a Select populated by `useProjects()`, with a "None" option for unassigned.

### Bug 3: Create dialog should default to the currently selected project

**Symptom:** When a specific project is selected in the sidebar and the user clicks "New Task"/"New Job"/"New Memory"/etc., the create dialog's project field should default to that project. Currently some dialogs default to `None` or empty.

**Reference:** `CreateTaskDialog` accepts a `defaultProjectId` prop that is passed through from `Tasks.tsx`:
```tsx
defaultProjectId={
  projectId !== "all" && projectId !== "unassigned" ? projectId : undefined
}
```
Replicate this wiring in every view that has a create dialog and a sidebar project scope.

**Acceptance:** Selecting project "orc" in the sidebar, then opening any create dialog, pre-selects "orc" in that dialog's project field.

### Bug 4: Chat panel is completely broken

**Symptom:** Messages sent in the chat panel produce no visible response. The stream never starts, errors silently, or crashes.

**Investigation steps (do these first — don't blindly rewrite):**
1. Open DevTools Network tab, send a chat message. Is `POST /api/chat/stream` even fired? What status code does it return? What response body?
2. Open the API server log (`~/.orc/logs/orc.log`) and look for errors after sending a message.
3. Check that the route is actually registered. `packages/api/src/server.ts` must include `import { chatRouter } from "./routes/chat.js"` and `app.route("/", chatRouter)`.
4. Check that `acpx` is on PATH from the API server's environment (`which acpx` in the shell that runs `bun dev`). The server uses `Bun.which("acpx")` — if not found it returns 503.
5. Check that Hono's `stream()` helper is imported correctly in `chat.ts`: `import { stream } from "hono/streaming"`.
6. Check that the frontend fetch URL is correct. `useChat.ts` calls `${getApiUrl()}/chat/stream`. `getApiUrl()` returns `"/api"` by default in dev (proxied by Vite to the API server). So the browser hits `/api/chat/stream` → proxied to `http://localhost:7701/chat/stream`. Verify the Vite proxy rewrite strips `/api` correctly — see `packages/web/vite.config.ts`.
7. Check bearer auth. The API's global `bearerAuth` middleware gates `/chat/stream` too. If `ORC_API_SECRET` is set, the browser must send it. `getApiSecret()` reads from `localStorage.orc_api_secret`. If the secret is set server-side but not stored in localStorage client-side, every request 401s.
8. SSE parsing on the client: verify `useChat.ts` correctly splits incoming chunks on `\n`, skips lines that don't start with `data: `, and JSON-parses the payload.

**Likely root causes (in order of probability):**
- `acpx` not on PATH → returns 503. Frontend should surface this, not silently hang.
- Streaming not flushing. Hono's `stream()` may need `await s.write(...)` + possibly `s.sleep(0)` between writes to flush. Check that `stream` is used, not `streamSSE` (or switch to `streamSSE` — it handles the `data: ` framing for you).
- CORS/proxy issue — streaming responses sometimes break behind dev proxies without `X-Accel-Buffering: no` and `Cache-Control: no-cache` headers. Those ARE set in the route but verify they actually land.
- Body parsing: `await c.req.json()` may fail silently if `Content-Type` isn't set — verify the fetch sets `Content-Type: application/json` (it does in `useChat.ts`).
- The frontend loops `while (true)` on the reader but may hit an uncaught AbortError on unmount or cancel.

**Acceptance:**
- Sending a chat message with `acpx` installed streams a visible assistant response.
- Sending a chat message with `acpx` NOT installed displays a clear error in the chat UI (not silent failure).
- Clicking Cancel during streaming stops the stream and kills the server-side process.
- Errors from `acpx` (bad agent name, etc.) surface as error bubbles in the UI.

### Bug 5: Remove "acpx" from the chat agent dropdown

**Symptom:** The chat agent dropdown in `ChatPanel.tsx` currently lists `["claude", "acpx", "codex", "gemini", "copilot"]`. `acpx` is the wrapper that invokes the others — it's not itself an agent. Remove it.

**File:** `packages/web/src/components/ChatPanel.tsx`

**Change:** `const agents = ["claude", "codex", "gemini", "copilot"];`

(Keep "claude" as the default.)

### Bug 6: Kanban drag-and-drop often fails to snap back to original column on invalid drop

**Symptom:** When a card is dragged to an invalid column (e.g. `done` → `doing` which is not an allowed transition), in many cases the card stays visually in the invalid column instead of snapping back to its origin. Sometimes the card disappears entirely until the view re-fetches.

**Investigation:**
The board uses `@dnd-kit/sortable` with `SortableContext` per column and a shared `DndContext`. On drop, `handleDragEnd` in `KanbanBoard.tsx` checks `canTransition(...)` and early-returns if the move is invalid. BUT: `@dnd-kit/sortable` optimistically reorders items in its `SortableContext` during `onDragOver`, and a `verticalListSortingStrategy` will animate the card into the target column before the drop event fires. If we only bail in `handleDragEnd`, the visual state can end up mid-animation.

**Likely fixes:**
1. Prevent cross-column reordering during drag: the current setup uses the task id as the sortable id in every column. Consider:
   - Option A: Keep sortable items ONLY for intra-column reordering (if that's even wanted — currently the board doesn't support intra-column reorder and relies on backend-sorted results). If intra-column reorder isn't a feature, drop `SortableContext` entirely and use `useDraggable` + `useDroppable` instead of `useSortable`. This removes the optimistic-reorder issue.
   - Option B: Add local state in `KanbanBoard` that tracks optimistic group membership, and on invalid drop explicitly restore the card to its original group.
2. Alternatively, since task state comes from React Query, avoid any local optimistic mutation at all. Only call `onUpdateStatus` if valid — the board re-renders from React Query data as the source of truth. Ensure no local state is tracking card position that can drift.

**Recommendation:** Refactor to **Option A** — use `useDraggable` + `useDroppable` without `SortableContext`. This is simpler, matches the board's actual requirements (column-level drops, no intra-column reordering), and eliminates the snap-back bug by construction.

**Files:**
- `packages/web/src/components/board/KanbanCard.tsx` (switch `useSortable` → `useDraggable`)
- `packages/web/src/components/board/KanbanColumn.tsx` (remove `SortableContext`)
- `packages/web/src/components/board/KanbanBoard.tsx` (verify drag-end logic still correct)

**Acceptance:**
- Dragging `done` → `doing`: card immediately returns to the `done` column. No ghost animation stuck mid-flight.
- Dragging `todo` → `doing` (valid): card moves to `doing`, API `PATCH /tasks/:id` fires, React Query invalidates and re-fetches.
- Rapid drag-drop-drag of the same card does not corrupt the visual state.
- Dropping outside any column: card returns to origin.

## Constraints & Conventions

- **Biome** for formatting (`bun check`)
- **TypeScript strict** — no `any`, no implicit `any`
- **No comments** unless non-obvious intent
- **Path alias** `@/` → `packages/web/src/`
- **Package manager**: `bun` — never `npm` / `pnpm`
- **Don't break** existing features in Tasks, Projects, Skills, Dashboard, Settings
- **No AI attribution** in commit messages / PR descriptions
- **Commit only when user asks** — do not auto-commit between fixes
- **Static data for demos**: if fixing chat requires a stub for local testing, gate it behind an env flag; don't wire it to production DB

## How to Work This

1. Read this file fully.
2. Explore the current state: `git log --oneline -10`, `git status`, read the files listed under each bug.
3. Reproduce each bug locally before fixing. Run `bun dev`, open `http://localhost:3000`, verify the bug exists.
4. Fix one bug at a time. Use `bun check` + `bun typecheck` after each. Validate in-browser via `agent-browser` before moving on.
5. Report status per bug: what you found, what you changed, how you verified.
6. When all bugs are fixed and verified, stop and ask the user whether to commit.

## Verification Checklist (all must pass before requesting commit)

- [ ] Bug 1: Jobs view with "All Projects" shows all jobs (compare count with `orc jobs list` CLI or API response)
- [ ] Bug 1: Memories view with "All Projects" shows all memories
- [ ] Bug 1: Sessions / Knowledge / Dashboard verified too
- [ ] Bug 2: Every create-entity dialog with a project field uses a Select populated from `useProjects()`
- [ ] Bug 3: Selecting project "orc" in sidebar, then opening any create dialog, pre-selects "orc"
- [ ] Bug 4: Chat streams a real response from `acpx` + claude when installed
- [ ] Bug 4: Chat displays a visible error when `acpx` missing or backend fails
- [ ] Bug 4: Cancel button stops stream and kills server process
- [ ] Bug 5: Chat agent dropdown shows only `claude`, `codex`, `gemini`, `copilot`
- [ ] Bug 6: Invalid kanban drops snap back reliably across 10+ random attempts
- [ ] `bun check` passes
- [ ] `bun typecheck` passes in both `packages/web` and `packages/api`
- [ ] `bun build` in `packages/web` succeeds
- [ ] agent-browser smoke test: all views load, no `[OBJECT OBJECT]`, no console errors

## Out of Scope (do not touch)

- TUI (`packages/tui/`)
- Backend task-service / runner / gateway logic
- Database schema / migrations
- MCP server
- Authentication / bearer auth behavior
- Visual redesign — match existing dark theme, don't introduce new colors or spacing
