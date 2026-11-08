# macOS updates without a paid developer account

Approved in chat on 2026-11-08: use a verified download and a separate installer
helper, preserving the same About controls and explicit Restart to update action
on macOS, Windows and Linux. No release/publication or signing-account purchase.

Goal: an installed ad-hoc signed Mac app can download a newer release, replace
itself after consent and relaunch, retaining the previous app for recovery.

Architecture: keep the shared updater state machine and renderer bridge. A Mac
adapter emits the same download/check events as electron-updater; it discovers
GitHub release DMGs, verifies their SHA256 and validates the staged app. A detached
system-shell helper waits for the old process to exit, swaps sibling bundles and
relaunches. Windows/Linux retain electron-updater. No Gatekeeper settings change.

Implementation and verification:

- [x] Add failing Mac tests for release/channel selection, hash mismatch, bundle
  identity/version checks and replacement rollback; verify failures before code.
- [x] Implement `mac-updater.ts` and installer helper, checking canonical paths,
  writable destination, process exit, bounded operations and one retained backup.
  Reject bad payloads before stopping the daemon. Keep downloads/staging bounded.
- [x] Route darwin through the Mac adapter in `updater.ts`, enable the existing
  preload bridge, and retain Windows/Linux behavior. Cover concurrent installs,
  repeated checks, preference changes and installer error recovery.
- [x] Extend packaged Mac acceptance using private app/data/configuration: actual
  check/download, explicit install, version and owned-daemon transition, task and
  session preservation, authentication, loopback listeners and teardown. Exercise
  failure recovery. Update install and desktop docs with the verified behavior.
- [x] Run desktop tests, lint/format, typecheck and the repository PR gate. Review
  the complete diff and record exact native evidence before reporting completion.

Review focus: untrusted URLs and malformed metadata; wrong or modified DMGs;
symlink/unwritable/translocated destinations; app exit or relaunch failure;
Windows/Linux regression. No credentials enter logs or renderer state.

Execution uses the existing clean checkout on fix/macos-free-updates, following
the repository instruction to reuse the active checkout and dependency tree.

Fresh review findings were fixed: startup acknowledgement/rollback, architecture
mapping and private test fixtures. Native acceptance and recovery evidence is in
`verification/desktop-updates.md`. No release publication or production app
installation is included in this implementation change.
