# ORC agent guide

ORC is a Bun/TypeScript orchestration hub. See [docs/guide/](docs/guide) for
product behavior, commands, interfaces and configuration, and
[docs/development/](docs/development) for contributing, running, building and
testing. [docs/internal/](docs/internal) holds design specs and the
[development reference](docs/internal/development-reference.md) for troubleshooting.

## ORC process access

For nontrivial work, read the relevant handoff and check `spec --help` and
`spec specs`. Select the intended ORC installation and readable project name;
call `context` first, then `skill_read` for `orc-sdlc` and follow its current
instructions. Discover supporting skills with `skill_list`. Use a registered
ORC source, an inline MCP source such as `http://localhost:7701/mcp` after
verifying the dev API, or already-connected direct MCP tools. Per-agent MCP
configuration is not required. Check the bridge and direct access before
reporting ORC unavailable; do not use cached guidance as current. Refresh after
compaction or at a new work unit. Keep credentials in secure configuration or
environment references, not command arguments. Connection does not authorize
extra agents, production changes, publication, or imply hook enforcement.

## Working in this repository

- Use Bun workspaces (`bun install`), TypeScript strict/ESM, and Biome. Shared
  contracts use Zod; shared types live in `@orc/core/types` and IDs use
  `ulid()` from `@orc/core/ids`. Avoid barrel re-exports and comments that do
  not explain non-obvious intent. Run checks appropriate to the change.
- Create worktrees under `.orc/worktrees/<name>`, `.claude/worktrees/<name>`,
  or the agent's native `~/.codex/worktrees/`. Do not create them beside the
  repo, under `.worktrees/`, or under `.claude/checkouts/`. The
  `.orc/rules/worktree-location.ts` rule enforces allowed locations. Remove a
  worktree you created once merged, subject to the user's deletion rules.
- Keep disk usage bounded. Reuse the active checkout and existing operational
  scripts; do not create another worktree, copied dependency tree, per-attempt
  helper, browser profile or artifact set for a retry, and always clean up the
  ones you created. Check available space before large builds. Tests must clean their owned temporary directories and
  compiled binaries in teardown, including failure paths, after children exit.
  After verified publication, retire redundant generated outputs within Nir's
  cleanup authorization. Preserve active checkpoints and the bounded recovery
  points required by the release protocol; keep concise evidence instead of
  duplicate build trees, archives and logs.
- Use source dev servers, not the global daemon, for development. Canonical dev
  ports are API 7701 and web 3077; inspect existing listeners before starting.
  Bind every local development, test, fixture and preview server explicitly to
  `127.0.0.1` (including `Bun.serve({ hostname: "127.0.0.1", ... })` and Vite's
  `host`). Never rely on a server's default bind address or use `0.0.0.0`, `::`
  or `--host` without an address. Verify actual listener addresses after launch.
  Do not request Windows Firewall/public-network approval or change firewall
  rules for local validation. Public/LAN binding requires Nir's explicit request.
  For port recovery, dev commands and Windows process details, see
  [docs/internal/development-reference.md](docs/internal/development-reference.md).
- Read [DESIGN.md](DESIGN.md) before web UI work. Follow its compact,
  screen-aware controls guidance: secondary lists default to a quiet
  collapsed summary, expanded items use slim rows, and editors appear on demand.
  Review populated desktop and phone states before declaring substantial UI work done.
  Preserve its list-selection
  and bulk-action standard. Browser E2E selectors use `data-testid`; see
  [docs/internal/development-reference.md](docs/internal/development-reference.md#web-ui-e2e-tests-playwright).
- For releases or installation upgrades, follow [docs/development/releases.md](docs/development/releases.md)
  and the latest `.claude/docs/releases.md` handoff. Use the canonical release
  command; a release does not authorize a branch push. Keep workspace versions
  aligned, and keep runtime dependencies that resolve files relative to their own
  package external to the CLI bundle and declared as dependencies.
- When modifying memory, KB digest, KB comment or instruction-history code, read
  [docs/internal/knowledge-loop.md](docs/internal/knowledge-loop.md). Do not inject KB content or
  summaries into startup context or runner prompts. Use the current `orc-sdlc`
  delivery guidance for learning and session handoff.

## Documentation

`README.md` is for users: what ORC is, install, quick start and links. Everything
else lives in `docs/`, published to https://niradler.github.io/orc/ by
`.github/workflows/docs.yml`. `docs/guide/` is usage, `docs/development/` is
the short contributor section, and `docs/internal/` (design specs, verification
records) is kept in the repo but not published.

- A change to user-visible behavior, a CLI command or flag, an MCP tool, a REST
  route, a config key or env var, or install and deploy steps updates the matching
  `docs/guide/` page in the same PR. Verify every name against the code.
- A new page is added to the sidebar in `docs/.vitepress/config.ts`. Link pages
  relatively (`./cli.md`); `bun run docs:build` fails on dead links.
- Screenshots live in `docs/public/screens/` and are captured from a dev server
  with demo data, never from a real workspace. Recapture the ones a UI change makes
  stale.

For task flows, node outcomes and managed status, see
[docs/guide/task-flows.md](docs/guide/task-flows.md). For API and SDK changes, inspect the
current routes and regenerate SDK types when the contract changes. For validation
commands, see [development guide](docs/internal/development-reference.md).
