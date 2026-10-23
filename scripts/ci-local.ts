/**
 * Local replacement for the GitHub Actions PR gates (ci.yml, e2e.yml).
 * Runs on every commit through .githooks/pre-commit; `--e2e` adds the Playwright suite.
 *
 *   bun run ci          # lint, format, typecheck, tests (pre-commit runs this)
 *   bun run ci:full     # the above plus web e2e
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const steps: Array<[string, string[]]> = [
  ["Lint", ["bun", "run", "lint"]],
  ["Format check", ["bun", "x", "biome", "format", "./packages"]],
  ["Typecheck", ["bun", "run", "typecheck"]],
  ["Test", ["bun", "run", "--sequential", "--filter", "!@orc/web", "test"]],
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
// Preserve the installed browser before test HOME/LOCALAPPDATA are isolated.
// Otherwise run-e2e resolves Chromium under the empty temporary CI home.
env.PLAYWRIGHT_BROWSERS_PATH ??= join(
  process.platform === "win32"
    ? (env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : (env.XDG_CACHE_HOME ?? join(homedir(), ".cache")),
  "ms-playwright",
);
const started = performance.now();
function cleanupTestHome(path: string): void {
  const target = resolve(path);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("orc-ci-home-"))
    throw new Error("CI cleanup target is outside its temporary home root");
  rmSync(target, { recursive: true, force: true });
}
for (const [name, command] of steps) {
  console.log(`\n=== ${name}: ${command.join(" ")}`);
  const testStep = name === "Test" || name.includes("tests") || name === "Web e2e";
  const testHome = testStep ? mkdtempSync(join(tmpdir(), "orc-ci-home-")) : undefined;
  let exitCode: number;
  try {
    const childEnv = testHome
      ? {
          ...env,
          HOME: testHome,
          USERPROFILE: testHome,
          APPDATA: join(testHome, "AppData", "Roaming"),
          LOCALAPPDATA: join(testHome, "AppData", "Local"),
          XDG_CONFIG_HOME: join(testHome, ".config"),
        }
      : env;
    const result = Bun.spawnSync(command, {
      cwd: root,
      env: childEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = result.exitCode;
  } finally {
    if (testHome) cleanupTestHome(testHome);
  }
  if (exitCode !== 0) {
    console.error(
      `\n✗ ${name} failed (exit ${exitCode}). Fix it, or bypass once with --no-verify.`,
    );
    process.exit(1);
  }
}
console.log(`\n✓ All checks passed in ${((performance.now() - started) / 1000).toFixed(0)}s`);
