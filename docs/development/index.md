# Contributing

How to report a problem, pick up work and get a pull request merged.

## Issues

All work starts from a [GitHub issue](https://github.com/niradler/orc/issues).

| You want to | Do this |
| --- | --- |
| Report a bug | Open an issue with the `bug` label: what you ran, what you expected, what happened, and the ORC version (`orc --version`). |
| Ask for a feature | Open an issue with the `enhancement` label and the problem it solves. Add an `area:` label (`area: sessions`, `area: mcp`, `area: flows`, ...). |
| Pick something up | Comment on the issue before you start. `good first issue` and `help wanted` are open to anyone. |
| Report a security problem | Do not open an issue. Follow [SECURITY.md](https://github.com/niradler/orc/blob/master/SECURITY.md). |

```bash
gh issue list -R niradler/orc --label "good first issue"
gh issue create -R niradler/orc --label bug --title "..." --body "..."
```

## Pull requests

1. Fork the repo, or branch from `master` if you have write access. Never commit to `master`.
2. Keep one PR per issue. Reference it in the body (`Fixes #123`).
3. Run the [checks](./build-and-test.md#before-you-open-a-pr) locally. The pre-commit hook runs them for you.
4. Update the docs page your change affects, in the same PR (see [Docs](#docs)).
5. Open the PR:

```bash
git switch -c fix/session-resume
git commit -m "Resume archived sessions from the Sessions page"
git push -u origin fix/session-resume
gh pr create --fill
```

PRs are squash-merged, so the PR title becomes the commit message. Write it as what changes for the user.

## Conventions

- Bun workspaces, TypeScript strict, ESM only, [Biome](https://biomejs.dev) for lint and format.
- Zod schemas are the contract for API routes, config and CLI arguments. Shared types live in `@orc/core/types`; IDs come from `ulid()` in `@orc/core/ids`.
- Import from the specific module; no barrel re-exports.
- Comments only for intent the code cannot show.
- UI work follows [DESIGN.md](https://github.com/niradler/orc/blob/master/DESIGN.md); e2e selectors use `data-testid`.
- Every package shares one version. Releases bump them together; PRs don't.

[AGENTS.md](https://github.com/niradler/orc/blob/master/AGENTS.md) has the full rule set coding agents follow in this repo.

## Docs

This site is built from `docs/` with [VitePress](https://vitepress.dev).

```bash
bun run docs:dev      # http://127.0.0.1:5173/orc/ with live reload
bun run docs:build    # fails on dead links
```

- A change to user-visible behavior, a CLI command, an MCP tool, a REST route, a config key or install steps updates the matching page in `docs/guide/`.
- A new page goes into the sidebar in `docs/.vitepress/config.ts`.
- Screenshots live in `docs/public/screens/`. Capture them from a dev server with demo data, never from a real workspace.

Merges to `master` that touch `docs/` deploy this site through `.github/workflows/docs.yml`.
