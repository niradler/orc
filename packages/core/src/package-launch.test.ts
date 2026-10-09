import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, discoverAgents, getUserAgentsDir } from "./agent-service.js";
import {
  buildPackagePlan,
  listAgentSetups,
  packagePlanArgv,
  saveAgentSetup,
} from "./package-launch.js";
import { createPackage, getPackagesDir } from "./package-service.js";
import { listSkills, reloadCache } from "./skill-service.js";

const cwd = mkdtempSync(join(tmpdir(), "orc-launch-test-"));
Bun.spawnSync(["git", "init", cwd], { stdout: "ignore", stderr: "ignore", timeout: 10000 });
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
    expect(plan.steps[0]?.timeout).toBe(300000);
    expect(plan.steps[1]?.argv).toEqual(["/bin/copilot", "--interactive", input.prompt]);
    expect(plan.steps[1]?.timeout).toBeNull();
    expect(packagePlanArgv(plan, "/bun")[1]).toBe("--eval");
  });
  test("refuses unsupported whole-plugin activation and missing tooling", () => {
    expect(() => buildPackagePlan({ ...input, backend: "codex" }, tools, which, qualify)).toThrow(
      /Copilot/,
    );
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
    const plan = {
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
