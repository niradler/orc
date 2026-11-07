import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
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
