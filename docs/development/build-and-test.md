# Build and test

Commands to check, test and build ORC before opening a pull request.

## Before you open a PR

```bash
bun run ci:pr
```

That is the local pull-request gate. The pre-commit hook runs the same package selection without the browser sanity suite (`bun run ci:changed`). `bun run ci` still runs every package's unit tests and no browser tests. `bun run ci:full` runs those unit tests plus the full Playwright suite. Run and record that full gate before every merge to master and before a release; the release check also runs all package and browser tests. Automatic homelab workflows remain disabled pending the security requirements below.

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

The full browser suite starts four isolated shards by default (`PW_SHARDS`). Each shard has its own API, database, home directory, result directory and Playwright worker. Shards stay single-worker so those tests do not share one database. `PW_SHARDS=1` is the serial run; set `PW_SHARDS=2` on smaller machines. `--grep` stays on one shard unless `PW_SHARDS` is set. Failure traces remain in `packages/web/test-results/shard-N`; temporary databases and homes are cleaned after children stop, including interrupted runs. Parallel runs reject a shared explicit port, database or `--output` path.

## Homelab runner

Automatic PR and master workflows are deliberately disabled. The owner can explicitly dispatch trusted code to the existing `homelab` runner; local `ci:pr` and `ci:full` are the normal gates. The checked-in `.github/homelab-runner` scaffold is inactive by default, has no network access and receives no registration credential. It is not an installation recipe for an untrusted-PR runner.

The manual **CI** workflow retains the unit-only gates validated by the homelab setup: lint, format, typecheck, domain/security checks, sequential package tests and web unit tests. Browser tests are a separate manual **E2E** workflow; `ci:full` combines both locally and remains required before merge. Changing the runner's label does not by itself verify browser-system dependencies or full-suite timing on that image.

Before enabling automatic runs, implement and verify all of these requirements:

- Repository Settings → Actions → General → Fork pull request workflows: require approval for all outside collaborators.
- PR workflows use `pull_request`, never `pull_request_target`, with `permissions: contents: read`, no secrets and checkout credentials disabled after checkout.
- A fresh runner for every job: non-root, no Docker socket, no host mounts or readable registration credential, and verified denial of LAN/host access. Merely choosing a separate Docker bridge does not isolate the homelab LAN.
- Registration uses a short-lived credential outside the job's environment. Confirm the workflow's requested labels match the actual runner labels.
- Add a successful full-suite gate on the candidate merge revision before merge, rather than relying on a run after a push to master. Keep `ci:full` as the local equivalent and the release gate.

Only after those checks pass should an isolated stack be installed under `/opt/homelab/stacks/gha-runner`, the PR readiness gate enabled, and automatic workflow triggers restored. This PR does not alter the live runner, repository approval settings, firewall or homelab services.

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

