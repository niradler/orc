# Windows and Linux desktop update acceptance

PR #224 was exercised on 2026-11-08 with real packaged updater-enabled fixture
builds from the reviewed source. macOS remains outside this feature pending
Developer ID signing and native installed-update acceptance.

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
