# ORC agent guide

ORC is a Bun/TypeScript orchestration hub. See [README.md](README.md) for the
architecture, packages, commands, configuration and product behavior; read
[docs/development.md](docs/development.md) when developing or troubleshooting.

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
- Use source dev servers, not the global daemon, for development. Canonical dev
  ports are API 7701 and web 3077; inspect existing listeners before starting.
  For port recovery, dev commands and Windows process details, see
  [docs/development.md](docs/development.md).
- Read [DESIGN.md](DESIGN.md) before web UI work. Follow its compact,
  screen-aware controls guidance: secondary lists default to a quiet
  collapsed summary, expanded items use slim rows, and editors appear on demand.
  Review populated desktop and phone states before declaring substantial UI work done.
  Preserve its list-selection
  and bulk-action standard. Browser E2E selectors use `data-testid`; see
  [docs/development.md](docs/development.md#web-ui-e2e-tests-playwright).
- For releases or installation upgrades, follow [docs/releases.md](docs/releases.md)
  and the latest `.claude/docs/releases.md` handoff. Use the canonical release
  command; a release does not authorize a branch push. Keep workspace versions
  aligned, and keep runtime dependencies that resolve files relative to their own
  package external to the CLI bundle and declared as dependencies.
- When modifying memory, KB digest, KB comment or instruction-history code, read
  [docs/knowledge-loop.md](docs/knowledge-loop.md). Do not inject KB content or
  summaries into startup context or runner prompts. Use the current `orc-sdlc`
  delivery guidance for learning and session handoff.

For task flows, node outcomes and managed status, see
[docs/task-flows.md](docs/task-flows.md). For API and SDK changes, inspect the
current routes and regenerate SDK types when the contract changes. For validation
commands, see [README development](README.md#development).
