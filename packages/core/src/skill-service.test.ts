import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSkill,
  getBuiltinSkillsDir,
  getUserSkillsDir,
  listSkills,
  parseFrontmatter,
  readSkill,
  reloadCache,
  type SkillFull,
  type SkillRefContent,
  scanSkills,
} from "./skill-service.js";

// ─── parseFrontmatter ────────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses valid frontmatter", () => {
    const content = `---
name: test-skill
description: A test skill
---

# Hello

Body content here.`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("test-skill");
    expect(frontmatter.description).toBe("A test skill");
    expect(frontmatter.metadata).toEqual({});
    expect(body).toBe("# Hello\n\nBody content here.");
  });

  test("extracts extra fields as metadata", () => {
    const content = `---
name: with-extras
description: Has extras
allowed-tools: Bash, Read
model: claude-sonnet
---

Content`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("with-extras");
    expect(frontmatter.metadata).toEqual({
      "allowed-tools": "Bash, Read",
      model: "claude-sonnet",
    });
  });

  test("defaults missing fields", () => {
    const content = `---
name: minimal
---

Content`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("minimal");
    expect(frontmatter.description).toBe("");
  });

  test("throws on missing frontmatter", () => {
    expect(() => parseFrontmatter("no frontmatter here")).toThrow("missing frontmatter");
  });
});

// ─── scanSkills ──────────────────────────────────────────────────────────────

describe("scanSkills", () => {
  test("finds built-in skills", () => {
    const skills = scanSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain("orc-coder");
    expect(names).toContain("orc-worker-base");
    expect(names).toContain("orc-reviewer");
    expect(names).toContain("orc-gateway");
  });

  test("built-in skills have source=builtin", () => {
    const skills = scanSkills();
    const coder = skills.find((s) => s.name === "orc-coder");
    expect(coder).toBeTruthy();
    expect(coder!.source).toBe("builtin");
  });

  test("skills are sorted by name", () => {
    const skills = scanSkills();
    const names = skills.map((s) => s.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  test("skill meta has correct fields", () => {
    const skills = scanSkills();
    const coder = skills.find((s) => s.name === "orc-coder");
    expect(coder).toBeTruthy();
    expect(coder!.description).toBeTruthy();
    expect(coder!.path).toContain("SKILL.md");
    expect(typeof coder!.metadata).toBe("object");
  });
});

// ─── listSkills ──────────────────────────────────────────────────────────────

describe("listSkills", () => {
  test("returns all skills", () => {
    const skills = listSkills({ reload: true });
    expect(skills.length).toBeGreaterThan(0);
    const names = skills.map((s) => s.name);
    expect(names).toContain("orc-coder");
  });

  test("filters by source", () => {
    const builtin = listSkills({ source: "builtin", reload: true });
    expect(builtin.every((s) => s.source === "builtin")).toBe(true);
  });

  test("keyword search on name", () => {
    const results = listSkills({ q: "coder", reload: true });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((s) => s.name.includes("coder"))).toBe(true);
  });

  test("keyword search on description", () => {
    const results = listSkills({ q: "implementation", reload: true });
    expect(results.length).toBeGreaterThan(0);
  });

  test("returns empty for no match", () => {
    const results = listSkills({ q: "xyznonexistent123", reload: true });
    expect(results).toEqual([]);
  });

  test("reload rebuilds cache", () => {
    const before = listSkills({ reload: true });
    const after = listSkills({ reload: true });
    expect(before.length).toBe(after.length);
  });
});

// ─── readSkill ───────────────────────────────────────────────────────────────

describe("readSkill", () => {
  test("reads a built-in skill", () => {
    reloadCache();
    const skill = readSkill("orc-coder") as SkillFull;
    expect(skill).toBeTruthy();
    expect(skill.name).toBe("orc-coder");
    expect(skill.content).toContain("Coder");
    expect(skill.source).toBe("builtin");
    expect(Array.isArray(skill.references)).toBe(true);
  });

  test("returns null for nonexistent skill", () => {
    reloadCache();
    const result = readSkill("nonexistent-skill-xyz");
    expect(result).toBeNull();
  });

  test("content excludes frontmatter", () => {
    reloadCache();
    const skill = readSkill("orc-coder") as SkillFull;
    expect(skill.content).not.toContain("---");
    expect(skill.content).not.toContain("name:");
  });
});

// ─── readSkill with ref ──────────────────────────────────────────────────────

describe("readSkill with ref", () => {
  const TMP_SKILL_DIR = join(getUserSkillsDir(), "__test-refs-skill__");

  beforeAll(() => {
    mkdirSync(join(TMP_SKILL_DIR, "references"), { recursive: true });
    writeFileSync(
      join(TMP_SKILL_DIR, "SKILL.md"),
      `---
name: __test-refs-skill__
description: Test skill with references
---

Test content`,
    );
    writeFileSync(join(TMP_SKILL_DIR, "references", "example.md"), "# Example\n\nExample content.");
    writeFileSync(join(TMP_SKILL_DIR, "references", "data.json"), '{"key": "value"}');
    reloadCache();
  });

  afterAll(() => {
    rmSync(TMP_SKILL_DIR, { recursive: true, force: true });
    reloadCache();
  });

  test("lists reference files", () => {
    const skill = readSkill("__test-refs-skill__") as SkillFull;
    expect(skill).toBeTruthy();
    expect(skill.references.length).toBe(2);
    const names = skill.references.map((r) => r.name).sort();
    expect(names).toEqual(["data.json", "example.md"]);
  });

  test("reads a specific reference file", () => {
    const ref = readSkill("__test-refs-skill__", "example.md") as SkillRefContent;
    expect(ref).toBeTruthy();
    expect(ref.name).toBe("example.md");
    expect(ref.content).toContain("Example content");
  });

  test("reads non-markdown reference file", () => {
    const ref = readSkill("__test-refs-skill__", "data.json") as SkillRefContent;
    expect(ref).toBeTruthy();
    expect(ref.content).toContain('"key"');
  });

  test("throws for path traversal", () => {
    expect(() => readSkill("__test-refs-skill__", "../SKILL.md")).toThrow("Invalid reference");
  });

  test("throws for nonexistent ref", () => {
    expect(() => readSkill("__test-refs-skill__", "nope.md")).toThrow("not found");
  });
});

// ─── createSkill ─────────────────────────────────────────────────────────────

describe("createSkill", () => {
  const TEST_NAME = "__test-create-skill__";
  const skillDir = join(getUserSkillsDir(), TEST_NAME);

  afterAll(() => {
    rmSync(skillDir, { recursive: true, force: true });
    reloadCache();
  });

  test("creates a new user skill", () => {
    const content = `---
name: ${TEST_NAME}
description: Created by test
---

Test skill body.`;

    const skill = createSkill(TEST_NAME, content);
    expect(skill.name).toBe(TEST_NAME);
    expect(skill.source).toBe("user");
    expect(skill.content).toBe("Test skill body.");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
  });

  test("created skill appears in list", () => {
    const skills = listSkills({ reload: true });
    expect(skills.some((s) => s.name === TEST_NAME)).toBe(true);
  });

  test("throws for duplicate name", () => {
    expect(() => createSkill(TEST_NAME, `---\nname: ${TEST_NAME}\n---\ndup`)).toThrow(
      "already exists",
    );
  });

  test("throws for invalid name with path traversal", () => {
    expect(() => createSkill("../evil", "---\nname: evil\n---\ncontent")).toThrow(
      "Invalid skill name",
    );
  });
});

// ─── getBuiltinSkillsDir / getUserSkillsDir ──────────────────────────────────

describe("directory helpers", () => {
  test("getBuiltinSkillsDir returns a path containing 'skills'", () => {
    expect(getBuiltinSkillsDir()).toContain("skills");
  });

  test("getUserSkillsDir returns a path under home", () => {
    expect(getUserSkillsDir()).toContain(".orc");
    expect(getUserSkillsDir()).toContain("skills");
  });
});
