# Windows and Linux desktop update acceptance

PR #224 was exercised on 2026-11-08 with real packaged updater-enabled fixture
builds from the reviewed source. macOS remains outside this feature pending
Developer ID signing and native installed-update acceptance.

The acceptance was rerun after integrating master
`fba793226f6398addd815cb186f0dd10ce51b260` (the approved #225/#226/#227 batch).
The runtime, web assets and all four fixture daemon binaries were rebuilt from
integrated source `536b45fa0eaa8f4cbc1e2eb1ea473ccb77815c96`; the follow-up
verification changes affect only the native fixture driver and documentation.
The inherited Vite fix is present;
`bun audit` reports no vulnerabilities across 1,099 packages.

The integrated Windows revalidation first rejected a fixture control timeout:
synchronous PowerShell process/listener inspection blocked the driver's own HTTP
server. The driver now uses bounded asynchronous inspection and requires evidence
that control requests were served during inspection. The following run exercised
real cached-payload installation without errors but correctly rejected the missing
fresh-payload request; electron-updater's cross-launch cache is keyed by checksum,
so a URL alias cannot force a fresh download. These red runs remain separate from
the final acceptance results.

Nir chose candidate rebuilding and a complete fresh cycle. Candidate-only
rebuilds in the existing output directories produced different checksums from
the cached payloads on both platforms; this was checked before launching either
final run. No fixture nonce, URL alias, cache deletion or cache move was needed.
All original error, fresh-download, persistence and teardown assertions passed:

- Windows: run `bdb1344d-412d-4e2f-b7b3-ea3c494903e1`, 34.6s; daemon PID
  56976 → 50832; 15 control requests served during asynchronous OS inspection.
- Linux: run `ed5836d5-97bf-49c7-906c-ac89730164b9`, 10.2s; daemon PID
  10124 → 10320. OS inspection completes quickly with `ss`.

The installed managed daemon binary's SHA-256 matches the newly source-built
daemon on each platform. Final candidate installer SHA-256 values:

- Windows NSIS: `241f810d6edf0889315bdd8895550ea3ef55f7fb3d44875f26827e0a21db97ec`
- Linux AppImage: `aa767daf70a0de8e400e58066ecc12aa1a158fdb567de7fb795ec1e4c273715a`

The About component, renderer bridge, display helper and viewport E2E source are
unchanged from the previously reviewed desktop/phone screenshots and two passing
viewport tests. The integrated batch did not change About or global styles, so
that UI evidence and Nir's approval are retained.

| Check | Windows x64 | Linux x64 |
| --- | --- | --- |
| Runtime | Windows, Electron 45 | Ubuntu WSLg, Electron 45 |
| Packaging | NSIS, private silent initial installation | AppImage, private installation |
| Actual application transition | 0.1.60 → 0.1.61 | 0.1.60 → 0.1.61 |
| Download / install / relaunch | Passed | Passed |
| Bundled daemon version and PID transition | Passed | Passed |
| Task and chat session records preserved | Passed | Passed |
| Configuration bytes preserved | Passed | Passed |
| Anonymous 401 / authenticated 200 | Passed | Passed |
| Actual API listener restricted to 127.0.0.1 | Passed on both starts | Passed on both starts |
| Unexpected recovery / updater / control errors | None | None |
| App and daemon exit / listener closure at teardown | Passed | Passed |

The fixture uses `packages/desktop/scripts/update-fixture.ts` as a test-only
packaged entry and `update-smoke.ts` as the native driver. It imports the production
main process, preload, updater and daemon lifecycle, invokes the real renderer
update bridge, and runs electron-updater's actual installer/restart path. It does
not replace the updater with a mock or override `app.isPackaged`.

Each platform has a unique fixture application identity, private installation,
HOME, Electron userData, daemon binary, database, configuration and cache. The
embedded bootstrap reapplies those paths on every launch, including the
installer-launched new version. The driver checks the private runtime identity
before creating marker records. Windows installer configuration disables desktop
and Start Menu shortcuts, elevation, file associations and protocol registration;
runtime startup/protocol integration and real notifications are suppressed only
in the fixture. Teardown verifies owned app/daemon PIDs have exited and the port
has no listener before recording success. Fallback process signals require
verified fixture ownership.

The first Linux run exposed a planned-stop race: daemon recovery could run before
the updater marked the application as quitting. The final run includes the fix
that sets the quitting flag before awaiting the owned daemon stop and rejects any
unexpected recovery dialog. Installer-failure restoration remains covered by
the focused updater regression.

## Fidelity boundaries

- The fixtures are unsigned and use a loopback generic HTTP update feed selected
  only in the test bootstrap. GitHub release discovery, public distribution and
  signing are not validated by this run. Production has no test feed flag.
- The minimal feed does not implement multipart byte ranges. electron-updater
  falls back from differential download to a complete payload download, which
  passes checksum verification and is the payload actually installed.
- Linux uses WSLg and AppImage extraction mode because FUSE is unavailable in the
  validation environment. This verifies the real Linux replacement/restart path;
  a FUSE-mounted desktop distribution remains a separate environment check.
- Both fixture versions already contain the updater. Previously published builds
  without this feature require one manual installation of an updater-enabled
  build; this test does not establish automatic bootstrap from those releases.
- Real user installations and data, releases, tags and production services were
  not changed. macOS installed-update/signing acceptance remains open in #193.
