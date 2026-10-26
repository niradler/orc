# ORC Web Dashboard: Code Quality and Performance Review

Scope: `packages/web/src` (about 40k lines; React 19, Vite, Tailwind, shadcn, React Query, react-router 7). This was a read-only review on branch `feat/pwa`.

Bundle numbers come from a scratch build (`bun x vite build --outDir <scratchpad>/web-dist-review`, about 17s). Main-chunk composition was measured by parsing the emitted sourcemap, and dead files were found by a reachability walk from `main.tsx`. Line numbers marked `~` are approximate (within a few lines). PWA manifest and service-worker design are out of scope.

## Summary

The routes are lazy-loaded, but the **main chunk is still 2,395 KB (749.8 KB gzip)**. Each of the heavy libraries below reaches main through an eager provider or a static import chain:

| Library | Size in main | How it gets in |
|---|---|---|
| ghostty-web terminal WASM | 624 KB | app-root `TerminalsProvider` |
| CodeMirror + lezer | ~550 KB | a one-line regex helper, reached from the always-mounted `CommandPalette` |
| assistant-ui | ~350 KB | app-root `ChatProvider` |
| Projects / TaskDetailSheet / FlowRunPanel views | ~65 KB | `CommandPalette` / `ProjectPicker` |

Fixing these four (W-1 to W-4) should bring main under roughly 800 KB (about 250 KB gzip). That is the biggest win for first load on mobile.

The second theme is **over-fetching**:
- **Over-broad SSE invalidation.** The server publishes a `sessions` event on every transcript write during active agent runs. Each one refetches up to 5,000 sessions in several places and re-downloads whole transcripts page by page.
- **Fetching twice on every change.** Mutations refetch about twice (once from `onSuccess` invalidate, once from SSE), and `refetchOnMount: "always"` refetches on every route change.

The third theme is **re-render fan-out**: the chat context value is a new object on every streamed token, and it is consumed by per-row `ResumeActions` components across the session lists.

Code health is reasonable: strict types, only 2 `any`, no `dangerouslySetInnerHTML`, and good touch targets. It is let down by:
- **Duplicated form, error and dialog plumbing.** There are 38 copies of `instanceof Error ? …` and 73 `setError(` calls, while a good `useAction` helper sits unused outside `kb/`.
- **Oversized components.** `EventRuleEditor` is 796 lines with 29 `useState`.
- **Dead files and unused deps.** 9 dead files and 2 unused deps.

## Prioritized findings

QW = quick win (small, low-risk change with clear payoff).

| ID | Title | Category | Impact | Effort | QW | Files |
|---|---|---|---|---|---|---|
| W-1 | ghostty-web (624 KB) eagerly in main via app-root TerminalsProvider | Perf / bundle | High | M | | `lib/terminal-runtime.ts`, `lib/terminals.tsx`, `App.tsx`, `ApiAccessGate.tsx`, `views/Settings.tsx` |
| W-2 | All CodeMirror languages (~550 KB) in main because of `isMarkdownFile` | Perf / bundle | High | S | QW | `lib/editor-language.ts`, `components/CodeEditor.tsx`, `components/MarkdownEditor.tsx` |
| W-3 | CommandPalette/ProjectPicker statically pull `views/Projects`, CreateTaskDialog, TaskDetailSheet, FlowRunPanel into main | Perf / bundle | High | S | QW | `components/CommandPalette.tsx`, `components/ProjectPicker.tsx`, `views/Projects.tsx` |
| W-4 | ChatProvider (assistant-ui, ~350 KB) eager at root, plus startup fetches for every stored thread | Perf / bundle + network | High | M | | `hooks/useChat.ts`, `App.tsx`, `components/chat/ChatPanel.tsx` |
| W-5 | Chat context value recreated on every streamed token, which re-renders every session row | Perf / re-render | High | M | | `hooks/useChat.ts`, `components/ResumeActions.tsx` + 6 consumers |
| W-6 | `sessions` SSE event refetches `limit: 5000` session lists (4 call sites) and full transcripts | Perf / network | High | M | | `lib/resource-events.ts`, `hooks/useSessions.ts`, `TerminalPaneLinks.tsx`, `ChatControls.tsx`, `ChatContinueInTerminal.tsx` |
| W-7 | Transcript downloaded in full (sequential 500-turn pages) and rendered without virtualization | Perf / render | High | M | | `hooks/useSessions.ts`, `views/LiveSessionDetail.tsx` |
| W-8 | Double refetch per mutation, and `refetchOnMount: "always"` redundant with SSE | Perf / network | Med | S | | `main.tsx`, `lib/resource-events.ts`, `hooks/use*.ts` |
| W-9 | Terminals context churn re-renders 12 consumers on any connection or font change | Perf / re-render | Med | S | | `lib/terminals.tsx` |
| W-10 | Terminal sockets stay open off-screen and in background tabs; ResizeObserver never disconnected | Perf / mobile + leak | Med | S | QW (leak) | `lib/terminal-runtime.ts` |
| W-11 | Redundant 3s polling of webhook deliveries (already SSE-invalidated) | Perf / network | Med | S | QW | `hooks/useWebhooks.ts` |
| W-12 | ChatContinueInTerminal fetches 5,000 sessions to find one | Perf / network | Med | S | QW | `components/chat/ChatContinueInTerminal.tsx` |
| W-13 | CommandPalette (628-line component) always mounted and builds its entry list while closed | Perf + readability | Med | M | | `components/CommandPalette.tsx`, `WorkspaceHeader.tsx` |
| W-14 | Error/pending/form plumbing duplicated app-wide; promote `useAction`/`Field`/`ErrorLine` from KbDialogs | Reuse | Med | M | | `kb/KbDialogs.tsx` + ~40 files |
| W-15 | Create/Edit dialog pairs duplicated (Jobs, Projects) | Reuse | Med | M | | `views/Jobs.tsx`, `views/Projects.tsx` |
| W-16 | Resume-in-chat logic duplicated | Reuse | Low | S | QW | `ResumeActions.tsx`, `terminals/ContinueInChat.tsx` |
| W-17 | `window.confirm` (8 uses) vs `ConfirmDialog` (15 uses) | Consistency / UX | Low | S | QW | 7 files |
| W-18 | Skeleton-list pattern + biome-ignore repeated about 8 times; status color maps scattered | Reuse | Low | S | QW | 8 files |
| W-19 | Oversized components/files (top 15) | Readability | Med | L | | see table |
| W-20 | Dead files (9) and unused deps (2) | Dead code | Low | S | QW | see list |
| W-21 | `api/client.ts`: hand-written response types duplicate OpenAPI; `req()` parses JSON before checking content type; unguarded localStorage | Types / errors | Med | M | | `api/client.ts` |
| W-22 | Derived state in effects; KnowledgeSettings form resets on refetch | Best practice | Low | S | | 5 files |
| W-23 | Unchecked casts (`as TaskStatus`, redundant `as Error`) | Types | Low | S | | ~15 files |
| W-24 | Minor: re2js (141 KB) in Rules chunk; 68 font files emitted | Perf / bundle | Low | S | | `views/Rules*`, `main.tsx` font imports |

---

## W-1: ghostty-web (624 KB) is eagerly in main via the app-root TerminalsProvider

**Evidence**
- Main chunk `index-*.js` is 2,395 KB raw and 749.8 KB gzip. Sourcemap attribution puts **ghostty-web at 623.7 KB**, the largest single contributor, with its WASM inlined.
- `App.tsx:19` wraps the whole app in `TerminalsProvider` (`lib/terminals.tsx`).
- `lib/terminal-runtime.ts:1` statically imports `{ FitAddon, Terminal, ITheme, init }` from `"ghostty-web"`.
- `loadGhostty()` (`terminal-runtime.ts:~118`) already calls `init()` lazily, but the module itself is static.
- Two other imports also pull terminal-runtime into main, even though they only need a constant: `ApiAccessGate.tsx:15` and `views/Settings.tsx:15` import `TERMINAL_FONT_KEY`.

**Why it matters**
- Every page load (dashboard, tasks, knowledge) downloads, parses and compiles about 624 KB of terminal emulator, even if the user never opens a terminal.
- On mid-range phones, parse and compile of this much JS costs hundreds of milliseconds of main-thread time before first interaction.

**Recommendation**
1. Move pure constants and types (`TERMINAL_FONT_KEY`, theme helpers, `ITheme` type) into `lib/terminal-config.ts`, which has no ghostty import.
2. In `terminal-runtime.ts`, keep only `import type { … } from "ghostty-web"`, and load the module on demand:
   ```ts
   let ghostty: Promise<typeof import("ghostty-web")> | undefined;
   export function loadGhostty() {
     ghostty ??= import("ghostty-web").then(async (m) => { await m.init(); return m; });
     return ghostty;
   }
   // createRuntime(): const { Terminal, FitAddon } = await loadGhostty();
   ```
3. Keep the provider light: it tracks the terminal list and connection state. The runtime and WASM only load when a terminal is mounted (the `/terminals` route or a pane).

Expected result: about -624 KB from main.

## W-2: all CodeMirror languages (~550 KB) are in main because of a one-line regex helper (QUICK WIN)

**Evidence**
- In main:

  | Package | Size |
  |---|---|
  | @codemirror/view | 191.7 KB |
  | @codemirror/state | 46 KB |
  | @codemirror/autocomplete | 34 KB |
  | @codemirror/language | 25 KB |
  | @codemirror/lang-* | ~40 KB |
  | @lezer/javascript | 76 KB |
  | @lezer/python | 37 KB |
  | @lezer/markdown | 35 KB |
  | other @lezer/* | ~85 KB |

  Roughly **550 KB** in total.
- Import chain: `App → WorkspaceHeader → CommandPalette → CreateTaskDialog → flow/FlowPicker → FlowDetailSheet → CodeEditor → lib/editor-language.ts`.
- `lib/editor-language.ts:1-8` statically imports `@codemirror/lang-css`, `-html`, `-javascript`, `-json`, `-markdown`, `-python` and `-yaml`.
- `CodeEditor.tsx:4` and `MarkdownEditor.tsx:7` only need `isMarkdownFile`, which is `/\.(md|markdown|mdx)$/i`.
- `SourceEditor` (the real editor) is already lazy, so this is purely an accidental import.

**Recommendation**
- Move `isMarkdownFile` (and any other pure path helpers) to `lib/file-kind.ts`, which has no imports.
- Leave `editor-language.ts` reachable only from the lazy `SourceEditor`.
- Better still, change `languageFor(path)` to return `() => import("@codemirror/lang-x")` loaders, so that only the language in use downloads.

Expected result: about -550 KB from main, from a few lines changed.

## W-3: CommandPalette and ProjectPicker statically pull view modules into main (QUICK WIN)

**Evidence**
- `CommandPalette.tsx:19` and `ProjectPicker.tsx:10` import `CreateProjectDialog` from `"@/views/Projects"`. That puts the entire Projects route module into main (16.3 KB of source), and Projects imports `TaskDetailSheet`.
- `CommandPalette.tsx:6` and `ProjectPicker.tsx:5` import `CreateTaskDialog`.
- Source files now in main because of this:

  | File | Source size |
  |---|---|
  | TaskDetailSheet | 14.8 KB |
  | FlowRunPanel | 10.9 KB |
  | flow-graph | 7.3 KB |
  | CreateTaskDialog | 7.3 KB |
  | FlowGraph | 4.8 KB |
  | MarkdownEditor | 4.3 KB |

- This defeats the lazy `Projects` route (`App.tsx:22-47`), and it is the root of the W-2 chain.

**Recommendation**
1. Move `CreateProjectDialog` out of `views/Projects.tsx` into `components/projects/CreateProjectDialog.tsx`. Views should export only a default component.
2. Lazy-load dialog bodies from shell components, and render them only when open:
   ```tsx
   const CreateTaskDialog = lazy(() => import("@/components/CreateTaskDialog"));
   {creatingTask && <Suspense fallback={null}><CreateTaskDialog … /></Suspense>}
   ```
3. Add a lint guard (biome `noRestrictedImports`, or a small script) that forbids importing `@/views/*` from `components/*`.

## W-4: ChatProvider (assistant-ui, ~350 KB) is eager at the root, plus startup network work

**Evidence**
- In main:

  | Package | Size |
  |---|---|
  | @assistant-ui/core | 207.9 KB |
  | @assistant-ui/react | 65.7 KB |
  | assistant-stream | 34.9 KB |
  | @assistant-ui/store | 20.1 KB |
  | @assistant-ui/tap | 20.0 KB |
  | zod (via `@orc/core` chat schemas) | 95.3 KB, much of it attributable to chat |

- `hooks/useChat.ts:560-745`: `ChatProvider` uses `useExternalStoreRuntime` and `AssistantRuntimeProvider` and wraps the whole app.
- `ChatPanel.tsx` imports the `ThreadPrimitive` family statically. When closed, it renders a hidden div (`~:160`).
- On mount, even if chat is never opened, ChatProvider:
  - calls `api.settings.get()` outside React Query (`loadSettings`, `useChat.ts:~169`);
  - calls `api.chat.get` for **every stored tab thread** (`~:299`);
  - opens a `/chat/threads/{id}/live` streaming fetch per thread via `attach`.

**Why it matters**
- First-load cost for a feature that most page views don't use.
- N extra requests and N long-lived streams per stored tab on every app start. On mobile this keeps the radio awake.

**Recommendation**
- Split chat into two layers:
  - **`ChatShell`** (eager, tiny): owns `open`, `activeThreadId` and the tab list in localStorage, and exposes stable actions (`openThread`, `openChat`, `close`).
  - **`ChatRuntime`** (lazy chunk): `ChatProvider`'s runtime, `ChatPanel` and assistant-ui. It is mounted the first time chat opens and kept mounted afterwards to preserve streams.
- Hydrate threads lazily: fetch and `attach` only the active tab, and the others on tab focus.
- Read settings through the existing `useSettings()` query instead of `api.settings.get()`, so the cache is shared and SSE invalidation applies.

## W-5: the chat context value is a new object on every token, which re-renders every session row

**Evidence**
- `useChatController` returns a fresh object literal every render (`useChat.ts:~620-645`). During streaming, the provider re-renders per chunk, so `ChatContext` consumers re-render per chunk.
- Consumers:

  | Consumer | Location |
  |---|---|
  | ChatAgentOptionsEditor | :8 |
  | ChatContinueInTerminal | :8 |
  | ChatControls | :22, :265, :358 |
  | ChatPanel | :43, :138 |
  | **ResumeActions** | :22 |
  | terminals/ContinueInChat | :8 |

- `ResumeActions` is rendered **per row** in:

  | Parent | Location |
  |---|---|
  | Dashboard.tsx | :366 |
  | LiveSessions.tsx | :257 and :359 (25 rows per page) |
  | TaskSessions.tsx | :79 |
  | LiveSessionDetail | :251 |
  | Terminals | :120 |

  `ResumeActions` only uses `chat.openThread`.

**Why it matters:** with chat streaming and the Sessions page open, every token re-renders every row's actions and their menus. This shows up as jank on mobile.

**Recommendation:** split into an actions context (stable) and a state context.
```ts
const ChatActionsContext = createContext<ChatActions | null>(null); // useMemo(() => ({openThread, openChat, close, newThread}), [])
const ChatStateContext  = createContext<ChatState | null>(null);    // open, threadId, status, messages…
export const useChatActions = () => use(ChatActionsContext)!;       // ResumeActions, ContinueInChat, CommandPalette
export const useChatState = () => use(ChatStateContext)!;           // ChatPanel, ChatControls
```
- Wrap the action callbacks in `useCallback` or a ref-backed `useEvent`, so the actions object never changes.
- Alternatively, expose a store with `useSyncExternalStore(selector)`.
- This dovetails with W-4: the shell owns the actions context.

## W-6: `sessions` SSE events trigger 5,000-row list refetches and transcript re-downloads

**Evidence**
- On the API side, `session-watcher.ts:250-276` publishes a `sessions` change after each transcript file change (100 ms debounce). During an active agent run, that is roughly every few hundred milliseconds to a few seconds.
- In `lib/resource-events.ts`, `QUERY_ROOTS` maps both `tasks` and `sessions` to the `["sessions", "session", "project-summary"]` roots.
- Each event refetches `api.sessions.live({ limit: 5000 })` from:

  | Caller | Detail |
  |---|---|
  | `hooks/useSessions.ts:36` | key `["sessions","live",active]` |
  | `TerminalPaneLinks.tsx:33` | same call |
  | `ChatControls.tsx:41` | key `["chat-resume-sessions"]`, `staleTime: 0` |
  | `ChatContinueInTerminal.tsx:18` | imperative |

- `LiveSessions.tsx` then paginates **client-side** (`PAGE_SIZE 25`, slice at `:209` / `:277`).
- `useTranscript` sits under the `sessions` root too, so every event re-downloads the whole transcript (see W-7).

**Why it matters:** O(sessions) JSON payload and parse work per event, multiplied by several observers, on exactly the screens people watch during agent runs. On mobile this costs CPU and data continuously.

**Recommendation**
1. Make events targeted. The publisher already knows the session id, so include it (`{ resource: "sessions", ids: [id] }`). Invalidate `["session", id]` and its transcript only, plus the lists, throttled.
2. Throttle list invalidation per root (for example, at most once per 2s) inside `refreshQueries`.
3. Paginate server-side: `api.sessions.live({ limit: 25, offset, status })`. Add a `count` endpoint or field for the pager. Use `placeholderData: keepPreviousData`.
4. Give the transcript its own root (`["transcript", id]`), invalidated only by events carrying that id. Fetch only *new* turns (`after: lastTurnIndex`) and append to the cache with `setQueryData`.

## W-7: the full transcript is downloaded sequentially and rendered without virtualization

**Evidence**
- `useTranscript` (`useSessions.ts:~70-95`) has `staleTime: 0` and `refetchOnMount: "always"`. It loops over 500-turn pages **sequentially** until done, so the whole transcript comes down before anything renders.
- I checked the `q` param on later pages: it is not a bug, because the server only computes matches.
- `LiveSessionDetail.tsx:355` maps all turns into DOM, with no windowing.

**Why it matters:**
- A long Claude session (thousands of turns) means multiple sequential round-trips before the first paint, and is fully re-fetched on each W-6 event.
- Thousands of markdown and code nodes slow down every interaction and scroll on mobile.

**Recommendation**
- Use `useInfiniteQuery` that loads the **last** page first (newest turns) and older pages on scroll-up. Append live turns incrementally (W-6 #4).
- Virtualize with `@tanstack/react-virtual` (`useVirtualizer` with `measureElement` for variable height), anchored to the bottom.
- Sketch:
  ```ts
  function useTranscriptPages(id: string) {
    return useInfiniteQuery({
      queryKey: ["transcript", id],
      queryFn: ({ pageParam }) => api.sessions.transcript(id, { before: pageParam, limit: 200 }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (p) => p.prevCursor, // older
    });
  }
  ```

## W-8: double refetch per mutation, and `refetchOnMount: "always"` is redundant with SSE

**Evidence**
- `main.tsx` QueryClient defaults:

  | Option | Value |
  |---|---|
  | `staleTime` | `Infinity` |
  | `refetchOnMount` | `"always"` |
  | `refetchOnWindowFocus` | `false` |
  | `refetchOnReconnect` | `false` |
  | `retry` | `1` |

- Mutation hooks invalidate in `onSuccess` (for example `useWebhooks.ts`). The server then emits an SSE change for the same resource.
- `refreshQueries` intentionally waits for an in-flight fetch and then **invalidates again**, so each mutation yields about 2 full refetches of every active observer of that root.
- `refetchOnMount: "always"` with infinite staleness means every route change and every newly mounted observer refetches, even though SSE keeps the cache fresh. SSE `ready` (reconnect) already calls `refreshQueries` for everything.

**Recommendation**
- Choose one freshness mechanism:
  - Keep SSE as the source of truth and set `refetchOnMount: true`. With `staleTime: Infinity` this means "fetch only if no data".
  - Let mutations use `setQueryData` from the response, or no invalidate at all, relying on SSE.
  - If immediate consistency is required, keep the `onSuccess` invalidate and have `refreshQueries` skip roots invalidated in the last ~500 ms.
- If SSE is ever not connected, fall back to `refetchOnWindowFocus: true` (gate it on the SSE connection state).

## W-9: Terminals context churn re-renders 12 consumers (lib/terminals.tsx)

**Evidence**
- The context value is memoized (`terminals.tsx:290-340`), but `connectionOf` closes over `connections` state, and `fontSizeOf` over `fontSizes`. Any terminal's connection flip (connecting, open, closed, including the 1s→10s reconnect backoff) or any font change produces a new value.
- That re-renders all 12 `useTerminals()` consumers, including `WorkspaceSidebar:59`, the always-mounted `CommandPalette:65`, and every `ResumeActions` row.
- There is also a root-level `useQuery(["terminals"])` on every page, and a derived-state effect at `:93-95` (`setLastActiveId`).

**Recommendation**
- Keep `connections` and `fontSizes` in a ref-backed store and expose per-id hooks:
  ```ts
  export function useTerminalConnection(id: string) {
    return useSyncExternalStore(store.subscribe, () => store.connection(id));
  }
  ```
  Then the main context carries only stable actions plus the terminal list.
- Compute `lastActiveId` during render, or in the event that changes the active id, instead of an effect.

## W-10: terminal sockets stay alive off-screen; ResizeObserver leak (leak = QUICK WIN)

**Evidence**
- `mountRuntime` (`terminal-runtime.ts:~497`) creates `new ResizeObserver(…)` on the canvas. `disposeRuntime` (`:607`) never calls `.disconnect()`, so it is leaked per terminal dispose.
- `unmountRuntime` only pauses rendering. After the user leaves `/terminals`, every terminal's WebSocket stays open and output keeps being parsed in WASM.
- Reconnect backoff is 1s doubling to a 10s cap, which continues even in background tabs.

**Why it matters:** on phones, open sockets plus WASM parsing of busy agent output drain battery and data while the app is in the background.

**Recommendation**
- Store the observer on the runtime and call `runtime.resizeObserver?.disconnect()` in both `unmountRuntime` and `disposeRuntime`.
- On `document.visibilitychange → hidden`, close sockets for terminals not visible for more than N seconds. On visible or mount, reconnect and rely on the server's replay (a `replay-end` frame already exists).
- Pause reconnect timers while hidden.

## W-11: redundant 3s polling of webhook deliveries (QUICK WIN)

**Evidence**
- `useWebhookDeliveries` (`hooks/useWebhooks.ts`) sets `refetchInterval: 3000`, while `"webhook-deliveries"` is also in `QUERY_ROOTS` and invalidated by SSE.

**Recommendation**
- Remove the interval, or keep a slow fallback (30s) only while SSE is disconnected.
- Other polls for comparison:

  | Poll | Interval | Notes |
  |---|---|---|
  | `useHumanRequests` | 15s | mounted in `WorkspaceHeader:31`, so every page; acceptable as a fallback |
  | `ArchivedSessions:53` | 10s | |
  | `TerminalPaneLinks:42` | 60s | GitHub poll |

  Consider gating all of them on `document.visibilityState === "visible"` (React Query's `refetchIntervalInBackground: false` is the default, so this is mostly fine).

## W-12: ChatContinueInTerminal fetches 5,000 sessions to find one (QUICK WIN)

**Evidence**
- `components/chat/ChatContinueInTerminal.tsx:18` calls `api.sessions.live({ limit: 5000 })` imperatively, then `.find()`s the session linked to the current thread.

**Recommendation:** use a by-id or by-thread lookup (`api.sessions.get(id)`, or add `?thread_id=` filtering server-side). If the list is already cached, read it with `queryClient.getQueryData` instead of refetching.

## W-13: CommandPalette is always mounted and does work while closed

**Evidence**
- `components/CommandPalette.tsx` is 675 lines, and its main component is 628 lines.
- It is mounted from `WorkspaceHeader` on every page, and subscribes to `useTerminals`, `useChat`, projects and others.
- It rebuilds and sorts its entry list (terminals and so on) on every render, even with `open === false`.
- Its search queries are correctly gated on `open`.
- It is also the root of the W-2 and W-3 import chains.

**Recommendation**
```tsx
// CommandPaletteShell.tsx (eager, ~30 lines): registers Ctrl/Cmd+K, holds `open`
const CommandPaletteDialog = lazy(() => import("./CommandPaletteDialog"));
return open ? <Suspense fallback={null}><CommandPaletteDialog onClose={…} /></Suspense> : null;
```
- Split the dialog body into entry providers (`useNavigationEntries`, `useTerminalEntries`, `useProjectEntries`, `useActionEntries`), each returning `PaletteEntry[]`, merged with `useMemo`.
- Move the create-task and create-project flows out to the lazily loaded dialogs (W-3).

## W-14: error/pending/form plumbing is duplicated; promote the `kb` helpers app-wide

**Evidence**

| Pattern | Count |
|---|---|
| `x instanceof Error ? x.message : fallback` | 38 |
| `setError(` calls | 73 |
| direct `await api.` calls inside `.tsx` components (bypassing hooks) | 39 |
| `useMutation` uses (so state handling is mixed) | 61 |
| label class `font-label text-xs font-medium text-outline` | 69 |
| `"space-y-1.5"` field wrappers | 83 |
| `bg-background border-control-border` inputs | 61 |
| `onOpenChange={(v) => !v && onClose()}` | 12 |
| `role="alert"` error lines | 126 |

- `kb/KbDialogs.tsx:52-131` already defines a good `useAction()` (pending/error/run), plus `Field`, `ErrorLine` and a dialog `Shell`. They are used 12 times, but only inside `kb/`.
- There is no toast system, so every component renders its own inline error.

**Recommendation**
- Move these into `lib/errors.ts` and `components/form/`:
  ```ts
  export const errorMessage = (e: unknown, fallback = "Something went wrong") =>
    e instanceof Error ? e.message : typeof e === "string" ? e : fallback;

  export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
    // returns { run, pending, error, reset }; run catches & sets errorMessage(e)
  }
  ```
  ```tsx
  <FormDialog open title onClose onSubmit pending error submitLabel>{fields}</FormDialog>
  <Field label htmlFor hint error>{control}</Field>
  <ErrorLine error={error} />
  ```
- Standardize: data reads go through hooks, writes through `useMutation` or `useAction`, and errors through `errorMessage`.

## W-15: Create/Edit dialog pairs are near-duplicates (Jobs, Projects)

**Evidence**
- In `views/Jobs.tsx`, `CreateJobDialog` (`:476-762`) and `EditJobDialog` (`:763-993`) each hold about 12 parallel `useState`s and near-identical field markup. There are 28 `useState` in the file.
- `views/Projects.tsx` has the same pattern: `CreateProjectDialog` (`:392`) and the edit dialog (`:607`).

**Recommendation**
```ts
function useJobForm(initial?: Job) { /* one useReducer/object state, validate(), toPayload() */ }
function JobFormFields({ form }: { form: ReturnType<typeof useJobForm> }) { … }
function JobDialog({ job, onClose }: { job?: Job; onClose(): void }) // create when job undefined
```
This removes about 250 lines from Jobs.tsx, and creating and editing can no longer drift apart. Do the same for projects (`components/projects/ProjectDialog.tsx`, which also resolves W-3).

## W-16: resume-in-chat logic is duplicated (QUICK WIN)

**Evidence**
- `ResumeActions.openChat` (`:72-88`) and `terminals/ContinueInChat.open` (`:14-29`) both do the same thing:
  1. `api.chat.resume`
  2. `openThread`
  3. set the `chat=open` search param
  4. delete `session`

**Recommendation**
```ts
export function useResumeInChat() {
  const { openThread } = useChatActions(); // W-5
  const [, setParams] = useSearchParams();
  return useAction(async (sessionId: string, opts?: ResumeOpts) => { … });
}
```

## W-17: `window.confirm` vs `ConfirmDialog` (QUICK WIN)

**Evidence**
- `window.confirm` is used 8 times:

  | File | Lines |
  |---|---|
  | DocumentWorkspace | :20 |
  | PackageEditor | :62 |
  | FileEditor | :112 |
  | FilePanel | :225, :246, :262 |
  | Skills | :823 |
  | WebhooksManager | :86 |

- `ConfirmDialog` is used 15 times elsewhere.
- Native confirm is unstyled, blocks the main thread, behaves poorly in installed PWAs and mobile webviews, and cannot be tested in Playwright without dialog handlers.

**Recommendation:** add a promise-based `useConfirm()` built on the existing `ConfirmDialog` (`const ok = await confirm({ title, body, destructive: true })`), and replace all 8 call sites.

## W-18: skeleton lists and status colors are repeated (QUICK WIN)

**Evidence**
- `Array.from({length:n}).map((_, i) => <Skeleton key={i} …/>)` with a `biome-ignore noArrayIndexKey` comment appears about 8 times:

  | File | Lines |
  |---|---|
  | FlowDetailSheet | :51 |
  | JobDetailSheet | :57, :121 |
  | LiveSessionDetail | :331 |
  | LoggedSessions | :63 |
  | SessionDetailSheet | :60 |
  | TaskDetailSheet | :184 |
  | Jobs | :193 |

  20 of the 34 biome-ignores are `noArrayIndexKey`.
- Status-to-color maps are spread across `StatusBadge.tsx`, `FlowRunPanel:42/49`, `FlowGraph:22`, `KbComments:13` and `lib/live-sessions.ts:3`.

**Recommendation**
- Add `<SkeletonRows count={5} className="h-10" />` with a single internal ignore.
- Add `lib/status-colors.ts` with `statusTone(kind, status) → "success" | "warning" | …`, consumed by `StatusBadge`, so new statuses get colored consistently.

## W-19: oversized components and files

The largest components by line count (from function start to the next top-level declaration) are listed below. Splitting them is about readability and reviewability; it also lets React skip work when child props are stable.

| # | File (lines) | Largest component (lines) | Split suggestion |
|---|---|---|---|
| 1 | `api/client.ts` (1232) | (not a component) | Split per domain (`api/sessions.ts`, `api/chat.ts`, `api/knowledge.ts`, …) behind one `api` barrel; derive types from OpenAPI (W-21) |
| 2 | `components/kb/KbDialogs.tsx` (1020) | many dialogs | One file per dialog; move `useAction`/`Field`/`Shell` to shared (W-14) |
| 3 | `views/Skills.tsx` (1017) | `Skills` (550) | `SkillsToolbar`, `SkillList` + `SkillRow`, `SkillImportDialogs`, `useSkillsPage()` (query, filters, paging) |
| 4 | `views/Jobs.tsx` (993) | `Jobs` (411), plus two ~250-line dialogs | `JobDialog` + `useJobForm` (W-15), `JobsTable` |
| 5 | `views/Knowledge.tsx` (859) | `Knowledge` | Nav pane, document pane and search into separate files; remove effect-driven state (W-22) |
| 6 | `views/Memories.tsx` (836) | | List / detail / edit dialog |
| 7 | `components/rules/EventRuleEditor.tsx` (830) | `EventRuleEditor` (796, **29 `useState`**) | `useReducer` over a `RuleDraft` object with `toRule()`/`fromRule()`; sections `ScopeSection`, `ConditionsSection`, and `TargetSection` with one sub-form per target type (block / request / script / processor / job / orc / memory) |
| 8 | `views/Projects.tsx` (829) | | Move `CreateProjectDialog`/edit out (W-3, W-15) |
| 9 | `hooks/useChat.ts` (751) | `ChatProvider` (~185) | `chat-store.ts` (tabs, persistence), `chat-transport.ts` (attach/live stream), `ChatProvider` (W-4/W-5) |
| 10 | `components/TaskDetailSheet.tsx` (725) | `TaskDetailSheet` (396) | Header, description editor, sessions, flow run as subcomponents |
| 11 | `components/kb/KbDocumentPane.tsx` (697) | `KbDocumentPane` (437) | Toolbar, editor, comments rail |
| 12 | `components/git/PullReviewPanel.tsx` (689) | 452 | File list, diff view, review composer |
| 13 | `components/packages/PackageEditor.tsx` (689) | 622 | Per-tab subcomponents + `usePackageDraft` |
| 14 | `components/git/GitPanel.tsx` (676) | `GitPanelBody` (643) | Status list, commit box, branch bar, history |
| 15 | `components/CommandPalette.tsx` (675) | 628 | Shell + lazy dialog + entry providers (W-13) |

Also notable:

| Component / file | Lines |
|---|---|
| RulesPanel | 612 |
| `lib/flow-graph.ts` | 649 |
| `lib/terminal-runtime.ts` | 625 |
| Terminals (component) | 457 |
| Tasks | 456 |
| NewTerminalMenu | 426 |
| WorktreeManager | 425 |

## W-20: dead files and unused dependencies (QUICK WIN)

Files unreachable from `main.tsx` (verified with an import-graph walk and a grep for any dynamic import):

| File | Lines | Note |
|---|---|---|
| `components/Sidebar.tsx` | 254 | superseded by `WorkspaceSidebar` |
| `components/AgentPackageEditor.tsx` | 1 | re-export |
| `components/MobileChatFab.tsx` | 23 | |
| `components/MobileTopBar.tsx` | 30 | |
| `components/SkillFileEditor.tsx` | 69 | |
| `components/StatCard.tsx` | 68 | |
| `components/ui/card.tsx` | 55 | |
| `components/ui/tooltip.tsx` | 28 | |
| `views/Packages.tsx` | 1 | re-export |

Unused dependencies in `packages/web/package.json`:
- `@radix-ui/react-tooltip`, imported only by the dead `ui/tooltip.tsx`.
- `@dnd-kit/sortable`, with 0 imports.

Before deleting `MobileChatFab` and `MobileTopBar`, confirm with the parallel PWA/mobile effort that they are not about to be revived.

## W-21: `api/client.ts` types and error handling

**Evidence**
- About 24 hand-written response interfaces (`Terminal`, `TerminalsInfo`, `Worktree`, `GitStatus`, `Memory`, …) duplicate schemas already generated in `packages/sdk/src/openapi.gen.ts`. All responses are `json as T`, with no runtime check, so server changes drift silently.
- `req()` (`:484-525`) calls `await res.json()` before checking `res.ok` and the content type. A proxy's HTML 502/504 page surfaces as `SyntaxError: Unexpected token '<'` instead of a meaningful HTTP error.
- `getApiUrl()` (`:179`) reads `localStorage` without try/catch. It throws in Safari private mode and some embedded webviews. `api-credentials.ts` already guards this correctly.
- Security posture is fine:
  - The token is in memory unless "remember" is chosen, in which case it goes to localStorage per API URL.
  - There are 0 uses of `dangerouslySetInnerHTML`.
  - Markdown is rendered through a sanitizing renderer.

**Recommendation**
```ts
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(…);
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new ApiError(res.status, isJson ? body?.error ?? res.statusText : res.statusText, body);
  return body as T;
}
```
- Export `ApiError` with `status`, so the UI can branch on 401, 404 or 409.
- Replace hand-written types with `components["schemas"]["X"]` aliases from the SDK's generated types.
- Wrap `getApiUrl` storage access in the same safe helper `api-credentials.ts` uses.

## W-22: derived state in effects; form reset on refetch

**Evidence**

| Location | Pattern |
|---|---|
| `Knowledge.tsx:179` | `useEffect(() => { if (wide) setNavOpen(false) }, [wide])` |
| `Knowledge.tsx:512` | `setFolded(null)` in an effect |
| `terminals.tsx:93` | `setLastActiveId` in an effect |
| `KbDialogs.tsx:895` | sets instructions from the selected template in an effect |
| **`KnowledgeSettings.tsx:77`** | `useEffect(() => setForm(toForm(settings.data)), [settings.data])` |
| `Skills.tsx:109` | `useEffect(() => setSearchInput(query), [query])` |

- The KnowledgeSettings effect re-runs on every refetch. With W-8's `refetchOnMount: "always"` and SSE invalidations, a background refresh can **wipe in-progress edits**. That makes this one a correctness bug, not just style.
- There are 79 `useEffect`s in total.

**Recommendation**
- For KnowledgeSettings, initialize the form once per entity version: `key={settings.dataUpdatedAt}` on a child form component with `useState(() => toForm(data))`, or track a `dirty` flag and only reset when not dirty.
- For the others, derive during render (`const navOpen = !wide && navOpenState`), or set the state in the event handler that changes the source value.

## W-23: unchecked casts

**Evidence**

| Cast | Count | Notes |
|---|---|---|
| `as Error` | 29 | mostly redundant `(query.error as Error)`; React Query types `error` as `Error` already. 10 in `.tsx` |
| `as TaskStatus` | 6 | union cast from untyped Select values |
| `as TaskPriority` | 4 | union cast from untyped Select values |
| `as string` | 24 | mostly behind `enabled` guards |
| `any` | 2 | |

**Recommendation**
- Drop the redundant `as Error` casts.
- Add a typed `<EnumSelect<T extends string> options={TASK_STATUSES} value onValueChange={(v: T) => …}>` so Select values are typed at the source.

## W-24: minor bundle items

- **Rules chunk is 200 KB, of which 141 KB is `re2js`**, imported through `@orc/core` `rule-filters.ts`. If the UI only needs regex *validation*, consider a light syntax check, or validating server-side on save. Otherwise the cost is acceptable, since it is route-lazy.
- **Fonts:** `@fontsource` imports emit 68 files (cyrillic, greek and vietnamese subsets, woff + woff2; 34 `@font-face` rules). Browsers only download subsets whose `unicode-range` matches, so the runtime cost is small. Importing only the `latin` subset CSS (`@fontsource/x/latin-400.css`) trims build output and precache size, which is relevant for the PWA effort.
- Other lazy chunks are already split correctly:

  | Chunk | Size |
  |---|---|
  | mermaid | 1,391 KB |
  | cytoscape | 444 KB |
  | katex | 261 KB |
  | cynefin diagram | 691 KB |
  | shiki wasm | 622 KB |
  | shiki grammars | up to 780 KB each |

  Make sure the PWA precache list excludes these, or caches them at runtime only.

---

## Suggested order of work

1. **Quick wins (about one day):**
   - W-2 (`isMarkdownFile` move)
   - W-3 (move `CreateProjectDialog`, lazy dialogs)
   - W-10 leak fix
   - W-11
   - W-12
   - W-16
   - W-17
   - W-18
   - W-20
   - the KnowledgeSettings fix from W-22

   W-2 and W-3 alone should take about 600 KB off main.
2. **Bundle:**
   - W-1 (ghostty dynamic import)
   - W-4 (chat shell + lazy runtime)
   - W-13 (palette shell)

   Re-measure main with the sourcemap; target under 800 KB raw.
3. **Data flow:**
   - W-6 (targeted events + server pagination)
   - W-7 (incremental transcript + virtualization)
   - W-8 (single freshness mechanism)
4. **Render:**
   - W-5 (split chat contexts)
   - W-9 (terminal per-id subscriptions)
5. **Health:**
   - W-14
   - W-15
   - W-19
   - W-21
   - W-23

   Do these incrementally alongside feature work.
