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
   `bun run ci:full`. Fix failures in a PR, merge it, then reset the worktree to the
   new origin/master.
4. **Release** from PowerShell, in the background, with output going to a scratchpad log:
   `$env:NPM_CONFIG_USERCONFIG="<scratch>/npmrc"; $null | autho exec --map "NPM_TOKEN=npm token" -- bun run release --yes`.
   The npmrc contains only `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`.
   Watch `.orc/release-state.json` `completed[]`, because the log stays empty while
   autho buffers. Resume after a failure with `--resume --yes`.
5. **While macOS builds, back up the lab.** Run these on `lab-z170mx`
   (sudo password: autho `homelab` via `sudo -S`):
   - Stop orc.
   - `tar -czf` `/srv/docker-data/orc` together with `compose.yaml` and
     `/opt/homelab/secrets/orc.env` into `/mnt/backups/orc-before-<v>-<ts>/`.
   - `tar -tzf` the archive to verify it, then start orc again.
6. **Lab rollout after Docker publishes.**
   - Get the `niradler/orc:<v>` digest.
   - Smoke-test the new image on a spare port against a copy of the data. Check
     health and that DB counts match.
   - Pin `tag@digest` in `/opt/homelab/stacks/orc/compose.yaml`, then run
     `sudo docker compose up -d`.
   - Verify: health 200, anonymous 401, authenticated 200, dashboard and assets
     load, and skills, agents and knowledge are present.
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
| Release `checks` fails on biome organizeImports | PR gate ran lint/format only (fixed in #263) | `bunx biome check --write ./packages ./scripts`, then PR |
| Typecheck: two drizzle copies, `shouldInlineParams` | Worktree without `node_modules` resolves the main checkout's | `bun install` in the worktree |
| Git Bash `cd` exits 1 with an fnm error and nothing runs | fnm shell hook | Launch from PowerShell with `Set-Location`, or use absolute paths |
| npm step "Unexpected npm release archive" | package.json changed under a shared checkout | Dedicated worktree, then `--resume` |
| npm PUT 202 and the version is not visible yet | Registry processing lag (up to 15 min or more) | `--resume` later; it won't republish |
| Desktop verify timeout | `~/.orc/bin/orc.exe` locked by editor `orc mcp` processes | Ask Nir to close them, then `--resume --yes` |
| Lab `docker build` prints usage | Lab docker has no build subcommand | `/usr/libexec/docker/cli-plugins/docker-buildx build --load` |
| Bump collides with an existing npm version | Previous release commit never reached master | Preflight version check (step 1) |
| Fix PR's `changed` check sits queued | Homelab runner session went stale (container replaced) | Cancel the run, then `gh run rerun <id>`; check `gha-runner-pool.service` on the lab |
| Backup tar prints `socket ignored` | SSH control sockets in `/data/.orc/ssh` | Harmless; sockets don't need backing up |
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
