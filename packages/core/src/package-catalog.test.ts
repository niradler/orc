import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importAcquiredPackage,
  validateApmSource,
  writePackageCommand,
} from "./package-catalog.js";
import { buildPackagePlan, packagePlanArgv } from "./package-launch.js";
import {
  createPackage,
  packageRevision,
  packageSkillFiles,
  parseApmManifest,
  readPackage,
  readPackageFile,
  updatePackage,
} from "./package-service.js";
import { listSkills, reloadCache } from "./skill-service.js";

const priorDirectory = process.env.ORC_PACKAGES_DIR;
beforeAll(() => {
  process.env.ORC_PACKAGES_DIR = join(
    mkdtempSync(join(tmpdir(), "orc-catalog-tests-")),
    "packages",
  );
});
afterAll(() => {
  if (priorDirectory === undefined) delete process.env.ORC_PACKAGES_DIR;
  else process.env.ORC_PACKAGES_DIR = priorDirectory;
  reloadCache();
});

describe("personal package catalog", () => {
  test("validates native Git sources and rejects stale acquisition tokens before reading files", () => {
    expect(validateApmSource("https://gitlab.com/team/package#v1.0.0")).toBe(
      "https://gitlab.com/team/package#v1.0.0",
    );
    expect(validateApmSource("owner/repo/path#main")).toBe("owner/repo/path#main");
    for (const source of [
      "--force",
      "file:///etc",
      "https://user:secret@github.com/org/repo",
      "http://github.com/org/repo",
      "https://localhost/repo",
      "org/repo/../secret",
    ])
      expect(() => validateApmSource(source)).toThrow();
    expect(() => importAcquiredPackage(crypto.randomUUID(), "../secret")).toThrow("expired");
  });
  test("supports APM's documented named MCP declarations without changing their data", () => {
    const source =
      "name: mcp-example\nversion: 1.0.0\ndependencies:\n  mcp:\n    - name: local-files\n      registry: false\n      transport: stdio\n      command: node\n      args: [server.js]\n";
    expect(parseApmManifest(source).dependencies).toEqual({
      mcp: [
        {
          name: "local-files",
          registry: false,
          transport: "stdio",
          command: "node",
          args: ["server.js"],
        },
      ],
    });
    expect(() =>
      parseApmManifest(source.replace("command: node", "command: node server.js")),
    ).toThrow("executable");
    expect(() => parseApmManifest(source.replace("transport: stdio", "transport: http"))).toThrow(
      "URL",
    );
  });
  test("copies complete existing skills in both formats and preserves their original entrypoints", () => {
    const skill = listSkills({ reload: true }).find((skill) => skill.source === "builtin");
    if (!skill) throw new Error("Expected at least one built-in skill");
    const original = readFileSync(skill.path, "utf8");
    const apm = packageSkillFiles([skill.name], "apm");
    const plugin = packageSkillFiles([skill.name], "agent-plugin");
    expect(apm.some((file) => file.path.endsWith("/SKILL.md") && file.content === original)).toBe(
      true,
    );
    expect(plugin.map((file) => file.path)).toEqual(
      apm.map((file) => file.path.replace(/^\.apm\//, "")),
    );
    expect(readFileSync(skill.path, "utf8")).toBe(original);
    expect(() => packageSkillFiles([skill.name, skill.name], "apm")).toThrow("unique");
    expect(() => packageSkillFiles(["not-an-installed-skill"], "apm")).toThrow("not found");
  });
  test("updates a complete package, preserves binary data and refuses stale or invalid writes", () => {
    const name = `catalog-check-${crypto.randomUUID()}`;
    const original = createPackage(name, `name: ${name}\nversion: 1.0.0\nx-kept: true\n`, [
      { path: "assets/icon.bin", content: "AAH/", encoding: "base64" },
    ]);
    const revision = packageRevision(original);
    const input = {
      content: `name: ${name}\nversion: 1.1.0\nx-kept: true\n`,
      expectedRevision: revision,
      files: [{ path: "assets/icon.bin", content: "AAH/", encoding: "base64" as const }],
    };
    expect(() =>
      updatePackage(name, { ...input, files: [{ path: "../escape", content: "x" }] }),
    ).toThrow("path");
    expect(readPackage(name)?.content).toBe(original.content);
    const saved = updatePackage(name, input);
    expect(saved.version).toBe("1.1.0");
    expect(saved.manifest["x-kept"]).toBe(true);
    expect(readPackageFile(name, "assets/icon.bin").content).toBe("AAH/");
    expect(() => updatePackage(name, input)).toThrow("changed");
  });
  test("install-only plans do not need or launch a coding-agent binary", () => {
    const name = `install-check-${crypto.randomUUID()}`;
    createPackage(name, `name: ${name}\nversion: 1.0.0\n`, []);
    const cwd = mkdtempSync(join(tmpdir(), "orc-install-check-"));
    const plan = buildPackagePlan(
      {
        name: "install-check",
        packages: [name],
        backend: "codex",
        tool: "apm",
        cwd,
        prompt: "",
        operation: "install",
      },
      { apm: ["apm"], skills: null, bun: "bun" },
      () => null,
      () => {},
    );
    expect(plan.steps.map((step) => step.argv[1])).toEqual(["install", "compile"]);
    expect(plan.steps.every((step) => step.timeout !== null)).toBe(true);
    const command = writePackageCommand(packagePlanArgv(plan, "bun"), "win32");
    expect(command).toStartWith("& 'bun' '");
    expect(command).not.toContain("--eval");
    expect(command).not.toContain(cwd);
  });
});
