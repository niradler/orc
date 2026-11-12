# Build and test

Commands to check, test and build ORC before opening a pull request.

## Before you open a PR

```bash
bun run ci:pr
```

That is the local pull-request gate. The pre-commit hook checks lint and formatting only. The pre-push hook runs `bun run ci:pr`: affected-package units, global checks, and browser sanity before any code reaches GitHub. Push validation requires a clean tracked and untracked working tree, and every pushed ref must resolve to the current checkout commit. Annotated tags on that commit are supported; ref-only deletions need no test run. The checkout is checked again after tests so edits during a gate cannot silently pass. Push other commits from their own checkout. Both hooks are installed by `bun install` through `core.hooksPath=.githooks`. `bun run ci` still runs every package's unit tests and no browser tests. `bun run ci:full` runs those unit tests plus the full Playwright suite. Run and record that full gate before every merge to master and before a release; the release check also runs all package and browser tests. Automatic homelab workflows remain disabled pending the security requirements below.

| Command | What it runs |
| --- | --- |
| `bun run ci:changed` | Lint, format, typecheck, domain ownership, dependency security, knip dependency hygiene, and unit tests for packages changed since `master` plus packages that depend on them |
| `bun run ci:pr` | The changed-package run, plus `@sanity` browser flows, including for web changes |
| `bun run ci` | Lint, format, typecheck, domain ownership, dependency security, knip dependency hygiene, and every package's unit tests |
| `bun run ci:full` | `bun run ci` plus the full browser suite |

`bun run check` fixes lint and format in place. Pass `--changed <ref>` to compare with a branch other than `origin/master` (or `master` when the remote ref is missing). The command prints which packages it selected and why. Add `--plan` to print the commands without running them, for example `bun run ci:pr --plan`. Selection includes tracked working-tree and staged changes as well as branch commits; push from the checkout you validated. For a new branch, comparison still uses `origin/master`, so it includes all PR changes. Fetch the base before starting work to keep that comparison current.

A change to `bun.lock`, the root manifest, `patches/`, `scripts/`, `hooks/`, `.github/`, `.githooks/`, or a root `tsconfig*.json` runs every package. Docs and other files outside a package do not add package tests. On a pull request they still run `@sanity`.

## Domains and the sanity tag

A domain is a workspace package. `scripts/ci-domains.ts` reads each `packages/*/package.json` and the `workspace:` dependencies. A package change runs that package's `test` script and the same for every package that depends on it, directly or through another package. `@orc/web` unit tests are `test:unit`. Its units run when the pull-request gate selects `@orc/web`; the browser gate always runs the small sanity suite. Use `bun scripts/ci-local.ts --changed --e2e` to additionally run the full web browser suite when web is affected.

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

Feature tags such as `@chat` are not used. Package-scoped unit tests plus `@sanity` keep the push loop short. The complete browser suite remains a separate mandatory pre-merge and release check; sanity is not equivalent coverage.

The full browser suite starts four isolated shards by default (`PW_SHARDS`). Each shard has its own API, database, home directory, transform cache, result directory and Playwright worker. Ports stay reserved until API startup; an API exiting during readiness or browser tests fails the run. Shards stay single-worker so those tests do not share one database or contend on Windows transform-cache files. `PW_SHARDS=1` is the serial run; set `PW_SHARDS=2` on smaller machines. `--grep` stays on one shard unless `PW_SHARDS` is set. Failure traces remain in `packages/web/test-results/shard-N`; temporary databases and homes are cleaned after children stop, including interrupted runs. Parallel runs reject a shared explicit port, database or `--output` path.

Windows browser fixtures explicitly launch real PowerShell with `-NoLogo -NoProfile` through their owned temporary configuration. Windows resolves Documents profiles independently of `HOME` and `USERPROFILE`, so changing those environment variables alone does not isolate personal shell integrations. Normal product shell defaults still load profiles. Large project fixtures bound cleanup to ten concurrent requests, await every batch and report all failures without retries.

## Dependency hygiene (knip)

[Knip](https://github.com/webpro-nl/knip) checks for unused and unlisted dependencies. `bun run knip:deps` is the CI gate: unused dependencies and devDependencies, unlisted dependencies and binaries, and unresolved imports. `bun run knip` runs the full audit, which also reports unused files, exports and types; those findings are cleanup backlog, not a gate.

Configuration lives in `knip.jsonc`. Entries cover files knip cannot discover from `package.json` alone: spawned scripts and test fixtures, agent hooks, VitePress config, and the CLI/Electron bundler entries. Ignored dependencies are documented inline; the CLI's `@anthropic-ai/claude-agent-sdk`, `sqlite-vec` and `zod` are intentionally external to the bundle and enforced by `packages/cli/scripts/validate-package.ts` — do not remove them. When knip flags a dependency, verify it against the code before removing it: bundled, spawned and peer-provided dependencies can look unused.

## Homelab runner

Pull requests from a branch in `niradler/orc` opened by the owner run the **CI** workflow on the `homelab` runner; the owner can also dispatch it manually. The job requires the owner as actor and triggering actor and a same-repository head branch, so fork pull requests and pushes to `master` start no job. Local `ci:pr` and `ci:full` remain the normal gates. The checked-in `.github/homelab-runner` scaffold is inactive by default, has no network access and receives no registration credential. It is not an installation recipe for an untrusted-PR runner.

The **CI** workflow runs `ci:pr` on the homelab runner: lint, format, typecheck, domain/security checks, knip dependency hygiene, affected package tests and browser sanity. It starts a pull request for a same-repository branch, and the owner can dispatch it on any trusted branch. Browser tests beyond sanity are a separate manual **E2E** workflow; `ci:full` combines both locally and remains required before merge. Playwright browsers are baked into the runner image at the pinned `@playwright/test` version and `PLAYWRIGHT_BROWSERS_PATH` is read-only, so both workflows check the baked browser instead of downloading one: a Playwright upgrade needs a runner image rebuild. Changing the runner's label does not by itself verify browser-system dependencies or full-suite timing on that image.

Before enabling fork pull request runs, implement and verify all of these requirements:

- Repository Settings → Actions → General → Fork pull request workflows: require approval for all outside collaborators.
- PR workflows use `pull_request`, never `pull_request_target`, with `permissions: contents: read`, no secrets and checkout credentials disabled after checkout.
- A fresh runner for every job: non-root, no Docker socket, no host mounts or readable registration credential, and verified denial of LAN/host access. Merely choosing a separate Docker bridge does not isolate the homelab LAN.
- Registration uses a short-lived credential outside the job's environment. Confirm the workflow's requested labels match the actual runner labels.
- Add a successful full-suite gate on the candidate merge revision before merge, rather than relying on a run after a push to master. Keep `ci:full` as the local equivalent and the release gate.

Only after those checks pass, and Nir explicitly authorizes automatic execution, should fork pull request runs be enabled on an isolated stack installed under `/opt/homelab/stacks/gha-runner`.

### Manual homelab CI

The Actions `CI` workflow runs `ci:pr` on the `homelab` runner for a same-repository pull request and when dispatched manually by `niradler` in `niradler/orc`. A full-history checkout compares the merge revision with `origin/master`, tests affected packages and dependents, and always runs browser sanity. Dispatching master itself runs global checks and sanity, since it has no package diff. Shared infrastructure changes still run all package units. It uses Bun 1.4.4, grants read-only repository access and does not persist checkout credentials. Jobs stop after 60 minutes. Fork PR runs stay disabled; this workflow does not establish isolation for untrusted PR code. The manual E2E workflow runs the complete browser suite.

Every checked-in workflow job, including Desktop, Docs and tag-release builds, requires both `github.actor` and `github.triggering_actor` to be `niradler`, in `niradler/orc`. A different user rerunning an owner's run cannot start jobs. Release desktop gaps keeps its existing `v*` tag trigger, subject to the same owner checks. These conditions gate jobs; GitHub may still show a skipped workflow run requested by another collaborator. Action dependencies are pinned to full commit SHAs verified in their upstream repositories. Checkout credentials are not persisted. Tokens default to contents-read: only the Docs deploy job receives Pages-write and OIDC permissions, while its build job receives Pages-read. Concurrency groups include the triggering actor so a skipped unauthorized dispatch cannot cancel an owner's running gate. These practices follow [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use). Local hooks are developer checks and can be bypassed with Git's `--no-verify`; they are not a server-side merge protection rule.

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

The runner isolates `HOME`, so each shard also fills in a stub for any agent binary it cannot resolve on `PATH` (`codex`, `claude`, `cursor-agent`, `gemini`, `opencode`). Provider detection is presence-only, and specs such as `agent-dropdowns` and `terminal-hosts` assert the controls for installed agents, so a lean CI image would otherwise hide them and the suite would pass only on a developer machine. Stubs are skipped where the real binary exists.

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

