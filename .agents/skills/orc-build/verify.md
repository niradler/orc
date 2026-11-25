# Verification and CI runbook

Authoritative reference: [docs/development/build-and-test.md](../../../docs/development/build-and-test.md) and [docs/internal/development-reference.md](../../../docs/internal/development-reference.md).

## Test and CI ladder

Never run the entire suite while iterating. Move up the ladder as confidence grows:

| Stage | Command | What it runs |
| --- | --- | --- |
| Single test file | `bun --cwd packages/<name> test ./path/to.test.ts` | One file with that package's `bunfig.toml` preload (isolated `HOME` and `ORC_API_BASE`) |
| Inspect CI scope | `bun run ci:pr --plan` | Prints selected packages, affected dependent test files, and exact commands without running them |
| Fast iteration | `bun run ci:changed` | Lint, Biome check, sequential per-package typecheck, global script tests, `knip:deps`, full suite of changed packages, reaching dependent tests (no browser) |
| **Merge gate (pre-push)** | `bun run ci:pr` | Everything in `ci:changed` plus `@sanity` Playwright flows |
| Targeted Playwright spec | `PW_SHARDS=1 bun packages/web/scripts/run-e2e.ts tests/e2e/<file>.e2e.ts` | One E2E spec in a single isolated shard |
| Docs verification | `bun run docs:build` | Builds VitePress docs and fails on dead links |
| Pre-release only | `bun run ci:full` | All unit tests + full browser suite — **never run as a PR merge gate** |

### What triggers a full-repo run

Changes to `package.json`, `bun.lock`, `bunfig.toml`, `biome.json`, `Dockerfile`, `.dockerignore`, `patches/`, `scripts/ci-*`, `scripts/pre-push*`, `scripts/tsconfig*`, `.github/`, or `.githooks/` run every package.

## Testing rules

- **Real behavior over mocks**: tests use real SQLite and real processes, not mocks of the unit under test. Run package tests from the package directory (`bun --cwd packages/<name> test ...`) so `bunfig.toml` preloads `scripts/test-home-isolation.ts` and `_api-isolation.ts` (a root-level `bun test` skips those preloads).
- **Node version for Pi tests**: `packages/api/src/__tests__/pi-chat.test.ts` spawns Pi under `node` from `PATH` and requires **Node.js >= 22.19**. If `pi-chat.test.ts` fails with empty models, verify `node --version` and prepend a Node >= 22.19 binary to `PATH`.
- **Clean teardown**: every test must remove its owned temporary directories and compiled binaries in `finally` / teardown hooks, including failure paths, after child processes exit.
- **No retries or skips for flakes**: fix flaky tests at the race; never add retries or `.skip` to hide nondeterminism.

## Playwright E2E rules

- Specs live in `packages/web/tests/e2e/` and select elements by `data-testid` only.
- Add `@sanity` to the test or `describe` title for any new critical user flow so `ci:pr` guards it.
- Full E2E defaults to 4 isolated shards (`PW_SHARDS=4`); set `PW_SHARDS=1` for single-file or constrained-machine runs (`--grep` already runs on 1 shard unless `PW_SHARDS` is set).
- Run the sanity subset directly with:

```bash
bun packages/web/scripts/run-e2e.ts --grep @sanity
```

## Local server binding and port safety

- Bind every local dev, test, fixture, and preview server **explicitly to `127.0.0.1`** (`Bun.serve({ hostname: "127.0.0.1", ... })`, Vite `--host 127.0.0.1`). Never rely on default bind addresses or use `0.0.0.0`, `::`, or bare `--host`.
- Verify actual listener addresses after launching a local server; never request firewall/public-network approvals for local validation.
- Use source dev servers (canonical dev ports: API `7701`, web `3077`), never the global daemon (`7700`), and inspect existing listeners before starting.
