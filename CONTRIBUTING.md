# Contributing to ORC

The contributor guide is on the docs site:

- [Contributing](https://niradler.github.io/orc/development/): issues, pull requests, conventions and docs
- [Run locally](https://niradler.github.io/orc/development/setup): install, dev servers, worktrees
- [Build and test](https://niradler.github.io/orc/development/build-and-test): checks, tests, builds

The same pages are in [`docs/development/`](docs/development). A pull request runs the packages it changes plus the `@sanity` browser flows; those checks are the merge gate. `bun run ci:full` is a pre-release tool only. Report security problems through [SECURITY.md](SECURITY.md), not an issue.
