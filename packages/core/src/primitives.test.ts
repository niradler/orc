import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createAgent,
  discoverAgents,
  getUserAgentsDir,
  parseAgent,
  readAgent,
} from "./agent-service.js";
import { parseFlowDefinition } from "./flow.js";
import {
  createPackage,
  getPackagesDir,
  packageInstructionsForAgent,
  parseApmManifest,
  readPackage,
  readPackageFile,
  validateInstruction,
} from "./package-service.js";
import { parseFrontmatter, readSkill, reloadCache, type SkillFull } from "./skill-service.js";

describe("Agent Skills specification", () => {
  test("should parse quoted YAML, folded descriptions and all optional fields", () => {
    const parsed = parseFrontmatter(
      `---\nname: "spec-skill"\ndescription: >-\n  Use when reviewing\n  multi-file skills.\nlicense: MIT\ncompatibility: Requires Bun\nallowed-tools: Read Grep\nmetadata:\n  author: test\n  version: "1.0"\n---\nBody`,
    );
    expect(parsed.frontmatter).toMatchObject({
      name: "spec-skill",
      description: "Use when reviewing multi-file skills.",
      metadata: {
        license: "MIT",
        compatibility: "Requires Bun",
        "allowed-tools": "Read Grep",
        metadata: { author: "test", version: "1.0" },
      },
    });
  });
  test("should reject invalid required fields, names, lengths and optional field shapes", () => {
    const invalid = [
      "description: missing name",
      "name: missing-description",
      "name: Invalid\ndescription: x",
      "name: double--hyphen\ndescription: x",
      "name: trailing-\ndescription: x",
      "name: under_score\ndescription: x",
      `name: ${"a".repeat(65)}\ndescription: x`,
      `name: good\ndescription: ${"a".repeat(1025)}`,
      "name: good\ndescription: 123",
      "name: good\ndescription: '  '",
      "name: good\ndescription: x\nallowed-tools: [Read]",
      "name: good\ndescription: x\nmetadata:\n  version: 1",
      "name: good\ndescription: x\nmodel: claude",
      `name: good\ndescription: x\ncompatibility: ${"x".repeat(501)}`,
      "name: [bad]\ndescription: x",
      "name: good\ndescription: x\nmetadata: [bad]",
    ];
    for (const fields of invalid)
      expect(() => parseFrontmatter(`---\n${fields}\n---\nBody`)).toThrow();
  });
});

describe("APM authored agents and packages", () => {
  const name = `shared-package-${process.pid}`;
  const skillName = `shared-workflow-${process.pid}`;
  const agentId = `shared-agent-${process.pid}`;
  const rootSkillPackage = `${name}-root`;
  const agent =
    "---\nname: Security review\ndescription: Review changes\nmodel: test-model\ntools:\n  Read: true\n  Bash: false\ncolor: '#abc123'\nhandoffs:\n  - agent: build\n    label: Fix findings\n    prompt: Apply fixes\n    send: false\ncustom-field: preserved\n---\nYou are the reviewer. Read ../../references/policy.md.";
  const manifest = `name: ${name}\nversion: '1.0.0'\ndescription: Shared specialists\ntargets: [claude, codex, cursor]\nx-custom: preserved\nscripts:\n  validate: bun scripts/check.ts\ndependencies:\n  apm: [example/dependency]\n`;
  afterAll(() => {
    rmSync(join(getPackagesDir(), name), { recursive: true, force: true });
    rmSync(join(getPackagesDir(), rootSkillPackage), { recursive: true, force: true });
    rmSync(join(getUserAgentsDir(), `${agentId}.agent.md`), { force: true });
    reloadCache();
  });
  test("should validate agent YAML and preserve model, tools, structured handoffs and extensions", () => {
    const parsed = parseAgent(agent, "review.agent.md");
    expect(parsed.fields.tools).toEqual({ Read: true, Bash: false });
    expect(parsed.fields.handoffs).toEqual([
      { agent: "build", label: "Fix findings", prompt: "Apply fixes", send: false },
    ]);
    expect(parsed.fields["custom-field"]).toBe("preserved");
    expect(
      parseAgent("---\ndescription: Review\n---\nBody", "default-name.agent.md").fields.name,
    ).toBe("default-name");
    expect(() => parseAgent("---\nname: bad\n---\nBody", "bad.agent.md")).toThrow("description");
    expect(() =>
      parseAgent("---\ndescription: x\ntools: { Read: nope }\n---\nBody", "bad.agent.md"),
    ).toThrow("frontmatter");
  });
  test("should share standalone agent definitions with their raw source unchanged", () => {
    const created = createAgent(agentId, agent);
    expect(readAgent(agentId)?.raw).toBe(agent);
    expect(discoverAgents().agents.find((profile) => profile.id === agentId)?.fields).toEqual(
      created.fields,
    );
  });
  test("should import a complete APM package and discover its agents and skills", () => {
    const pkg = createPackage(name, manifest, [
      { path: ".apm/agents/review.agent.md", content: agent },
      {
        path: `.apm/skills/${skillName}/SKILL.md`,
        content: `---\nname: ${skillName}\ndescription: Shared workflow\n---\nRead references/guide.md.`,
      },
      { path: `.apm/skills/${skillName}/references/guide.md`, content: "Shared guide" },
      { path: "references/policy.md", content: "Review policy" },
      {
        path: ".apm/instructions/always.instructions.md",
        content: "---\ndescription: Global package rule\n---\nNever expose secrets.",
      },
      {
        path: ".apm/instructions/style.instructions.md",
        content:
          "---\ndescription: Frontend rules\napplyTo: '**/*.{css,scss},**/*.tsx'\n---\nUse styles.",
      },
      { path: "scripts/check.ts", content: "throw new Error('must not execute during import')" },
      { path: "assets/example.bin", content: "AP8=", encoding: "base64" },
    ]);
    expect(pkg.files).toHaveLength(8);
    expect(readPackage(name)?.content).toBe(manifest);
    expect(pkg.manifest["x-custom"]).toBe("preserved");
    expect(readPackageFile(name, "assets/example.bin")).toMatchObject({
      content: "AP8=",
      encoding: "base64",
    });
    const profile = readAgent(`${name}/review`);
    expect(profile?.raw).toBe(agent);
    expect(discoverAgents().agents.filter((entry) => entry.id.startsWith(`${name}/`))).toHaveLength(
      1,
    );
    const skill = readSkill(skillName) as SkillFull;
    expect(skill.files[0]?.name).toBe("references/guide.md");
    expect(skill.path).toContain(name);
    const instructions = packageInstructionsForAgent(profile?.path ?? "");
    expect(instructions).toContain("Never expose secrets");
    expect(instructions).toContain("**/*.{css,scss},**/*.tsx");
    expect(instructions).not.toContain("Use styles.");
  });
  test("should reject invalid manifests and primitives before writing", () => {
    expect(() => parseApmManifest("name: x\nversion: 12")).toThrow("apm.yml");
    expect(() =>
      parseApmManifest("name: x\nversion: '1.0.0'\ntarget: claude\ntargets: [codex]"),
    ).toThrow();
    expect(() =>
      parseApmManifest("$schema: https://untrusted.example/schema\nname: x\nversion: '1.0.0'"),
    ).toThrow("Unsupported");
    const invalid = `${name}-invalid`;
    expect(() =>
      createPackage(invalid, manifest.replace(name, invalid), [
        { path: ".apm/agents/bad.agent.md", content: "---\nname: x\n---\nBody" },
      ]),
    ).toThrow("description");
    expect(existsSync(join(getPackagesDir(), invalid))).toBe(false);
    expect(() => readPackageFile(name, "../secret")).toThrow("Invalid reference");
    expect(
      validateInstruction("---\ndescription: Always\n---\nBody").fields.applyTo,
    ).toBeUndefined();
    expect(
      validateInstruction("---\ndescription: Scoped\napplyTo: ['**/*.ts', '**/*.tsx']\n---\nBody")
        .fields.applyTo,
    ).toEqual(["**/*.ts", "**/*.tsx"]);
  });
  test("should discover a single-skill APM package rooted at SKILL.md", () => {
    createPackage(rootSkillPackage, `name: ${rootSkillPackage}\nversion: '1.0.0'\n`, [
      {
        path: "SKILL.md",
        content: `---\nname: ${rootSkillPackage}\ndescription: Root package workflow\n---\nRun scripts/check.py.`,
      },
      { path: "scripts/check.py", content: "print('shared')" },
    ]);
    expect((readSkill(rootSkillPackage) as SkillFull).files.map((file) => file.name)).toContain(
      "scripts/check.py",
    );
  });
  test("should allow named profiles on agent flow nodes", () => {
    const flow = parseFlowDefinition({
      name: "profile-flow",
      entry: "review",
      nodes: {
        review: { kind: "agent", agent: `${name}/review`, backend: "codex", outcomes: ["pass"] },
        done: { kind: "terminal", task_status: "done" },
      },
      edges: [{ from: "review", to: "done", when: { outcome: "pass" } }],
    });
    expect(flow.ok).toBe(true);
    if (!flow.ok) throw new Error(flow.errors.join("; "));
    expect(flow.definition.nodes.review?.agent).toBe(`${name}/review`);
  });
});
