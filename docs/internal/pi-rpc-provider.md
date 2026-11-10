# Native Pi RPC provider

Approved: native RPC provider and PR; use upstream SDK schemas; production lifecycle and capability coverage.

Architecture: `pi --mode rpc` under ORC host transport. Import upstream public protocol types only (SDK pinned dev dependency); no SDK runtime embedded in ORC. A private, temporary Pi extension registers the scoped ORC MCP server and gates tool calls through RPC confirm dialogs. Existing provider secrets, host selection, session identity, events and UI controls remain authoritative.

Scope and evidence:
- [x] Typed bounded JSONL transport: correlation, malformed records, stream fragmentation, request deadlines, backpressure, unexpected exit and bounded shutdown.
- [x] Native sessions: fresh identity, strict resume without accidental replacement, multi-turn events, final settlement after retries, errors, usage, images, steering, abort with queue clearing.
- [x] Questions and tool permissions: map Pi extension dialogs; expiration/cancellation; fail closed on bridge failure; live permission changes. Session-scoped MCP injection without modifying Pi user/project settings or exposing credentials in argv.
- [x] Provider wiring: registry, options (thinking/queue/retry/compaction), executable, discovery, terminal, manual compact, docs. Fork/rollback remain false because ORC has no corresponding operation.
- [x] Protocol and real pinned Pi CLI tests, loopback model/MCP fixtures, HTTP chat lifecycle, review regressions and phone/desktop provider UI. Delivery runs the clean-tree PR gate before pushing, then opens one PR; merging and installation are outside scope.

Files: agent-runtime/pi.ts + pi-rpc.ts + pi-extension.ts and tests; core coding-agents/chat-options/providers; runtime models/index/capabilities; API chat compaction; existing provider option editors; docs configuration/connect-agents/desktop-and-web.

Review focus: events arriving before prompt response; handled extension commands without agent events; cancelled session restore; pending dialogs during stop/exit; credentials in child diagnostics; official client/CLI version differences.

Ruling: reuse the clean active checkout on feat/pi-rpc-provider to avoid a duplicate dependency tree (repository disk guidance).
SDK: @earendil-works/pi-coding-agent 1.5.2 provides exported RpcCommand/RpcResponse/JsonAgentSessionEvent/RpcExtensionUIRequest/RpcExtensionUIResponse. Types are compile-time contracts, not runtime validation; external records also require validation.
Environment: PATH bun was 1.3.14 and could not read repository lockfile v3. Restored the original lockfile and reran with repository node_modules/.bin/bun 1.4.4; use that binary for all remaining commands.

Verification so far: official bundled Pi 1.5.2 CLI against loopback-only model/MCP fixtures verifies questions, denied/allowed file writes, native resume, images, steering, live edit permissions, cooperative abort, authenticated scoped MCP and settings preservation. Transport tests verify malformed data, fragmentation, Unicode, exit, deadlines and suspended human-dialog deadlines. All workspace typechecks passed before final cleanup; bun audit returned {}.

Limits: Pi custom TUI components, editor replacement, native account quota, ORC rule interception, fork/rollback UI are not exposed. MCP startup and approval bridge fail closed. Session resume uses the exact native UUID. Pi resolves existing UUIDs and rejects missing ones; path arguments are refused before launch because Pi creates missing path sessions. No production install or merge is authorized.

Independent review: seven reproduced integration/lifecycle findings fixed with regressions: runtime UUID accepted by chat, Pi permission forwarding, stopped extension turn ownership, shutdown-dialog rejection, bounded stream drain after exit, handled extension errors, legacy permission label. Additional API regression delays terminal errors until retry settlement; actual HTTP model discovery/chat/resume/compact pass against bundled Pi. Private prompt files avoid long system instructions on argv. Windows npm shim resolution is covered on this host; live Windows/SSH validation is unavailable.

Validation record: focused run `bun test packages/agent-runtime/src/__tests__/pi*.test.ts packages/api/src/__tests__/pi-chat.test.ts packages/api/src/__tests__/terminal-launch.test.ts packages/web/tests/unit/composer-chips.test.ts` passed 78 tests with 1 Windows-only skip. Provider/options browser run passed 4 tests at 390px and 1440px, including help focus/hover/tap/dismissal and save/reload. Docs build passed with existing bundle-size and `env` highlighting warnings. The first full `ci:pr` passed in 222s before final review fixes; the final push hook re-runs the complete gate. No deferred review findings.

SDK contract audit: `bun run sdk:generate` adds the Pi options variant at all 17 shared request/response sites; no unrelated generated changes. SDK typecheck and all 5 SDK tests pass. PR: https://github.com/niradler/orc/pull/254.

Final handoff (user will finish; leave PR unmerged): fixed native reload losing scoped MCP by retaining config in the private extension module, rechecking MCP and reapplying explicit options after reload. Native switch/fork/tree replacement is cancelled; every turn checks the native UUID. Handled extension commands that start model work now wait for actual idle/settlement. New official-Pi regressions pass: 18 integration/API tests, zero failures; runtime typecheck passes. Full ci:full has not been run. Live Windows/SSH remain unverified. Native Pi queue/retry/automatic-compaction setters persist host settings; this is now tested, but the UI/docs need to disclose the side effect or the integration needs an isolation decision before a production-ready claim. Re-review these last lifecycle changes before merging. User requested commit/push plus a PR gap comment, superseding merge authorization.
