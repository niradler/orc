/**
 * Local replacement for the GitHub Actions gates.
 *
 *   bun run ci           # lint, format, typecheck, every package's unit tests
 *   bun run ci:changed   # the same, limited to packages changed since master
 *   bun run ci:pr        # changed packages plus the @sanity browser flows
 *   bun run ci:full      # every unit test plus the full browser suite
 *
 * The pre-push hook runs `ci:pr`. Run `ci:full` before merging to master or releasing.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  changedFiles,
  type DomainSelection,
  defaultCompareBase,
  dependentsByPackage,
  readPackageDomains,
  selectDomains,
} from "./ci-domains.js";
import { packageTestSteps, type Step } from "./ci-plan.js";

const args = process.argv.slice(2);
const changedFlag = args.indexOf("--changed");
const wantsChangeScope = changedFlag !== -1;
const nextArg = args[changedFlag + 1];
const compareBase = wantsChangeScope && nextArg && !nextArg.startsWith("--") ? nextArg : undefined;
const wantsE2e = args.includes("--e2e");
const wantsSanity = args.includes("--sanity");

const steps: Step[] = [
  ["Lint", ["bun", "run", "lint"]],
  ["Format check", ["bun", "x", "biome", "format", "./packages"]],
  ["Typecheck", ["bun", "run", "typecheck"]],
  ["Domain ownership", ["bun", "test", "scripts/ci-domains.test.ts"]],
  ["Dependency security regressions", ["bun", "test", "scripts/dependency-security.test.ts"]],
];

const repoRoot = resolve(import.meta.dir, "..");
let selection: DomainSelection | undefined;
if (wantsChangeScope) {
  const base = compareBase ?? defaultCompareBase(repoRoot);
  const domains = readPackageDomains(repoRoot);
  selection = selectDomains(
    changedFiles(repoRoot, base),
    domains,
    dependentsByPackage(repoRoot, domains),
  );
  console.log(`\nChanged since ${base}:`);
  if (selection.reasons.length === 0) console.log("- nothing");
  for (const reason of selection.reasons) console.log(`- ${reason}`);
}
steps.push(...packageTestSteps(repoRoot, selection, { e2e: wantsE2e, sanity: wantsSanity }));
if (args.includes("--plan")) {
  for (const [name, command] of steps) console.log(`${name}: ${command.join(" ")}`);
  process.exit(0);
}

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
  if (dirname(target) !== realpathSync(tmpdir()) || !basename(target).startsWith("orc-ci-home-"))
    throw new Error("CI cleanup target is outside its temporary home root");
  rmSync(target, { recursive: true, force: true });
}
for (const [name, command] of steps) {
  console.log(`\n=== ${name}: ${command.join(" ")}`);
  const testStep =
    name === "Test" || name.startsWith("Test ") || name.includes("tests") || name.includes("e2e");
  const testHome = testStep ? realpathSync(mkdtempSync(join(tmpdir(), "orc-ci-home-"))) : undefined;
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
      timeout: name.includes("e2e") ? 30 * 60_000 : 15 * 60_000,
      cwd: repoRoot,
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
