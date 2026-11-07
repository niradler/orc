/**
 * Local replacement for the GitHub Actions gates.
 *
 *   bun run ci           # lint, format, typecheck, every package's unit tests
 *   bun run ci:changed   # the same, limited to packages changed since master
 *   bun run ci:pr        # changed packages plus the @sanity browser flows
 *   bun run ci:full      # every unit test plus the full browser suite
 *
 * The pre-commit hook runs `ci:changed`. Merging to master and releasing run `ci:full`.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  changedFiles,
  defaultCompareBase,
  dependentsByPackage,
  readPackageDomains,
  selectDomains,
} from "./ci-domains.js";

type Step = [string, string[]];

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
const webUnit: Step = ["Web unit tests", ["bun", "run", "--filter", "@orc/web", "test:unit"]];
const webE2e: Step = ["Web e2e", ["bun", "packages/web/scripts/run-e2e.ts"]];
const sanityE2e: Step = [
  "Sanity e2e",
  ["bun", "packages/web/scripts/run-e2e.ts", "--grep", "@sanity"],
];
const allPackageTests: Step = [
  "Test",
  ["bun", "run", "--sequential", "--filter", "!@orc/web", "test"],
];

function pushPackageTests(packageNames: string[], browser: "all" | "sanity" | "none"): void {
  const domains = readPackageDomains(repoRoot);
  const selected = new Set(packageNames);
  for (const domain of domains) {
    if (!selected.has(domain.name) || domain.name === "@orc/web") continue;
    if (!domain.hasTestScript) {
      console.log(`\n— ${domain.name} has no test script`);
      continue;
    }
    steps.push([`Test ${domain.name}`, ["bun", "run", "--filter", domain.name, "test"]]);
  }
  if (selected.has("@orc/web")) {
    steps.push(webUnit);
    if (browser === "all") steps.push(webE2e);
  }
  if (browser === "sanity") steps.push(sanityE2e);
}

if (!wantsChangeScope) {
  steps.push(allPackageTests, webUnit);
  if (wantsE2e) steps.push(webE2e);
  else if (wantsSanity) steps.push(sanityE2e);
} else {
  const base = compareBase ?? defaultCompareBase(repoRoot);
  const domains = readPackageDomains(repoRoot);
  const selection = selectDomains(
    changedFiles(repoRoot, base),
    domains,
    dependentsByPackage(repoRoot, domains),
  );
  console.log(`\nChanged since ${base}:`);
  if (selection.reasons.length === 0) console.log("- nothing");
  for (const reason of selection.reasons) console.log(`- ${reason}`);
  if (selection.runAll) {
    steps.push(allPackageTests, webUnit);
    if (wantsE2e || wantsSanity) steps.push(webE2e);
  } else if (selection.packageNames.length === 0) {
    if (wantsE2e || wantsSanity) steps.push(sanityE2e);
  } else {
    const webChanged = selection.packageNames.includes("@orc/web");
    let browser: "all" | "sanity" | "none" = "none";
    if (webChanged && (wantsE2e || wantsSanity)) browser = "all";
    else if (wantsSanity) browser = "sanity";
    pushPackageTests(selection.packageNames, browser);
  }
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
