# Desktop preview acceptance and evidence

PR239, branch `code/desktop-browser-files`. This record separates implementation,
observed behavior and limits. It does not claim complete T3 Code parity or a
cross-platform production verdict. The reference is the local
`C:/Projects/orc/.examples/t3code` source; T3 itself was not run interactively.

## Capability and acceptance matrix

| Criterion | Reference and final implementation | Evidence / limit |
| --- | --- | --- |
| Agent actions | T3 `apps/server/src/mcp/toolkits/preview/handlers.ts` and `packages/contracts/src/previewAutomation.ts`; ORC `packages/core/src/desktop-preview.ts`, `packages/desktop/src/preview-browser.ts` | Snapshot, screenshot, click, type, press, scroll, hover, select, native pointer drag, condition wait and guest evaluation implemented. Real Electron + real MCP exercised these, timeout/reload, stale refs and cancellation. Drag requires both targets visible together; this is not full HTML5 drag-and-drop parity. |
| Useful agent context | agent-browser `skill-data/core/SKILL.md` and `references/snapshot-refs.md`; ORC snapshot refs and `preview-tools.ts` | Bounded 12,000-character default snapshots, region selection, stable refs, explicit truncation, no echo of typed input/evaluation source, native MCP image results. Replaced nodes fail without retargeting. Recovery after compaction is rediscovery → tabs → fresh scoped snapshot. |
| Session/client availability | T3 caller-thread preview capability; ORC MCP `server.ts`, `preview-tools.ts`, API `desktop-preview/broker.ts` | Real HTTP MCP tests cover full/meta list/search/describe/invoke, no target, unrelated session, multiple desktops, explicit client, pinned connection, revocation, reconnect and stale leases. Open tools require a matching desktop; browser actions additionally require an open guest and enabled access. Cached invocations recheck capability. |
| Agent connection | ORC `agent-runtime/src/{orc-mcp,claude,claude-sdk,codex,codex-app,acp,acpx}.ts` | Managed chats/channels inject their trusted stable ORC ID. Bound calls default to that conversation. SDK launch and URL-contract tests verify propagation; real MCP verifies the resulting connection contract. No paid model turn was used as test evidence. |
| Permissions | Desktop Session settings and Settings → Browser | Default ON; per-chat switch available before first preview; global OFF overrides it. Origin/session-scoped permissions are saved atomically. Actual Electron restart verifies revoked chat stays off. Leaving the chat releases its lease. |
| Immediate revocation | ORC native guest ownership and pending-mutation tracking | Read-only waits/results are cancelled. An interrupted pending mutation closes that guest before queued code can run; explicit Reload restores URL/profile and keeps file drafts. Real Electron injection delays a native mutation, revokes access and asserts zero HTTP side effects on the demo site. Already accepted website actions cannot be undone. |
| Tabs/navigation | T3 tab-target handlers; ORC `PreviewBrowser` and `DesktopPreviewWorkspace` | Stable tab IDs, new/select/close, popups in new tab, navigate/back/forward/reload. Eight tabs/chat, 24 total; explicit limit errors instead of eviction. Foreign, closed or inactive pinned targets fail. Browser tab contents are not restored across app restart. |
| Profiles/auth | T3 `apps/desktop/src/preview/BrowserSession.ts`; ORC `preview-profiles.ts`, panel selector and Browser settings | Dedicated saved profiles and per-chat temporary default. Sharing is an explicit user profile selection. Actual restart preserves selected profile login; another chat stays temporary until explicitly sharing. Metadata contains no credentials. Session cookies retain their real lifetime. |
| Selected login import | T3 `BrowserImport/{Sources,ChromiumKeys,ChromiumCookies,BrowserImport}.ts`; ORC `preview-import.ts` | User-only live-browser transfer from an explicitly enabled loopback endpoint. Real isolated Windows Edge source → selected site → ORC profile passed, including HttpOnly/SameSite preservation and exclusion of unrelated cookies. No source connection or cookie values go to agents/API. Source identity/targets are revalidated; cancellation closes connection; durable success waits for flush. |
| Import security | ORC `preview-import.test.ts` | Same-host/different-port regression proves `orc_session` cannot cross the import boundary. Partitioned, expired, foreign-domain and ORC credential cookies are skipped. Changed source identity fails before cookie reads. Partial writes are reported as failure, with counts. |
| Chat/files/edit/images | T3 `openFileInPreview.ts`, `PreviewPanel.tsx`; ORC `ChatAttachments`, `DesktopPreviewWorkspace`, file service, existing editors | Actual chat URL/Markdown/code/attachment paths; relative path with line reference; keyboard save; save conflict/reload; images; per-chat drafts; explicit source-opening actions. File containment/type/size/auth regressions use real filesystem/API. New panel remains desktop-only. |
| Layout/focus/recovery | ORC panel and native bounds | Real Windows float/drag/dock, pointer/keyboard resize, modal guest hiding, quit cancellation and owned daemon survival. Native captures include guest pixels. Code line navigation focuses its selection so the next edit reaches the requested line. |
| Guidance/SDK/packaging | Bundled platform web reference, SDLC development reference, public desktop/MCP pages, generated SDK | Source guidance and SDK updated to actual actions, discovery, profiles, import limits and context recovery. Source-built demo daemon's effective guide verified through real MCP. The live installed platform guide still resolves from an older bundled-skills cache; installation changes are forbidden, so that copy remains unchanged pending authorized normal distribution. Existing allowlist excludes validation harness assets. |

## Reproducible evidence

The existing local helper is `.claude/scripts/preview-integrated-validation.ts`.
It launches real Electron main/preload, the host-compiled CLI daemon, a loopback
demo site and authenticated MCP. Data, browser profiles, logs and control harness
stay under `.claude/validation/desktop-viewer`; captures are the five
`docs/public/screens/desktop-*.png` images. The test-only authenticated main harness
is outside shipping sources. Development credentials are loaded privately through
existing configuration, never written to the document or command arguments.

Focused source tests include `preview-{import,profiles,preferences}.test.ts`,
`mcp-preview-capabilities.test.ts`, desktop-preview API tests, MCP meta/content tests
and agent-runtime MCP injection tests. Final required local checks and exact Git
revision are recorded in the PR and current handoff after they finish.

## Explicit remaining differences and evidence limits

- This is **live-browser cookie transfer**, not T3's direct cookie-store importer.
  It requires a user-enabled debugging endpoint; normal personal profiles may not
  expose one. T3's current Chrome/Edge source definitions exclude Windows because
  of app-bound encryption. ORC does not bypass that protection. Native Chrome144+
  consent flow and macOS/Linux interactive import were not validated.
- Only cookies applicable to selected sites' root/current open-page paths transfer.
  Passwords, localStorage, IndexedDB, device-bound and partitioned sessions are not
  imported. A positive count does not establish a working login on every site.
- Native picker results are injected; actual OS picker interaction is unverified.
  External-opening calls are intercepted; real OS browser/VS Code handoff remains
  unverified. macOS/Linux interactive desktop behavior is unverified.
- Stalled-call and queued-mutation timing are injected at the native boundary;
  normal action, import, save and restart paths use actual Electron/MCP. This is
  not evidence for every possible hung-site/process failure.
- T3's broader iframe/semantic locator/dialog automation, recording and appearance
  controls are not implemented here. PDF/Office previews, profile rename/removal
  and browser-tab restoration are also absent. These differences remain visible;
  they are not evidence of equality or superiority to the whole competitor.
- Screenshot evidence covers demo data only. A passing local gate does not settle
  these product/platform limits. Human review remains required; no merge, release,
  deployment or installation upgrade is authorized.
