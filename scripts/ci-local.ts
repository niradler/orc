/**
 * Local replacement for the GitHub Actions PR gates (ci.yml, e2e.yml).
 * Runs on every commit through .githooks/pre-commit; `--e2e` adds the Playwright suite.
 *
 *   bun run ci          # lint, format, typecheck, tests (pre-commit runs this)
 *   bun run ci:full     # the above plus web e2e
 */

import { resolve } from "node:path";

const steps: Array<[string, string[]]> = [
  ["Lint", ["bun", "run", "lint"]],
  ["Format check", ["bunx", "biome", "format", "./packages"]],
  ["Typecheck", ["bun", "run", "typecheck"]],
  ["Test", ["bun", "run", "--filter", "!@orc/web", "test"]],
  ["Dependency security regressions", ["bun", "test", "scripts/dependency-security.test.ts"]],
  ["Web unit tests", ["bun", "run", "--filter", "@orc/web", "test:unit"]],
];
if (process.argv.includes("--e2e"))
  steps.push(["Web e2e", ["bun", "run", "--filter", "@orc/web", "test"]]);

const root = resolve(import.meta.dir, "..");
// Git hooks export GIT_DIR, GIT_INDEX_FILE, ... pointing at this repository. Tests that create
// throwaway repos would inherit them and run git against the real repo, so drop them all.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
);
const started = performance.now();
for (const [name, command] of steps) {
  console.log(`\n=== ${name}: ${command.join(" ")}`);
  const result = Bun.spawnSync(command, { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(
      `\n✗ ${name} failed (exit ${result.exitCode}). Fix it, or bypass once with --no-verify.`,
    );
    process.exit(1);
  }
}
console.log(`\n✓ All checks passed in ${((performance.now() - started) / 1000).toFixed(0)}s`);
