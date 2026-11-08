# Desktop update acceptance

## macOS without a paid signing account — 2026-11-08

The Mac adapter uses the existing About bridge, settings, state machine and
Restart to update action. It verifies the GitHub asset SHA256, bundle identity,
version, ad-hoc signature integrity and native architecture, then prepares a
sibling bundle before stopping the owned daemon. The detached installer retains
the previous app and waits for a version-specific startup acknowledgement after
the new app brings up its daemon. Failed replacement/startup restores the previous
app; a pre-replacement failure relaunches the existing app. No Gatekeeper settings
or paid signing credentials are used.

Native acceptance command (after building the host CLI):

```sh
PATH="$PWD/node_modules/.bin:$PATH" bun packages/desktop/scripts/mac-update-acceptance.ts --output /private/tmp/orc-mac-update-result.json
```

Pre-merge run `4d8f01fb-ec1c-4b1e-b029-400569a332ff` passed on Apple Silicon
macOS after integrating master `9fe5b20a` and rebuilding both fixture daemons:

```text
PASS darwin: packaged 0.1.61 -> 0.1.62; daemon, tasks, session and auth preserved
explicitInstallRequired: true
windowCloseKeepsDaemon: true
activationShowsWindow: true
previousDaemonPid: 95274
nextDaemonPid: 95362
taskPreserved: true
sessionPreserved: true
configPreserved: true
anonymous401: true
authenticated200: true
teardownVerified: true
```

The driver required the old version to remain active after download, the new
version's daemon and window to start after explicit installation, the helper's
`installed` acknowledgement, a retained previous bundle and loopback-only API
listeners. Fixture apps, data, candidate binary and disk images were removed
after verified process/listener teardown. Only concise result/log files remain.

For #176 the driver first closes the real BrowserWindow, verifies that it was
hidden rather than destroyed and that the same authenticated daemon/PID remains
healthy, then emits the activation event and requires the existing window's show
request. The final quit still verifies app/daemon exit and listener closure.
The production close/hide, activation and window-all-closed handlers were already
present in the macOS stability changes; this adds packaged regression acceptance.

Additional native regressions use private bundles: version/symlink rejection,
real ad-hoc signing/architecture validation, crash-on-start rollback, and
relaunch after a pre-replacement failure. Download tests use real loopback HTTP
and check bad checksums, channel/version ordering and untrusted URLs. The live
GitHub releases response selected v0.1.61 from 0.1.60 with SHA256
`c524e0acaa60c77eb1597a773797300e8a6f611684badc03627f6c28578fb61d`, and selected
no update from 0.1.61.

The native fixture substitutes GitHub discovery/download transport with its
private loopback publisher; production has no test-feed environment flag. The
fixture versions both contain the updater. Published 0.1.61 does not contain it
and still requires one manual installation of a future updater-enabled build.
This change has not published a release or modified the installed production app.
Windows/Linux native acceptance below is historical; those native installers
were not rerun on this Mac. Their updater remains electron-updater and its
installer-error regression runs explicitly for Windows on every host.

Review caught the missing startup acknowledgement and Intel architecture-name
mapping; both were corrected. Native validation also caught and corrected the
`lipo` argument order. The initial test package omitted its bootstrap resource;
that failure was isolated to the fixture and corrected, with early exception
reporting added to prevent modal test failures. The repository PR gate and docs
build passed; audit reported no vulnerabilities. The local ORC service was stopped
on both 7700 and 7701, so no live ORC task/session state was changed.

Pre-merge readiness also reproduced an end-user tooling gap by setting an
unavailable `DEVELOPER_DIR`: the `lipo` shim required Apple command-line tools.
Architecture validation now uses the stock macOS `/usr/bin/file` utility after
signature verification. The same signed-bundle test passes without developer
tools available to the updater.

The first full pre-merge gate exposed a scheduling-dependent SSH fixture:
`should bound command recovery and preserve the original deadline` assumed one
new process always starts within 100ms and always rejects with a setup-timeout
error. Existing execution semantics can instead expire during setup with no new
attempt, or terminate an already-started process with SIGTERM (exit 143). The
fixture now accepts those specific outcomes, still requires exactly three
untimed attempts and at most one additional timed attempt, and removes its owned
temporary directory after the child exits. Production SSH code is unchanged.
The targeted regression passed and a fresh reviewer found no important issues.

The full Mac browser run also exposed existing host-dependent fixtures. The E2E
HOME and Git fixture roots now use physical paths, preserving the production
agent symlink guard. Archive helper tests select Python 3 on Unix; terminal
shortcut tests use the emulated browser platform; native dropdown tests use
supported typeahead selection; the idle-stream test drains startup reads before
measuring its unchanged idle interval. Rules-page saves now adopt the canonical
workspace returned by the server, fixing a real hidden-policy bug when saving
through an alias. Rule tests retain aliased input and check the canonical result.
The focused rerun passed 42 scenarios, followed by all four dropdown scenarios.
The final complete gate and merge result are recorded on PR #235.

## Windows and Linux acceptance

PR #224 was exercised on 2026-11-08 with real packaged updater-enabled fixture
builds from the reviewed source. These runs predate the Mac helper acceptance
above and did not cover macOS.

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
  not changed. These Windows/Linux runs did not validate macOS; see the separate
  Mac helper acceptance above.
