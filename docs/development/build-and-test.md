# Build and test

Commands to check, test and build ORC before opening a pull request.

## Before you open a PR

```bash
bun run ci
```

It runs the same gates as the pre-commit hook (`scripts/ci-local.ts`):

| Step | Command |
| --- | --- |
| Lint | `bun run lint` |
| Format check | `bunx biome format ./packages` |
| Typecheck | `bun run typecheck` |
| Tests (all packages but web) | `bun run --sequential --filter '!@orc/web' test` |
| Dependency security | `bun test scripts/dependency-security.test.ts` |
| Web unit tests | `bun run --filter @orc/web test:unit` |

`bun run ci:full` adds the Playwright e2e suite. `bun run check` fixes lint and format in place.

### Manual homelab CI

The Actions `CI` workflow runs these unit, type and security gates on the `homelab`
runner when dispatched manually by `niradler` in `niradler/orc`. It uses Bun 1.4.4,
runs package tests sequentially, grants read-only repository access and does not
persist checkout credentials. Jobs stop after 60 minutes. Automatic PR runs stay
disabled; this workflow does not establish isolation for running untrusted PR code.
Browser tests remain a separate local or manual E2E check.

## Tests

```bash
bun run --filter @orc/api test                           # one package
cd packages/api && bun test src/__tests__/projects.test.ts  # one file
```

Tests use real SQLite and real processes, not mocks of the code under test. A test cleans up its own temp folders, including on failure.

### Web e2e (Playwright)

```bash
cd packages/web
bun x playwright install chromium   # once
bun run test:e2e                    # starts API and web for you
bun run test:e2e:ui                 # headed, with the picker
```

Specs live in `packages/web/tests/e2e/` and select elements by `data-testid` only.

## Build

```bash
bun run build                               # every package
bun run --filter orc-ai build               # CLI bundle with the web dashboard embedded
cd packages/cli && bun run build:bin        # standalone binaries
bun run --filter @orc/desktop dist          # desktop installer for this machine
```

The CLI build builds the web app first and copies `packages/web/dist` into `packages/cli/dist/web`, so the daemon serves the dashboard from the same port as the API.

## API contract changes

After changing a route, regenerate the SDK types:

```bash
bun run sdk:generate
```

