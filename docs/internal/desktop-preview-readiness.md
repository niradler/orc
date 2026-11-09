# Desktop preview acceptance and evidence

PR239, branch `code/desktop-browser-files`. The implementation targets production
review; this record separates capability, observed behavior and native-platform
evidence. Reference source: the open-source T3 Code repository (MIT, T3 Tools Inc.,
2026); substantial cookie-format adaptations retain the desktop third-party notice.
T3 itself was inspected as source, not run interactively.

## Capability and acceptance matrix

| Criterion | Source comparison / ORC implementation | Acceptance evidence |
| --- | --- | --- |
| Core agent actions | T3 `packages/contracts/src/previewAutomation.ts`, server preview handlers; ORC core action contract, `preview-browser.ts` | Snapshot/screenshot, trusted Chromium click/type/pointer input, key presses/modifiers, scroll, hover, empty/multiple select, drag, condition wait, page-context evaluation. Real Electron/MCP covers actions, page globals, timeout/reload, stale refs and cancellation. HTML5 drag receives a separate runtime check from the earlier custom mouse-drag fixture. |
| Semantic locators and frames | T3 preview locators; ORC `preview-frames.ts` and semantic selectors | CSS/ref or role/text/label/placeholder/testid objects; owned frame enumeration/selection; cross-origin snapshots and automatic ref-to-frame routing. Real cross-origin action, page-global evaluation, ancestor-overlay rejection and detached-frame failure. Ambiguous matches fail. Rotated/scaled frame pointer layouts currently fail explicitly rather than guessing coordinates. |
| Dialogs | T3 dialog contract; ORC debugger plus `preview-guest-preload.ts` | Pending dialog state and explicit accept/dismiss/status. Real Chromium alert/confirm accept/dismiss and main-page prompt responses from MCP, user UI and keyboard passed. Electron disables native prompt, so a minimal standard prompt-only adapter restores it without exposing ORC APIs, general IPC, Node, credentials or filesystem access. The validation client keeps guest dialogs pending instead of Playwright's default auto-dismiss, so this tests the actual Chromium dialog protocol. |
| Context efficiency / recovery | agent-browser core skill and snapshot-ref guide; ORC MCP descriptions and platform guide | Default 12,000-character snapshots, 1,000-24,000 limits, region selection, stable bounded refs, truncation and native MCP images. Actions do not echo typed text/evaluation source. Recover after compaction through scoped discovery, tabs/dialog status and fresh snapshot; inspect uncertain delivery before retrying side effects. Page text stays untrusted evidence. |
| Discovery and effective connection | ORC MCP full/meta discovery, preview broker, agent-runtime backend bindings | Real HTTP MCP tests cover ordinary listing and meta search/describe/invoke, no target, foreign session/project, multiple clients, explicit/pinned client, revocation, reconnect and stale leases. All managed agent launch paths inject the stable ORC conversation ID. No app-wide CDP endpoint is given to agents. No paid model turn is claimed as validation. |
| Durable permissions and immediate revoke | Native preferences, Session settings and Browser settings | Default ON, per-chat switch before first preview, global override, atomic origin/chat persistence. Actual app restart keeps revoked permission. Leaving chat releases capability lease. Queued mutation injection proves zero late site side effects; interrupted mutations close the guest and require Reload. Accepted site operations cannot be undone. |
| Browser tabs and navigation | T3 tab/profile host; ORC browser host, profile metadata and workspace UI | New/select/close/popups, stable tab IDs, navigation/history/reload; eight/chat and 24 total with explicit errors. URLs/selection restore on actual app restart before another link is clicked. Per-chat isolation and explicit shared-profile behavior verified. Restoration preserves browser URLs, not a crashed site's in-memory JavaScript state. |
| Profiles and authentication | T3 BrowserSession/BrowserImport; ORC profile service and Settings | Named persistent profiles, temporary per-chat cookies/storage, explicit sharing, rename and confirmed removal. Actual restart preserves login. Removal closes profile tabs, waits for cancelled imports, clears site data/cache and resets durable selections; file drafts remain. Removal cancellation and paused-import race have separate scenarios. |
| Direct store and live login import | T3 `BrowserImport/{Sources,ChromiumKeys,ChromiumCookies,FirefoxCookies,SafariCookies}.ts`; ORC `preview-store-import.ts` and `preview-import.ts` | Selected source profile and sites; readonly SQLite snapshot/cleanup; OS-derived keys; GCM/host-hash validation; precise cookie flags/expiry. Real Windows Firefox store and real isolated Edge live transfer passed. Synthetic native Windows DPAPI/Helium-store scenario validates that additional path. Pure CBC/GCM/Safari corruption tests cover formats; macOS/Linux OS integration needs native acceptance. Modern Windows Chrome/Edge app-bound stores use live transfer, as T3 also excludes their direct import. |
| Import privacy and truthful outcomes | Native-only opaque grants and import tests | No key/cookie value/source connection in API or MCP. Exclude ORC session credentials, foreign/expired/partitioned cookies and Firefox containers. Source identity is revalidated, cancellation is checked through final flush, partial errors report counts. Passwords/localStorage/IndexedDB/device-bound credentials are not copied. Login success must be checked at the site. |
| Browser uploads and downloads | T3 upload/download flows; ORC trusted workspace reader, native download staging and artifact save routes | Explicit workspace uploads (8 MiB/file, 16 MiB total), canonical containment/auth and traversal rejection; guest-only file inputs. Browser downloads are capped at 16 MB, four staged across the app, with completion/failure states and safe names. Saving returns a trusted session-workspace path; no automatic execution or arbitrary local output path. Real upload bytes and completed-download contents verified through MCP. Failed-download retry/budget regressions pass. |
| Recording and appearance | T3 recording compositor, resize/color-scheme contract; ORC guest recorder and display controls | Guest capture only, no audio/ORC pixels, isolated networkless encoder, playable WebM <=16 MB and <=180 seconds; workspace save returns metadata/path, not video in agent context. Real decode/playback and modal guest hiding verified. Pending finalize stays cancellable and bounded; stalled-finalize/revoke test returns error and destroys the encoder. User can download completed output if workspace saving fails. Color scheme/reduced motion and viewport effects observed in the guest. |
| Chat, paths, editing, images | T3 PreviewPanel/openFileInPreview; ORC chat links/attachments and existing editors | Actual attachment, relative path with line reference, Markdown read/edit/split, code edit/Ctrl+S, disk save/reopen, external conflict/draft preservation/reload, images and per-chat drafts. Files retain canonical host/workspace containment, size/type/auth checks. PDF/Office are outside the requested preview formats. |
| Layout, keyboard, focus, recovery | ORC desktop-only workspace, native view bounds | Float/drag/dock and pointer/keyboard resize, settings modal guest hiding, quit cancellation and owned-daemon survival. Code-line navigation focuses the requested line. Recording modal uses existing accessible dialog/focus handling. New panel and settings remain absent on ordinary web/phone. |
| Guidance, SDK, packaging | Bundled platform/SDLC sources, public docs, generated SDK and desktop asset allowlist | Updated to the real operations, limits and recovery contract. A reproduced persistent-cache bug kept older bundle paths after upgrade; the cache now invalidates when the bundle directory changes. A regression and actual compiled-daemon startup verify current effective platform/SDLC guidance through real MCP. Packaging includes only production main/preloads plus third-party notice, never the test harness. No live installation was upgraded; distribution remains separately authorized. |

## Evidence and final checks

The integrated validation helper and its isolated demo home/database/workspace/
profile and bounded logs are local-only evidence (gitignored `.claude/` paths) and
are not part of the repository. The helper launches actual Electron main/preloads,
the host-compiled CLI daemon and authenticated real MCP, using loopback listeners.
Credentials load privately from existing development configuration. No personal
browser/profile is read. The authenticated main harness is test-only and excluded
from shipping assets.

Committed screenshots under `docs/public/screens/desktop-*.png` capture the actual
native window including sibling guest pixels. Focused tests cover permissions,
profile storage, cookie-import security/formats, download retry/budget, artifact
auth/containment and real HTTP MCP discovery. The final run results, required
local hook gate, exact implementation/PR head and screenshot refresh are recorded
in the current handoff and PR description after completion.

After the authorized update from master, the complete Electron/compiled-daemon/MCP
journey passed, including real Chromium alert/confirm handling, prompt keyboard
responses, bounded frame snapshots, contenteditable typing, HTML5 drag/drop, native
Windows DPAPI import and the import/removal race. Focused checks across browser/API
security, agent bindings and bundled skills passed; see the PR for current counts.
All workspace typechecks and the docs build passed. An additional real compiled
startup verifies stale bundled-cache recovery. The mandatory pre-push gate is
reported with the exact pushed head in the PR; these checks alone do not replace
the native-platform limits below.

A separate authenticated-site journey verifies a server-enforced anonymous 401,
selected-site login transfer from actual isolated Edge, agent access to protected
content, and the same protected content after a real app restart. This exposed
an idle `Runtime.terminateExecution` call during restoration that crashed the
Chromium guest; termination now requires an active read. Crashed guests fail
explicitly with Reload recovery. Read-only snapshots/frame lists also retry
bounded navigation-context replacement while rechecking permissions; mutations
are never retried. A focused regression covers this.

## Native evidence and operational limits

- Native file-picker results are injected. Actual OS picker interaction remains
  a human acceptance check; Playwright CDP does not automate the Windows file dialog.
- External-opening calls are intercepted. Actual OS browser/VS Code/reveal handoff
  remains a human acceptance check.
- Windows Electron is exercised interactively. macOS/Linux Electron, Keychain,
  Secret Service and Safari Full Disk Access behavior require those platforms.
  Missing/denied OS access produces an error/skip count, not claimed success.
- The source-based comparison establishes implemented operations and tested ORC
  workflows, not universal equality to an entire competitor or every website.
  Semantic matching is deliberately strict about ambiguity; complex transformed
  iframe pointer layouts, cross-viewport drags and system clipboard shortcuts are
  rejected instead of crossing security boundaries or silently retargeting.
- Chromium dialogs and prompt-shim behavior passed on Windows; they should also
  be exercised on each other release platform. Source/key format fixtures do not replace
  approval testing with the real macOS/Linux browser installation.
- No live installation is upgraded by this source PR. No PR merge, release,
  deployment, default-branch push or installation upgrade is authorized here.
