import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  changedFiles,
  dependentsByPackage,
  readPackageDomains,
  selectDomains,
  unownedSourceFiles,
  unownedSourcePaths,
} from "./ci-domains.js";

const root = resolve(import.meta.dir, "..");
const domains = readPackageDomains(root);
const dependents = dependentsByPackage(root, domains);

test("should select a package and the packages that depend on it", () => {
  const selection = selectDomains(["packages/web/src/App.tsx"], domains, dependents);
  expect(selection.runAll).toBe(false);
  expect(selection.packageNames).toContain("@orc/web");
  expect(selection.packageNames).toContain("orc-ai");
  expect(selection.packageNames).not.toContain("@orc/api");
  expect(selection.reasons.some((reason) => reason.includes("packages/web/src/App.tsx"))).toBe(
    true,
  );
});

test("should follow the package name when it differs from the folder", () => {
  const selection = selectDomains(["packages/cli/src/index.ts"], domains, dependents);
  expect(selection.packageNames).toContain("orc-ai");
  expect(selection.runAll).toBe(false);
});

test("should run dependents of a shared package", () => {
  const selection = selectDomains(["packages/core/src/ids.ts"], domains, dependents);
  expect(selection.packageNames).toContain("@orc/db");
  expect(selection.packageNames).toContain("@orc/api");
  expect(selection.packageNames).toContain("@orc/web");
  expect(selection.packageNames).toContain("orc-ai");
});

test("should run every package when shared infrastructure changes", () => {
  const selection = selectDomains(["bun.lock", "packages/web/src/App.tsx"], domains, dependents);
  expect(selection.runAll).toBe(true);
  expect(selection.packageNames).toEqual(domains.map((domain) => domain.name).sort());
  expect(selection.reasons.some((reason) => reason.startsWith("bun.lock"))).toBe(true);
});

test("should leave package tests out of a docs-only change", () => {
  const selection = selectDomains(["docs/development/build-and-test.md"], domains, dependents);
  expect(selection.runAll).toBe(false);
  expect(selection.packageNames).toEqual([]);
  expect(selection.reasons.some((reason) => reason.includes("build-and-test.md"))).toBe(true);
});

test("should treat a package manifest as that package", () => {
  const selection = selectDomains(["packages/api/package.json"], domains, dependents);
  expect(selection.runAll).toBe(false);
  expect(selection.packageNames).toContain("@orc/api");
});

test("should own every source and test file", () => {
  expect(unownedSourceFiles(root)).toEqual([]);
});

test("should report a source file outside the owned trees", () => {
  expect(unownedSourcePaths(["tools/example.ts"], domains)).toEqual(["tools/example.ts"]);
  expect(unownedSourcePaths(["scripts/ci-domains.ts", "hooks/session-start.ts"], domains)).toEqual(
    [],
  );
});

test("should run every package when a hook changes", () => {
  const selection = selectDomains(["hooks/session-start.ts"], domains, dependents);
  expect(selection.runAll).toBe(true);
});

test("should run every package for root runtime and test configuration", () => {
  for (const path of ["bunfig.toml", "biome.jsonc", "Dockerfile", ".dockerignore"])
    expect(selectDomains([path], domains, dependents).runAll).toBe(true);
});

test("should test both sides of a cross-package rename and preserve unusual path names", () => {
  const directory = mkdtempSync(join(tmpdir(), "orc-domain-diff-"));
  const run = (...args: string[]): void => {
    const result = Bun.spawnSync(["git", ...args], { cwd: directory, timeout: 10_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  try {
    run("init");
    run("config", "user.name", "CI fixture");
    run("config", "user.email", "ci@example.invalid");
    mkdirSync(join(directory, "packages/web/src"), { recursive: true });
    mkdirSync(join(directory, "packages/api/src"), { recursive: true });
    const oldPath = "packages/web/src/ shared.ts";
    const newPath = "packages/api/src/ shared.ts";
    writeFileSync(join(directory, oldPath), "export const shared = true;\n");
    run("add", ".");
    run("-c", "core.hooksPath=", "commit", "-m", "fixture");
    run("branch", "baseline");
    renameSync(join(directory, oldPath), join(directory, newPath));
    run("add", ".");
    const paths = changedFiles(directory, "baseline");
    expect(paths.sort()).toEqual([newPath, oldPath].sort());
    const selected = selectDomains(paths, domains, dependents);
    expect(selected.packageNames).toContain("@orc/api");
    expect(selected.packageNames).toContain("@orc/web");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("should keep automatic runner execution disabled until public-PR isolation is implemented", () => {
  const sdkRequire = createRequire(join(root, "packages/sdk/package.json"));
  const openapiRequire = createRequire(sdkRequire.resolve("openapi-typescript"));
  const redoclyRequire = createRequire(openapiRequire.resolve("@redocly/openapi-core"));
  const yaml = redoclyRequire("js-yaml") as { load: (source: string) => unknown };
  for (const name of ["ci.yml", "e2e.yml"]) {
    const source = readFileSync(join(root, ".github/workflows", name), "utf8");
    const workflow = yaml.load(source) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<string, { if?: string }>;
    };
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toContain("secrets.");
    for (const job of Object.values(workflow.jobs)) {
      if (job.if?.includes("github.event_name == 'pull_request'")) {
        expect(job.if).toContain("vars.ORC_ISOLATED_PR_RUNNER_READY == 'true'");
      } else {
        expect(job.if).toContain("github.actor == 'niradler'");
        expect(job.if).toContain("github.repository == 'niradler/orc'");
      }
    }
  }
  const source = readFileSync(join(root, ".github/homelab-runner/compose.yml"), "utf8");
  const compose = yaml.load(source) as {
    services: { runner: { network_mode: string; profiles: string[] } };
  };
  expect(compose.services.runner.network_mode).toBe("none");
  expect(compose.services.runner.profiles).toContain("security-review-required");
  expect(source).not.toContain("ACCESS_TOKEN");
});
