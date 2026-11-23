# ORC code craft and repository structure

## Package map and ownership

ORC is a Bun TypeScript strict/ESM workspace under `packages/`. Respect dependency direction so changes stay clean and `ci:pr` domain scoping stays sharp:

| Package | Owns |
| --- | --- |
| `@orc/core` (`packages/core`) | Shared Zod contracts, types (`@orc/core/types`), IDs (`ulid()` from `@orc/core/ids`), config, pure domain helpers |
| `@orc/db` (`packages/db`) | Drizzle SQLite schema, idempotent migrations, persistence stores |
| `@orc/agent-runtime` (`packages/agent-runtime`) | Agent backends (Claude, Codex, OpenCode, Pi, ACP/ACPX), human-request bridge, session execution |
| `@orc/api` (`packages/api`) | Hono REST + OpenAPI routes, chat/session orchestration, event streams |
| `@orc/mcp` (`packages/mcp`) | MCP tool definitions and handlers calling ORC services |
| `@orc/sdk` (`packages/sdk`) | Generated OpenAPI TypeScript types (`packages/sdk/src/openapi.gen.ts`) — regenerate with `bun run sdk:generate` |
| `@orc/web` (`packages/web`) | React 19 + Vite + Tailwind web dashboard (see `orc-ui`) |
| `orc-ai` (`packages/cli`) | CLI & daemon bundle with embedded web assets (`@anthropic-ai/claude-agent-sdk`, `sqlite-vec`, `zod` stay external) |
| `@orc/desktop` (`packages/desktop`) | Electron shell wrapping the daemon and web app |
| `@orc/runner`, `@orc/task-service`, `@orc/knowledge`, `@orc/channels`, `@orc/gateway` | Flows/jobs, task services, KB/memory, channel adapters, gateway runtime |

## Structural rules

- **Reuse first**: trace existing modules, hooks, routes, and shared Zod schemas before adding new abstractions. Prefer generic, extensible flows over one-off branches.
- **Contracts live in `@orc/core`**: define request/response/domain shapes once with Zod, infer TypeScript types from them, and import those types across `db`, `api`, `mcp`, and `web`.
- **Database changes**: add idempotent migrations (`PRAGMA table_info` + `ALTER TABLE` or schema migration) so existing local `~/.orc/orc.db` files upgrade cleanly without data loss.
- **API contract sync**: after adding or modifying any OpenAPI route or schema, run `bun run sdk:generate` and commit `packages/sdk/src/openapi.gen.ts`.
- **Imports and exports**: keep imports at the top of the file (except genuine dynamic `import()`); avoid barrel re-exports (`index.ts` re-export chains).
- **Formatting and hygiene**: run `bun run check` (Biome) and `bun run knip:deps` (unused/unlisted dependencies).
- **Knowledge loop boundary**: when modifying memory, KB digest, KB comment, or instruction-history code, read `docs/internal/knowledge-loop.md`. Never inject KB content or summaries into startup context or runner prompts.

## Docs over comments

- **Do not add comments that narrate code** or explain *what* a function, variable, or block does. Use clear names and small focused helpers instead.
- Reserve inline comments strictly for non-obvious invariants, subtle concurrency/platform traps, or external protocol quirks that would otherwise cause the next editor to break working behavior.
- Put user-visible behavior (CLI commands/flags, MCP tools, REST routes, config keys, env vars, install/deploy steps) in the matching `docs/docs/` page in the same PR. Add new pages to `docs/.vitepress/config.ts`, use relative links (`./cli.md`), and verify with `bun run docs:build`.
- Put internal design specs and troubleshooting notes in `docs/internal/` (kept in repo, not published).

## Private local references (`./.examples/`)

The gitignored `./.examples/` directory (or sibling checkout `../.examples/`) holds local reference projects for research.

- **Use it to think, never to copy**: inspect reference projects to discover approaches, compare architecture trade-offs, spot edge cases, and study interaction details. Synthesize a cleaner, ORC-native design tailored to ORC's contracts and `DESIGN.md`.
- **Strict zero-leak rule**: never mention any reference project's name, repository, folder name, URL, or file path anywhere that can leave your machine — not in source code, comments, tests, commit messages, PR titles, PR bodies, PR comments, docs, or GitHub issues.
- Run `bash .agents/skills/orc-build/scripts/pr-preflight.sh` before opening a PR; it automatically scans your branch diff against local `.examples/` directory names to catch accidental leaks.
