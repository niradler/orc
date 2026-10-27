import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createAgent, discoverAgents, getUserAgentsDir } from "./agent-service.js";
import {
  buildPackagePlan,
  listAgentSetups,
  type PackagePlan,
  packagePlanArgv,
  saveAgentSetup,
} from "./package-launch.js";
import { createPackage, getPackagesDir, readPackage } from "./package-service.js";
import { readSkillFile } from "./skill-files.js";
import { listSkills, reloadCache } from "./skill-service.js";

const cwd = mkdtempSync(join(tmpdir(), "orc-launch-test-"));
Bun.spawnSync(["git", "init", cwd], {
  stdout: "ignore",
  stderr: "ignore",
  timeout: 10000,
});
const name = `portable-test-${process.pid}`;
const profileName = `portable-profile-${process.pid}`;
const input = {
  name: "portable-setup",
  packages: [name],
  backend: "copilot" as const,
  tool: "apm" as const,
  cwd,
  prompt: "Use the selected packages",
};
const tools = { apm: ["/apm"], skills: ["/node", "/skills.js"], bun: "/bun" };
const which = (name: string) => `/bin/${name}`;
const qualify = () => {};
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(join(getPackagesDir(), name), { recursive: true, force: true });
  rmSync(join(getUserAgentsDir(), `${profileName}.agent.md`), { force: true });
  reloadCache();
});

describe("package reuse and launch boundaries", () => {
  test("preserves plugin files, isolates invalid skills, and discovers only fixed locations", () => {
    createPackage(
      name,
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
      }),
      [
        {
          path: "skills/good/SKILL.md",
          content: "---\nname: good\ndescription: Portable skill\n---\nUse the files.",
        },
        { path: "skills/broken/SKILL.md", content: "invalid skill" },
        {
          path: "skills/good/nested/deep/SKILL.md",
          content: "---\nname: deep\ndescription: Not a component\n---\nNested resource.",
        },
        { path: "assets/icon.bin", content: "AAEC/w==", encoding: "base64" },
        {
          path: ".apm/agents/resource.agent.md",
          content:
            "---\ndescription: A resource, not a plugin component\n---\nIgnore this profile.",
        },
        {
          path: ".apm/skills/resource/SKILL.md",
          content: "---\nname: resource\ndescription: A resource\n---\nIgnore this legacy skill.",
        },
      ],
      "agent-plugin",
    );
    const skills = listSkills({ reload: true });
    expect(skills.some((skill) => skill.name === `${name}/good`)).toBe(true);
    expect(
      skills.some((skill) => skill.name === `${name}/broken` || skill.name === `${name}/deep`),
    ).toBe(false);
    expect(skills.some((skill) => skill.name === "resource")).toBe(false);
    expect(discoverAgents().agents.some((agent) => agent.id === `${name}/resource`)).toBe(false);
  });
  test("creates one upstream install before agent launch without bypass flags", () => {
    const plan = buildPackagePlan(input, tools, which, qualify);
    expect(plan.steps[0]?.argv).toEqual(["/apm", "install", "--target", "copilot"]);
    expect(plan.steps[0]?.apmDependencies).toEqual([join(getPackagesDir(), name)]);
    expect(plan.steps[0]?.expectedPlugins).toEqual([name]);
    expect(plan.steps[0]?.timeout).toBe(300000);
    expect(plan.steps[1]?.argv).toEqual(["/bin/copilot", "--interactive", input.prompt]);
    expect(plan.steps[1]?.timeout).toBeNull();
    expect(packagePlanArgv(plan, "/bun")[1]).toBe("--eval");
  });
  test("uses native Codex plugin installation and still rejects missing APM tooling", () => {
    const plan = buildPackagePlan(
      { ...input, backend: "codex" },
      { ...tools, apm: null },
      which,
      qualify,
    );
    expect(plan.steps[0]?.argv.slice(0, 4)).toEqual(["/bin/codex", "plugin", "marketplace", "add"]);
    expect(plan.steps[0]?.files?.some((file) => file.path.endsWith("marketplace.json"))).toBe(true);
    expect(
      plan.steps[0]?.files?.find((file) => file.path.endsWith("plugin.json"))?.content,
    ).toContain("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(plan.steps[1]?.argv.slice(0, 3)).toEqual(["/bin/codex", "plugin", "add"]);
    expect(plan.steps.at(-1)?.argv).toEqual(["/bin/codex", "--", input.prompt]);
    expect(() => buildPackagePlan(input, { ...tools, apm: null }, which, qualify)).toThrow(
      /apm-cli/,
    );
  });
  test("Vercel deploys only valid immediate skills, never nested resource entrypoints", () => {
    const plan = buildPackagePlan(
      { ...input, tool: "skills", backend: "codex" },
      tools,
      which,
      qualify,
    );
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.argv).toEqual([
      "/node",
      "/skills.js",
      "add",
      join(getPackagesDir(), name, "skills", "good"),
      "--agent",
      "codex",
      "--copy",
    ]);
  });
  test("native plugin revisions use fresh sources without changing the installed identity", () => {
    const pkg = readPackage(name);
    if (!pkg) throw Error("Missing plugin fixture");
    const files = new Map<string, { content: string; encoding: "utf8" | "base64" }>(
      pkg.files.map((file) => [
        `${pkg.name}/${file.name}`,
        readSkillFile(pkg.path, file.name, false),
      ]),
    );
    const mcp = JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { obsolete: { type: "streamable-http", url: "http://127.0.0.1:1/mcp" } },
    });
    files.set(`${pkg.name}/mcp.json`, { content: mcp, encoding: "utf8" });
    const before = buildPackagePlan({ ...input, backend: "codex" }, tools, which, qualify, {
      cwd,
      packages: [{ ...pkg, files: [...pkg.files, { name: "mcp.json", path: "mcp.json" }] }],
      profile: null,
      files,
      join,
    });
    const after = buildPackagePlan({ ...input, backend: "codex" }, tools, which, qualify, {
      cwd,
      packages: [{ ...pkg, files: pkg.files.filter((file) => file.name !== "assets/icon.bin") }],
      profile: null,
      files,
      join,
    });
    const source = (plan: PackagePlan) => {
      const manifest = plan.steps[0]?.files?.find((file) => file.path.endsWith("marketplace.json"));
      if (!manifest) throw Error("Missing marketplace");
      return JSON.parse(manifest.content).plugins[0].source.path as string;
    };
    expect(before.steps[0]?.argv).toEqual(after.steps[0]?.argv);
    expect(before.steps[1]?.argv).toEqual(after.steps[1]?.argv);
    expect(source(before)).not.toBe(source(after));
    for (const plan of [before, after]) {
      const materialize = plan.steps[0];
      if (!materialize) throw Error("Missing files");
      const result = Bun.spawnSync(
        packagePlanArgv(
          {
            ...plan,
            steps: [{ ...materialize, argv: [process.execPath, "--eval", ""] }],
          },
          process.execPath,
        ),
        { timeout: 10000 },
      );
      expect(result.exitCode).toBe(0);
    }
    const root = before.steps[0]?.argv.at(-1) as string;
    expect(readFileSync(join(root, source(before), "assets/icon.bin"))).toEqual(
      Buffer.from("AAEC/w==", "base64"),
    );
    expect(() => readFileSync(join(root, source(after), "assets/icon.bin"))).toThrow();
    expect(readFileSync(join(root, source(before), "mcp.json"), "utf8")).toBe(mcp);
    expect(() => readFileSync(join(root, source(after), "mcp.json"))).toThrow();
  });
  test("SSH APM relaunch replaces only selected ORC-managed sources", () => {
    const project = join(cwd, "remote-manifest");
    mkdirSync(project);
    const sourceRoot = "/srv/work/.orc/package-sources";
    const first = "01J00000000000000000000000";
    const second = "01J00000000000000000000001";
    const selected = `${sourceRoot}/${first}/repeat`;
    const preserved = [
      "./user-package",
      `${sourceRoot}/${first}/other`,
      `${sourceRoot}/custom/repeat`,
    ];
    writeFileSync(
      join(project, "apm.yml"),
      Bun.YAML.stringify({ dependencies: { apm: [...preserved, selected] } }),
    );
    const makePlan = (id: string): PackagePlan => {
      const pkg = readPackage(name);
      if (!pkg) throw Error("Missing package fixture");
      const plan = buildPackagePlan({ ...input, packages: ["repeat"] }, tools, which, qualify, {
        cwd: project,
        packages: [{ ...pkg, name: "repeat", path: `${sourceRoot}/${id}/repeat`, format: "apm" }],
        profile: null,
        files: new Map(),
        join: posix.join,
        apmSourceRoot: sourceRoot,
      });
      const install = plan.steps[0];
      if (!install) throw Error("Missing APM install");
      return { ...plan, steps: [{ ...install, argv: [process.execPath, "--eval", ""] }] };
    };
    for (const id of [second, second]) {
      const result = Bun.spawnSync(packagePlanArgv(makePlan(id), process.execPath), {
        timeout: 10000,
      });
      expect(result.exitCode).toBe(0);
      expect(Bun.YAML.parse(readFileSync(join(project, "apm.yml"), "utf8"))).toEqual({
        dependencies: { apm: [...preserved, `${sourceRoot}/${second}/repeat`] },
      });
    }
  });
  test("Claude receives profile instructions, model and an explicit tool allowlist", () => {
    createAgent(
      profileName,
      "---\ndescription: Restricted reviewer\nmodel: configured-model\ntools:\n  Read: true\n  Bash: false\n---\nReview using the selected skill.",
    );
    const plan = buildPackagePlan(
      { ...input, tool: "skills", backend: "claude", agent: profileName },
      tools,
      which,
      qualify,
    );
    const launch = plan.steps.at(-1)?.argv ?? [];
    expect(launch).toContain("--append-system-prompt");
    expect(launch.join(" ")).toContain("Review using the selected skill.");
    expect(launch[launch.indexOf("--model") + 1]).toBe("configured-model");
    expect(launch[launch.indexOf("--tools") + 1]).toBe("Read");
    expect(() =>
      buildPackagePlan(
        { ...input, tool: "skills", backend: "codex", agent: profileName },
        tools,
        which,
        qualify,
      ),
    ).toThrow(/profiles currently require Claude/);
  });
  test("saves and reopens selections without touching the package", () => {
    const root = join(cwd, "setups");
    saveAgentSetup(input, root);
    expect(listAgentSetups(root).setups).toEqual([input]);
    expect(() => saveAgentSetup(input, root)).toThrow(/already exists/);
    expect(() => saveAgentSetup({ ...input, name: "../escape" }, root)).toThrow();
  });
  test("executes preparation as argv data, preserves project policy, and stops on failure", () => {
    const project = join(cwd, "runner");
    mkdirSync(project);
    const manifest = join(project, "apm.yml");
    writeFileSync(
      manifest,
      "name: existing\nversion: '1.0.0'\nexecutables:\n  deny: ['untrusted']\ndependencies:\n  apm: ['./existing']\n",
    );
    const plan: PackagePlan = {
      setup: input,
      notice: "test",
      steps: [
        {
          argv: [
            process.execPath,
            "--eval",
            "console.log(JSON.stringify(process.argv))",
            "--",
            "literal $(echo injected)",
          ],
          cwd: project,
          timeout: 10000,
          apmDependencies: ["./selected"],
        },
        {
          argv: [process.execPath, "--eval", "console.log('AGENT_STARTED')"],
          cwd: project,
          timeout: null,
        },
      ],
    };
    const result = Bun.spawnSync(packagePlanArgv(plan, process.execPath), {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("literal $(echo injected)");
    expect(result.stdout.toString()).toContain("AGENT_STARTED");
    expect(Bun.YAML.parse(readFileSync(manifest, "utf8"))).toMatchObject({
      executables: { deny: ["untrusted"] },
      dependencies: { apm: ["./existing", "./selected"] },
    });
    const preparation = plan.steps[0];
    if (!preparation) throw Error("Missing preparation step");
    preparation.argv = [process.execPath, "--eval", "process.exit(7)"];
    const failed = Bun.spawnSync(packagePlanArgv(plan, process.execPath), {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20000,
    });
    expect(failed.exitCode).toBe(7);
    expect(failed.stdout.toString()).not.toContain("AGENT_STARTED");
    preparation.argv = [process.execPath, "--eval", "process.exit(0)"];
    preparation.expectedPlugins = ["not-admitted"];
    const unregistered = Bun.spawnSync(packagePlanArgv(plan, process.execPath), {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20000,
    });
    expect(unregistered.exitCode).not.toBe(0);
    expect(unregistered.stdout.toString()).not.toContain("AGENT_STARTED");
    writeFileSync(manifest, "dependencies: invalid\n");
    const invalid = Bun.spawnSync(packagePlanArgv(plan, process.execPath), {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20000,
    });
    expect(invalid.exitCode).not.toBe(0);
    expect(readFileSync(manifest, "utf8")).toBe("dependencies: invalid\n");
  });
});
