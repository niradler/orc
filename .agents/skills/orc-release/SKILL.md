---
name: orc-release
description: Run or resume the ORC release fast and clean, then update the local desktop install and the homelab. Use for ORC release, installation upgrade, or lab rollout requests. Self-improves after every release that hit a problem.
---

# ORC release

The goal is one uninterrupted pass: green CI, publish everywhere, local install updated,
lab updated, report. [docs/development/releases.md](../../../docs/development/releases.md)
is the authoritative protocol. This skill is the fast path plus the known traps.
Read `.claude/docs/releases.md` (last handoff) for the previous release's state.

## Fast path

1. **Preflight (2 min, all in parallel).**
   - `git fetch`. Check `git show origin/master:package.json` version against
     `npm view orc-ai version`. If master is behind npm, the last `chore: release`
     commit never landed, so push it first.
   - Check `gh auth status` and `docker info`. Check `autho status --json` shows the
     vault unlocked.
2. **Dedicated worktree.** `git worktree add --detach .orc/worktrees/release-<v> origin/master`
   then `bun install` in it. Never release from the main checkout.
3. **Gate locally before tagging.** Run `bunx biome check ./packages ./scripts` and
   `bun run ci:full` with the gate overrides below. Fix failures in a PR, merge it,
   then reset the worktree to the new origin/master.
4. **Release** from PowerShell, in the background, with output going to a scratchpad log.
   Export the gate overrides for the release process too — `bun run release` inherits
   the environment and otherwise runs the default four shards, which is where the
   shard stalls (#336) come from:
   `$env:PW_SHARDS="2"; $env:PW_RETRIES="1";
   $env:NPM_CONFIG_USERCONFIG="<scratch>/npmrc"; $null | autho exec --map "NPM_TOKEN=npm token" -- bun run release --yes`.
   The npmrc contains only `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`.
   Watch `.orc/release-state.json` `completed[]`, because the log stays empty while
   autho buffers. Resume after a failure with `--resume --yes`.
   Accepting the npm archive without serving it ("npm publication is not public yet")
   is normal lag: check `npm view orc-ai version`, then `--resume --yes`.
5. **While macOS builds, back up the lab.** Run these on `lab-z170mx`
   (sudo password: autho `homelab` via `sudo -S`). Send every remote script as a
   base64 file (`echo <b64> | base64 -d > /tmp/x.sh && bash /tmp/x.sh`), never as a
   quoted inline string — see the PowerShell trap.
   - Check quiescence first (active tasks/jobs/flows/gateway sessions/terminals
     via DB + `/api/terminals`). Stale `doing` tasks whose id+`updated_at` match
     the list already approved in the handoff are tolerated; anything new or
     changed needs Nir's approval.
   - Stop orc.
   - `tar -czf` `/srv/docker-data/orc` together with `compose.yaml` and
     `/opt/homelab/secrets/orc.env` into `/mnt/backups/orc-before-<v>-<ts>/`.
     Also copy `orc.db` there as `migration-check.db` (WAL sidecars vanish on a
     clean stop) for the rollout smoke test, tag the prior image
     `homelab-orc:before-<v>-<ts>`, and write `SHA256SUMS` plus a
     `verification.json` (stopped-window `docker events` start-audit, entry
     counts, integrity, counts baseline) into the backup dir.
   - Verify the archive from the listing: write it to a file once, then check
     membership with `grep -qxF -- ./orc.db <<<"$listing"` (herestring, never
     `printf | grep -q`). Directory entries carry a trailing slash (`./knowledge/`).
     Absent `daemon.pid`/`daemon.json`/`orc.db-wal`/`-shm` in the listing are
     expected: graceful stop removes them. Then start orc again.
6. **Lab rollout after Docker publishes.**
   - Pull `niradler/orc:<v>@sha256:<digest>`; check `arch=amd64` and label
     `org.opencontainers.image.revision` == the release commit.
   - Smoke-test the image on a **fresh** extract of the backup's `data.tgz`
     with `daemon.pid`/`daemon.json` deleted:
     `docker run -d --network none --env-file /opt/homelab/secrets/orc.env -v <copy>:/data <image>`,
     probe via `docker exec … bun` (no egress, no open port, no Telegram
     interference). Health is **`/api/health`**. Expect: health 200 + version,
     anonymous 401, authenticated 200, dashboard+assets 200, no secret in HTML,
     `integrity_check` ok, table/tasks/FTS counts == baseline. Then delete
     container and copy.
   - Pin `tag@digest` in `/opt/homelab/stacks/orc/compose.yaml` (root-owned;
     sudo, keep a `compose.yaml.before-<v>` copy, guard that only the image
     line changes). The lab docker has **no compose plugin**: run compose
     through the `homelab-code-server` helper image with docker socket, stack
     dir and `orc.env` mounted, `--project-name orc`:
     `up -d --no-deps --no-build --pull never orc`.
   - Verify: healthy/restarts=0; in-container `/api/health` 200 + version,
     anonymous 401, authenticated 200, dashboard and assets load, skills,
     agents and knowledge counts present, integrity ok, env names and
     mounts/ports/cmd/security settings unchanged; then the public origin
     `https://orc.niradler.com/api/health` with CF Access service-token headers
     from autho `homelab-access` (username = `CF-Access-Client-Id`, value =
     `CF-Access-Client-Secret`); without them Cloudflare returns its login page.
7. **Local desktop.** The release relaunches the desktop. Confirm the `orc --version`
   of both the bundled and the user CLI.
8. **Finish.**
   - Get the release commit to master through a PR. Pushing master directly needs
     Nir's consent.
   - Keep **one** lab backup: the new verified one. Delete older
     `/mnt/backups/orc-before-*` and the stray `/srv/docker-data/orc/{backups,.orc/backups}`.
   - Update `.claude/docs/releases.md`.
   - Tell Nir: "lab ready for sanity".

Speed rules:
- Run independent steps in parallel.
- Don't wait idle on CI; do the next step instead.
- File GitHub issues for non-critical findings instead of fixing them mid-release.
- Fix only what blocks a clean release.

## Known traps (fix → prevent)

| Symptom | Cause | Fix |
|---|---|---|
| GitHub asset upload `HTTP 502: Error creating policy` | Transient GitHub Releases upload failure | `--resume --yes`; uploads are idempotent (`--clobber`) |
| Typecheck: two drizzle copies, `shouldInlineParams` | Worktree without `node_modules` resolves the main checkout's | `bun install` in the worktree |
| Git Bash `cd` exits 1 with an fnm error and nothing runs | fnm shell hook | Launch from PowerShell with `Set-Location`, or use absolute paths |
| npm step "Unexpected npm release archive" | package.json changed under a shared checkout | Dedicated worktree, then `--resume` |
| npm PUT 202 and the version is not visible yet | Registry processing lag (up to 15 min or more) | `--resume` later; it won't republish |
| Desktop verify timeout | `~/.orc/bin/orc.exe` locked by editor `orc mcp` processes | Ask Nir to close them, then `--resume --yes` |
| Lab `docker build`/`docker compose` prints usage or not found | Lab docker CLI has no build/compose subcommands | buildx plugin path for builds; `homelab-code-server` helper container with docker socket for compose |
| Bump collides with an existing npm version | Previous release commit never reached master | Preflight version check (step 1) |
| Fix PR's `changed` check sits queued | Homelab runner session went stale (container replaced) | Cancel the run, then `gh run rerun <id>`; check `gha-runner-pool.service` on the lab |
| Backup tar prints `socket ignored` | SSH control sockets in `/data/.orc/ssh` | Harmless; sockets don't need backing up |
| Backup verify claims `orc.db` missing though the archive is fine | grep/pipefail SIGPIPE. `tar -tzf \| grep -q` kills tar; `printf '%s\n' "$listing" \| grep -qx` kills printf on the FIRST match, so a present file reads as missing | Materialize the listing once, then `grep -qxF -- ./orc.db <<<"$listing"`. Directory entries carry a trailing slash (`./knowledge/`), so match that form |
| Canonical gate fails with `connect ETIMEDOUT 127.0.0.1:<port>` in unrelated specs | `bun run release --yes` inherits no overrides and runs the default four shards (#336) | Export `PW_SHARDS=2 PW_RETRIES=1` before `bun run release`; with a clean tree a failed pre-flight gate needs no resume |
| Remote script mangles itself, or a *later* step of it runs early | PowerShell expands `$(...)`/backticks inside a double-quoted `ssh` argument locally, so the remote gets a broken string that can still execute its leading commands (this restarted orc inside the backup window once) | Ship scripts as files: `echo <base64> \| base64 -d > /tmp/x.sh && bash /tmp/x.sh` |
| Smoke counts are missing or `no such table: skills` | There are no `skills`/`agents` SQL tables, and the API collections are objects (`{skills:[…]}`), not arrays | Count through the API: `/api/skills`, `/api/agents`, `/api/projects`, then `.skills.length` etc. |
| Recreate changes DNS/mounts that "should" be identical | The lab `compose.yaml` is the source of truth and may have been edited after the last deploy (0.1.67 shipped a DNS change from `192.168.7.20` to `192.168.7.29`) | Diff the running container against `compose.yaml` before the rollout, keep the compose diff to the image line, and report any other drift the recreate applies |
| Smoke daemon exits: `daemon already running (pid N)` | Stale `daemon.pid` in reused/copied data (prior smoke was `rm -f`'d, not stopped) | Delete `daemon.pid`/`daemon.json` from the copy; always re-extract fresh |
| Smoke health 404 or anonymous requests return 200 | Probed `/health` instead of `/api/health`; or ran without `--env-file orc.env` → open mode | Use `/api/health`; pass the env-file so auth matches prod |
| Public origin check returns a Cloudflare login page | `orc.niradler.com` sits behind CF Access | Send `CF-Access-Client-Id`/`-Secret` from autho `homelab-access` |
| Log stays empty during the release | autho buffers child output | Watch `.orc/release-state.json` `completed[]` |

## Self-improvement (required)

If anything in a release failed, stalled or needed a manual workaround, do this before
reporting done:
1. Fix the root cause in code (script, gate or hook) through a PR where you can.
2. Add or update a row in **Known traps**, and adjust the fast path if a step was wrong
   or slow.
3. Keep this file short. Delete rows whose cause has been fixed in code and has not
   recurred for two releases.

Scope: a release, a desktop upgrade and a lab rollout are separate authorizations
unless Nir asked for all of them. Never infer permission for paid runners or extra
deployments.
