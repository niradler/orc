# Releases

The desktop app is the default installation. Run releases from Windows x64,
macOS ARM64, or Linux x64/ARM64 with Bun 1.4.2+, Git, GitHub CLI, npm and Docker
Buildx installed and authenticated. Docker must be running and able to push to
`niradler/orc`; npm must be able to publish `orc-ai`.

```sh
bun run release                 # show the next patch release plan; no changes
bun run release --check         # lint, typecheck, release tests and full test suite
bun run release --yes           # execute the release, then update this desktop
bun run release --resume --yes  # continue a failed release without another bump
```

Start with a clean, committed working tree. The command runs checks before changing
versions, aligns all workspace manifests, updates the lockfile, and commits the
patch bump. It builds all five standalone CLI binaries and packages/smoke-tests
the host's Electron installer locally. It pushes only the new annotated tag;
it never pushes a branch.

The tag triggers `release-desktop.yml`. Its matrix excludes the locally built
desktop target and builds/smoke-tests the other targets: Windows x64, macOS ARM64,
Linux x64 and Linux ARM64. The local command waits for those jobs, downloads their
installers, and publishes nine assets plus SHA256 checksums to GitHub Releases.
Only then does it publish npm and the `linux/amd64,linux/arm64` Docker image,
tagged with the release version and `latest`.

The final step quits the installed desktop app, installs the exact new host
installer, relaunches it hidden, and verifies the installed CLI and running
daemon version. Windows uses the per-user NSIS installer; macOS uses the DMG;
Linux uses an AppImage at `~/.local/bin/orc-desktop.AppImage`. Set
`ORC_DESKTOP_PATH` to the existing desktop executable for a custom installation.
The desktop app refreshes the CLI at `~/.orc/bin` on launch. Separately managed
daemons are never stopped automatically; an old daemon makes verification fail.
Desktop relaunch ignores development port, API-base, database and web-dist
environment overrides and uses the installed application's configuration.
Linux x64 installers use Electron's `x86_64` artifact suffix.

Progress is checkpointed in ignored `.orc/release-state.json`. Resume from the
same release commit and host. Failed steps stop immediately; successful publishes
are not repeated. If an Actions build fails, fix its root cause and rerun the
failed jobs before resuming. Preserve downloaded artifacts until the release
finishes. A release may be public on GitHub while npm/Docker is still pending;
the command does not report success until all stages and local updating pass.

Credentials come from each tool's normal local configuration and environment.
Do not put credentials or one-time passwords in command arguments. Refresh npm
login locally if authentication expires. macOS currently uses the project's
ad-hoc signing configuration; this flow does not add Apple notarization or
Windows signing certificates.
