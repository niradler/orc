import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { packageTestSteps } from "./ci-plan.js";

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

test("should run affected web units and sanity without the full browser suite before push", () => {
  const selection = selectDomains(["packages/web/src/App.tsx"], domains, dependents);
  const steps = packageTestSteps(root, selection, { sanity: true, e2e: false });
  expect(steps.map(([name]) => name)).toEqual(["Test orc-ai", "Web unit tests", "Sanity e2e"]);
  expect(steps.at(-1)?.[1]).toEqual([
    "bun",
    "packages/web/scripts/run-e2e.ts",
    "--grep",
    "@sanity",
  ]);
});

test("should keep sanity always on and full browser coverage explicit", () => {
  for (const paths of [
    [],
    ["docs/development/build-and-test.md"],
    ["bun.lock"],
    ["packages/core/src/ids.ts"],
  ]) {
    const selection = selectDomains(paths, domains, dependents);
    const names = packageTestSteps(root, selection, { sanity: true, e2e: false }).map(
      ([name]) => name,
    );
    expect(names).toContain("Sanity e2e");
    expect(names).not.toContain("Web e2e");
    const full = packageTestSteps(root, selection, { sanity: false, e2e: true }).map(
      ([name]) => name,
    );
    expect(full.at(-1)).toBe(
      selection.packageNames.includes("@orc/web") ? "Web e2e" : "Sanity e2e",
    );
  }
  expect(packageTestSteps(root, undefined, { sanity: false, e2e: true }).at(-1)?.[0]).toBe(
    "Web e2e",
  );
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

test("should keep fork pull requests off the homelab runner until isolation is implemented", () => {
  const sdkRequire = createRequire(join(root, "packages/sdk/package.json"));
  const openapiRequire = createRequire(sdkRequire.resolve("openapi-typescript"));
  const redoclyRequire = createRequire(openapiRequire.resolve("@redocly/openapi-core"));
  const yaml = redoclyRequire("js-yaml") as { load: (source: string) => unknown };
  const sameRepoGuard = "github.event.pull_request.head.repo.full_name == github.repository";
  for (const name of ["ci.yml", "e2e.yml"]) {
    const source = readFileSync(join(root, ".github/workflows", name), "utf8");
    const workflow = yaml.load(source) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<string, { if?: string }>;
    };
    expect(Object.keys(workflow.on)).toEqual(
      name === "ci.yml" ? ["pull_request", "workflow_dispatch"] : ["workflow_dispatch"],
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toContain("secrets.");
    expect(source).not.toContain("pull_request_target");
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toContain("github.actor == 'niradler'");
      expect(job.if).toContain("github.triggering_actor == 'niradler'");
      expect(job.if).toContain("github.repository == 'niradler/orc'");
      if (Object.keys(workflow.on).includes("pull_request"))
        expect(job.if).toContain(sameRepoGuard);
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

test("should restrict every workflow job and rerun to Nir", () => {
  const sdkRequire = createRequire(join(root, "packages/sdk/package.json"));
  const openapiRequire = createRequire(sdkRequire.resolve("openapi-typescript"));
  const redoclyRequire = createRequire(openapiRequire.resolve("@redocly/openapi-core"));
  const yaml = redoclyRequire("js-yaml") as { load: (source: string) => unknown };
  const allowedTriggers: Record<string, string[]> = {
    "ci.yml": ["pull_request", "workflow_dispatch"],
    "release-desktop.yml": ["push"],
  };
  for (const name of readdirSync(join(root, ".github/workflows"))) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const source = readFileSync(join(root, ".github/workflows", name), "utf8");
    const workflow = yaml.load(source) as {
      on: Record<string, unknown>;
      jobs: Record<string, { if?: string }>;
    };
    expect(Object.keys(workflow.on)).toEqual(allowedTriggers[name] ?? ["workflow_dispatch"]);
    expect(source).not.toContain("pull_request_target");
    for (const job of Object.values(workflow.jobs)) {
      const conditions = job.if?.split(/\s*&&\s*/);
      expect(conditions).toContain("github.actor == 'niradler'");
      expect(conditions).toContain("github.triggering_actor == 'niradler'");
      expect(conditions).toContain("github.repository == 'niradler/orc'");
      // Only the pull request gate may branch on the event name, and only
      // together with the same-repository head guard asserted above.
      if (!Object.keys(workflow.on).includes("pull_request")) expect(job.if).not.toContain("||");
    }
  }
});

test("should pin action commits, avoid persisted credentials and scope deployment permissions", () => {
  const sdkRequire = createRequire(join(root, "packages/sdk/package.json"));
  const openapiRequire = createRequire(sdkRequire.resolve("openapi-typescript"));
  const redoclyRequire = createRequire(openapiRequire.resolve("@redocly/openapi-core"));
  const yaml = redoclyRequire("js-yaml") as { load: (source: string) => unknown };
  for (const name of readdirSync(join(root, ".github/workflows"))) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const workflow = yaml.load(readFileSync(join(root, ".github/workflows", name), "utf8")) as {
      permissions: Record<string, string>;
      concurrency?: { group: string; "cancel-in-progress": boolean };
      jobs: Record<
        string,
        {
          permissions?: Record<string, string>;
          steps: { uses?: string; with?: Record<string, unknown> }[];
        }
      >;
    };
    expect(workflow.permissions).toEqual({ contents: "read" });
    if (workflow.concurrency?.["cancel-in-progress"])
      expect(workflow.concurrency.group).toContain("github.triggering_actor");
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const permissions = job.permissions ?? workflow.permissions;
      if (name === "docs.yml" && jobName === "deploy")
        expect(permissions).toEqual({ pages: "write", "id-token": "write" });
      else if (name === "docs.yml" && jobName === "build")
        expect(permissions).toEqual({ contents: "read", pages: "read" });
      else expect(permissions).toEqual({ contents: "read" });
      for (const step of job.steps) {
        if (!step.uses) continue;
        expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[a-f0-9]{40}$/);
        if (step.uses.startsWith("actions/checkout@"))
          expect(step.with?.["persist-credentials"]).toBe(false);
        if (step.uses.startsWith("oven-sh/setup-bun@"))
          expect(String(step.with?.["bun-version"])).toBe("1.4.4");
      }
    }
  }
});
