# Build and test

Commands to check, test and build ORC before opening a pull request.

## Before you open a PR

```bash
bun run ci:pr
```

That is the pull-request gate. The pre-commit hook runs the same package selection without the browser sanity suite (`bun run ci:changed`). `bun run ci` still runs every package's unit tests and no browser tests. `bun run ci:full` runs those unit tests plus the full Playwright suite. Merging to master and `bun run release --check` both require that full suite.

| Command | What it runs |
| --- | --- |
| `bun run ci:changed` | Lint, format, typecheck, domain ownership, dependency security, and unit tests for packages changed since `master` plus packages that depend on them |
| `bun run ci:pr` | The changed-package run, plus `@sanity` browser flows. A web change runs the web browser suite instead of only `@sanity` |
| `bun run ci` | Lint, format, typecheck, domain ownership, dependency security, and every package's unit tests |
| `bun run ci:full` | `bun run ci` plus the full browser suite |

`bun run check` fixes lint and format in place. Pass `--changed <ref>` to compare with a branch other than `origin/master` (or `master` when the remote ref is missing). The command prints which packages it selected and why.

A change to `bun.lock`, the root manifest, `patches/`, `scripts/`, `hooks/`, `.github/`, `.githooks/`, or a root `tsconfig*.json` runs every package. Docs and other files outside a package do not add package tests. On a pull request they still run `@sanity`.

## Domains and the sanity tag

A domain is a workspace package. `scripts/ci-domains.ts` reads each `packages/*/package.json` and the `workspace:` dependencies. A package change runs that package's `test` script and the same for every package that depends on it, directly or through another package. `@orc/web` unit tests are `test:unit`. Its browser tests run when the pull-request gate selects `@orc/web`.

`scripts/ci-domains.test.ts` fails if a source or test file is not under a package, `scripts/`, `hooks/`, or `docs/`. Adding a package with a `package.json` name and a `test` script is enough; there is no second list to edit. Vendored trees (`.examples`, `.demo`) and generated docs output are outside that check.

Browser specs live in `packages/web/tests/e2e/`. Put `@sanity` in the test title, or in a parent `describe` title. `--grep @sanity` matches that title:

```ts
test("@sanity the app loads", async ({ page }) => {
  // ...
});
```

`packages/web/tests/e2e/sanity.e2e.ts` holds the always-on flows: the app loads, a chat streams a reply, a session opens, an approval is accepted, a job runs, a terminal opens, a knowledge base is created and searched, and phone navigation works. Run them with:

```bash
bun packages/web/scripts/run-e2e.ts --grep @sanity
```

Feature tags such as `@chat` are not used. A change inside `packages/web` runs that package's browser tests.

The full browser suite starts two isolated shards by default (`PW_SHARDS`, four on the homelab full job). Each shard has its own API, database and Playwright worker. Shards stay single-worker so those tests do not share one database. `PW_SHARDS=1` is the serial run. `--grep` stays on one shard unless `PW_SHARDS` is set.

## Homelab runner

Pull requests and pushes to `master` run on a self-hosted runner labeled `homelab`. Self-hosted runners are free on a public repository. A pull request from a fork still executes its code on that machine, so the runner is locked down:

- Repository Settings → Actions → General → Fork pull request workflows: require approval for all outside collaborators.
- Workflows use `pull_request`, not `pull_request_target`, and the jobs receive no secrets. `permissions` is `contents: read`.
- The runner is ephemeral, one fresh container per job, with no Docker socket and no host mounts. It does not join other homelab networks.
- Jobs run as the image's `runner` user (`RUN_AS_ROOT=false`). The extra label is `homelab`, so `runs-on: [self-hosted, homelab]` does not match other runners.

The stack is `.github/homelab-runner`. On the lab machine, copy that directory to `/opt/homelab/stacks/gha-runner`. Create a `.env` there with `ACCESS_TOKEN` set to a fine-grained personal access token that can register runners for this repository. Do not commit the token. Then:

```bash
docker compose up -d --build
```

The image installs Chromium and its libraries under `/opt/ms-playwright`. `ci:full` remains the local equivalent of the master job.

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

