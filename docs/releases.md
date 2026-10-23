# Releases

The desktop app is the default installation. Run releases from Windows x64,
macOS ARM64, or Linux x64/ARM64 with Bun 1.4.2+, Git, GitHub CLI, npm and Docker
Buildx installed and authenticated. Docker must be running and able to push to
`niradler/orc`; npm must be able to publish `orc-ai`.

```sh
bun run release                 # show the next patch release plan; no changes
bun run release --check         # lint, typecheck, release tests and full test suite
bun run release --verify        # verify the existing release; no publish/install
bun run release --prepare --yes # checks, patch bump and local builds; no publication
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

npm publication uses a prepared archive whose checksums are checkpointed before
submission. The command waits for both public metadata and downloadable archive
bytes to match that archive. An accepted or uncertain submission is verified on
resume rather than submitted again. A definite authentication rejection allows a
retry after npm configuration is corrected.

Docker candidates for both architectures must start successfully before either
public tag is pushed. Checks cover API version, rejected unauthenticated requests,
accepted authenticated requests, dashboard HTML and a served asset. After the
push, fresh pulls by each architecture's immutable digest repeat those checks and verify the image's
source revision. A resume after publication repeats validation without another
build/push. Stopped validation containers are retained as evidence.

The final step quits the installed desktop app, installs the exact new host
installer, relaunches it hidden, and verifies the installed CLI and running
daemon version. Windows uses the per-user NSIS installer; macOS uses the DMG;
Linux uses an AppImage at `~/.local/bin/orc-desktop.AppImage`. Set
`ORC_DESKTOP_PATH` to the existing desktop executable for a custom installation.
The desktop app refreshes the CLI at `~/.orc/bin` on launch. Separately managed
daemons are never stopped automatically; an old daemon makes verification fail.
Desktop relaunch ignores development port, API-base, database and web-dist
environment overrides and uses the installed application's configuration.
It starts in the installed application's directory so the repository's `.env`
and project configuration are not reloaded by the standalone executable.
Linux x64 installers use Electron's `x86_64` artifact suffix.

Progress is checkpointed in ignored `.orc/release-state.json`. Resume from the
same release commit and host. Failed steps stop immediately; successful publishes
are not repeated. If an Actions build fails, fix its root cause and rerun the
failed jobs before resuming. Preserve downloaded artifacts until the release
finishes. A release may be public on GitHub while npm/Docker is still pending;
the command does not report success until all stages and local updating pass.
Installation alone does not mark an unfinished release complete.

Final verification checks the remote source tag, every GitHub asset digest and
the published checksum file, npm archive checksums, and the GitHub/npm/Docker
latest pointers. Docker must contain both architectures, and the installed
desktop, CLI and daemon must report the release version. A managed verification
summary is added to the release notes while preserving the authored notes.

`--verify` repeats public-artifact, image runtime and installed-version checks
for the checkpointed release. It does not publish, bump versions, install or
change the checkpoint. Keep the prepared npm archive with the checkpoint.

Credentials come from each tool's normal local configuration and environment;
npm uses its standard user configuration (normally `~/.npmrc`). The release
command does not fetch, copy or store credentials.
Do not put credentials or one-time passwords in command arguments. Refresh npm
login locally if authentication expires. macOS currently uses the project's
ad-hoc signing configuration; this flow does not add Apple notarization or
Windows signing certificates.

## Operator protocol

Use this protocol for a requested GitHub/binaries, npm and Docker release, followed
by local or homelab updates when those installations are included in the request.
Read the latest `.claude/docs/releases.md` handoff and refresh live ORC guidance
first. The handoff records a particular run; this document is the reusable procedure.

1. **Establish the source and scope.** Inspect the branch, HEAD, working tree,
   manifests, latest public versions and `.orc/release-state.json`. Confirm the
   intended changes are committed and select the next version through the release
   command. An unfinished checkpoint requires resuming its original commit and host;
   do not clear it, change completion flags or bump again. Release authorization
   permits the release tag; pushing `master` requires fresh explicit consent.

2. **Check tools and installations.** Verify Bun, GitHub/npm authentication and
   Docker Buildx using their normal secure configuration. Inventory the installed
   desktop, daemon and every CLI found on PATH; fallback standalone and npm installs
   can be older than the active desktop CLI. Inspect actual SSH/Compose targets
   instead of assuming the previous deployment is unchanged. Run checks locally.
   Before using the desktop matrix, verify repository visibility and current runner
   billing; use only runners within the authorized cost scope.

3. **Prepare recovery material.** Check for active terminals, tasks and job runs.
   Stop only the owned service for a consistent private backup, preserving SQLite
   sidecars, knowledge originals, config, encryption keys and relevant deployment
   files. Retain the prior image/binary and record baseline source-table counts,
   health and backend readiness. Test actual migrations against a separate copied
   database, with integrity and source-data preservation checks. Derived FTS/shadow
   tables can change during initialization; verify search coverage separately and
   surface defects rather than treating source-data checks as interchangeable with
   index counts. Preserve unrelated services and supplied originals.

4. **Run the canonical release.** Use `bun run release --yes`, or stage it with
   `--prepare --yes` and then `--resume --yes`. Keep a bounded process and a distinct
   log. Let the command perform validation, version commit, binaries/host installer,
   tag, non-host native builds, checksummed GitHub publication, npm, Docker candidate
   and immutable published-image checks, installation and final verification.
   Successful public stages are not repeated. An accepted or uncertain npm submission
   must be verified on resume, never submitted again just because metadata or the
   archive is still processing. Investigate failures before retrying; preserve
   artifacts and checkpoints during runner queues or transfer delays.

5. **Preserve installed configuration during relaunch.** Launch the installed app
   from its installation directory with an explicit environment that excludes
   repository development overrides. In particular, an empty `ORC_API_SECRET` can
   override a nonempty stored `api.secret` and silently enable open mode. Preserve
   the installation's intended auth mode; do not change its stored secret to make a
   probe pass. Use a launcher that actually supplies the filtered environment:
   `release-lib.run()` merges its environment with the parent and can restore a
   variable omitted from an override object.

   `desktopLaunchEnv()` filters ports, API base, DB path, web-dist overrides and
   an empty `ORC_API_SECRET` (the auth regression observed in 0.1.40). A nonempty
   environment secret is preserved for installations intentionally configured that
   way. The launcher passes the filtered environment directly, without merging the
   removed override back in. Verify authentication after installation; a successful
   version check alone does not prove the installed service is configured correctly.

6. **Update and verify each requested installation.** Verify desktop product version,
   bundled/user/fallback CLI versions and the actual daemon. Check intended anonymous
   access, authenticated resource reads, dashboard HTML and a served asset; secrets
   must not appear in dashboard bytes. For an authenticated installation, require
   anonymous `401` and authenticated `200`. For homelab, SSH to the configured alias,
   pull the verified immutable release image, recheck quiescence, back up and test
   copied migrations before replacement, then update only the ORC Compose service.
   Preserve command overrides, environment, data/SSH mounts and read-only flags,
   binding, networks, DNS, memory/security settings and agent-loop configuration.
   Compare custom patches with the release source before replacing a custom image.
   Adapt version/digest/Compose-hash guards in previous operational helpers; never
   execute a version-specific deployment script unchanged for a new release.
   Verify container health/restarts, DB integrity and source-data counts, config
   bytes, auth, dashboard/assets, configured SSH and the external origin using
   existing protected-access credentials. Compare backend readiness with its baseline;
   a missing login is not evidence of an upgrade regression or a successful model turn.

7. **Finish with evidence.** Require matching GitHub tag/asset/checksum data, npm
   archive/latest, Docker version/latest and both architectures, and all requested
   installed versions and health checks. Publish readable feature notes while
   retaining the managed verification summary, then reread them. Update
   `.claude/docs/releases.md` with commit, digest, private backup locations, logs,
   actual outcomes and remaining issues; record the ORC session summary. Keep
   recovery material and credentials private. Do not silently republish an immutable
   version or clean up retained evidence as part of declaring completion.
