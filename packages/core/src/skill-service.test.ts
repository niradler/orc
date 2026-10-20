import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSkillFile } from "./skill-files.js";
import {
  createSkill,
  getBuiltinSkillsDir,
  getUserSkillsDir,
  listSkills,
  parseFrontmatter,
  readSkill,
  reloadCache,
  renderSkillInstructions,
  type SkillFull,
  type SkillRefContent,
  scanSkills,
  skillWarnings,
  validateAuthoredSkillDescription,
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
metadata:
  model: claude-sonnet
---

Content`;

    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.name).toBe("with-extras");
    expect(frontmatter.metadata).toEqual({
      "allowed-tools": "Bash, Read",
      metadata: { model: "claude-sonnet" },
    });
  });

  test("should reject missing required fields", () => {
    const content = `---
name: minimal
---

Content`;

    expect(() => parseFrontmatter(content)).toThrow("description");
  });

  test("throws on missing frontmatter", () => {
    expect(() => parseFrontmatter("no frontmatter here")).toThrow("frontmatter");
  });
});

describe("multi-file skill bundles", () => {
  const name = `bundle-${process.pid}`;
  const root = join(getUserSkillsDir(), name);
  const outside = mkdtempSync(join(tmpdir(), "orc-skill-outside-"));
  const content = `---\nname: ${name}\ndescription: Multi-file workflow\n---\nRead references/topics/guide.md and run scripts/check.py when needed.`;

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    reloadCache();
  });

  test("should preserve UTF-8 BOM bytes when transporting authored files", () => {
    const bytes = Buffer.from("\uFEFF# Shared resource\r\n", "utf8");
    const encoded = encodeSkillFile(bytes);
    expect(Buffer.from(encoded.content, encoded.encoding)).toEqual(bytes);
  });

  test("should create, inventory and read nested docs, scripts, root files and binary assets", () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const skill = createSkill(name, content, [
      { path: "references/topics/guide.md", content: "# Detailed guide" },
      { path: "references/legacy.md", content: "Legacy reference" },
      { path: "scripts/check.py", content: "print('validated')" },
      { path: "extra.md", content: "More instructions" },
      {
        path: "assets/sample.bin",
        content: bytes.toString("base64"),
        encoding: "base64",
      },
    ]);
    expect(skill.files.map((file) => file.name)).toEqual([
      "assets/sample.bin",
      "extra.md",
      "references/legacy.md",
      "references/topics/guide.md",
      "scripts/check.py",
    ]);
    expect(skill.references.map((file) => file.name)).toEqual(["legacy.md", "topics/guide.md"]);
    expect(skill.content).not.toContain("# Detailed guide");
    expect((readSkill(name, "references/topics/guide.md") as SkillRefContent).content).toBe(
      "# Detailed guide",
    );
    expect((readSkill(name, "legacy.md") as SkillRefContent).content).toBe("Legacy reference");
    expect((readSkill(name, "scripts/check.py") as SkillRefContent).content).toBe(
      "print('validated')",
    );
    expect((readSkill(name, "extra.md") as SkillRefContent).content).toBe("More instructions");
    const asset = readSkill(name, "assets/sample.bin") as SkillRefContent;
    expect(asset.encoding).toBe("base64");
    expect(Buffer.from(asset.content, "base64")).toEqual(bytes);
    expect(readFileSync(join(root, "assets/sample.bin"))).toEqual(bytes);
    reloadCache();
    expect((readSkill(name) as SkillFull).files).toEqual(skill.files);
    const prompt = renderSkillInstructions(skill);
    expect(prompt).toContain(skill.path);
    expect(prompt).toContain("scripts/check.py");
    expect(prompt).not.toContain("print('validated')");
  });

  test("should reject traversal, absolute paths, Windows streams and malformed paths on reads", () => {
    for (const path of [
      "../SKILL.md",
      "scripts/../../secret",
      "/etc/passwd",
      "C:/secret",
      "scripts\\check.py",
      "scripts//check.py",
      "scripts/./check.py",
      "assets/x:stream",
      "assets/NUL",
      "assets/trailing.",
      "assets/x\0y",
    ]) {
      expect(() => readSkill(name, path)).toThrow("Invalid reference");
    }
    expect(() => readSkill(name, "scripts/missing.py")).toThrow("not found");
  });

  test("should reject invalid bundles before writing any files", () => {
    const invalidName = `${name}-invalid`;
    const entry = content.replace(name, invalidName);
    const bundles = [
      [{ path: "../escape.md", content: "escape" }],
      [{ path: "SKILL.md", content: "overwrite" }],
      [
        { path: "A.md", content: "a" },
        { path: "a.md", content: "b" },
      ],
      [
        { path: "scripts", content: "file" },
        { path: "scripts/run.py", content: "script" },
      ],
      [
        {
          path: "assets/x.bin",
          content: "not-base64!",
          encoding: "base64" as const,
        },
      ],
      [{ path: "big.txt", content: "a".repeat(8 * 1024 * 1024 + 1) }],
    ];
    for (const files of bundles) {
      expect(() => createSkill(invalidName, entry, files)).toThrow();
      expect(existsSync(join(getUserSkillsDir(), invalidName))).toBe(false);
    }
    expect(() => createSkill(invalidName, content)).toThrow("must match");
  });

  test("should exclude symlink directories and reject reads through them", () => {
    writeFileSync(join(outside, "secret.md"), "outside secret");
    symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(
      (readSkill(name) as SkillFull).files.some((file) => file.name.startsWith("linked/")),
    ).toBe(false);
    expect(() => readSkill(name, "linked/secret.md")).toThrow("symlinks");
  });
});

// ─── scanSkills ──────────────────────────────────────────────────────────────

describe("scanSkills", () => {
  test("finds built-in skills", () => {
    const skills = scanSkills();
    const names = skills.filter((s) => s.source === "builtin").map((s) => s.name);
    expect(names).toEqual(["orc-platform", "orc-sdlc"]);
  });

  test("built-in skills have source=builtin", () => {
    const skills = scanSkills();
    const coder = skills.find((s) => s.name === "orc-sdlc");
    expect(coder).toBeTruthy();
    expect(coder?.source).toBe("builtin");
  });

  test("skills are sorted by name", () => {
    const skills = scanSkills();
    const names = skills.map((s) => s.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  test("skill meta has correct fields", () => {
    const skills = scanSkills();
    const coder = skills.find((s) => s.name === "orc-sdlc");
    expect(coder).toBeTruthy();
    expect(coder?.description).toBeTruthy();
    expect(coder?.path).toContain("SKILL.md");
    expect(typeof coder?.metadata).toBe("object");
  });

  test("user skills cannot shadow a built-in skill", () => {
    const shadowDir = join(getUserSkillsDir(), "orc-platform");
    expect(existsSync(shadowDir)).toBe(false);
    const content = "---\nname: orc-platform\ndescription: Shadow\n---\n\nInjected";
    expect(() => createSkill("orc-platform", content)).toThrow("already exists");
    mkdirSync(shadowDir, { recursive: true });
    try {
      writeFileSync(join(shadowDir, "SKILL.md"), content);
      const broken: { path: string; error: string }[] = [];
      const base = scanSkills(broken).find((s) => s.name === "orc-platform");
      expect(base?.source).toBe("builtin");
      expect(broken.some((b) => b.path.startsWith(shadowDir))).toBe(true);
    } finally {
      rmSync(shadowDir, { recursive: true, force: true });
    }
  });
});

// ─── fields outside the spec ────────────────────────────────────────────────

describe("skills with top-level fields outside the spec", () => {
  const name = `extra-fields-${process.pid}`;
  const content = `---
name: ${name}
description: Hinted
argument-hint: <file>
version: 1.0
---
Body`;

  afterAll(() => {
    rmSync(join(getUserSkillsDir(), name), { recursive: true, force: true });
    reloadCache();
  });

  test("should create and load them without a warning, keeping the fields in metadata", () => {
    createSkill(name, content);
    const broken: { path: string; error: string }[] = [];
    const warnings: { path: string; message: string }[] = [];
    const skill = scanSkills(broken, warnings).find((x) => x.name === name);
    expect(skill?.metadata).toEqual({ "argument-hint": "<file>", version: 1 });
    const file = join(getUserSkillsDir(), name, "SKILL.md");
    expect(broken.some((b) => b.path === file)).toBe(false);
    expect(warnings.some((w) => w.path === file)).toBe(false);
  });
});

// ─── legacy skills (strict on write, lenient on read) ───────────────────────

describe("legacy skills installed before frontmatter validation", () => {
  const prefix = `legacy-${process.pid}`;
  const cases = [
    {
      dir: `${prefix}-yaml`,
      content: "---\nname: LEGACY_YAML\ndescription: Use when: debugging\n---\nBody yaml",
      name: "LEGACY_YAML",
      description: "Use when: debugging",
    },
    {
      dir: `${prefix}-upper`,
      content: "---\nname: My_Skill\ndescription: Underscored\n---\nBody upper",
      name: "My_Skill",
      description: "Underscored",
    },
  ];
  const roots = cases.map((c) => join(getUserSkillsDir(), c.dir));

  beforeAll(() => {
    for (const [i, c] of cases.entries()) {
      mkdirSync(roots[i] as string, { recursive: true });
      writeFileSync(join(roots[i] as string, "SKILL.md"), c.content);
    }
    reloadCache();
  });

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    reloadCache();
  });

  for (const c of cases) {
    test(`loads ${c.dir} with a warning instead of marking it broken`, () => {
      const broken: { path: string; error: string }[] = [];
      const warnings: { path: string; message: string }[] = [];
      const skill = scanSkills(broken, warnings).find((x) => x.name === c.name);
      expect(skill?.description).toBe(c.description);
      expect(skill?.source).toBe("user");
      const file = join(getUserSkillsDir(), c.dir, "SKILL.md");
      expect(broken.some((b) => b.path === file)).toBe(false);
      expect(warnings.some((w) => w.path === file && w.message.length > 0)).toBe(true);
      expect(skillWarnings().some((w) => w.path === file)).toBe(true);
    });

    test(`readSkill returns the body of ${c.dir}`, () => {
      const full = readSkill(c.name) as SkillFull;
      expect(full.content).toBe(c.content.split("---\n").pop() as string);
    });

    test(`createSkill still rejects the ${c.dir} shape`, () => {
      expect(() => createSkill(c.name, c.content)).toThrow();
    });
  }

  test("a legacy skill with no description is still broken", () => {
    const dir = join(getUserSkillsDir(), `${prefix}-nodesc`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "SKILL.md"),
        `---
name: ${prefix}-nodesc
---
Body`,
      );
      const broken: { path: string; error: string }[] = [];
      scanSkills(broken);
      expect(broken.some((b) => b.path.startsWith(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a legacy skill cannot shadow a built-in skill", () => {
    const dir = join(getUserSkillsDir(), "orc-platform");
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "SKILL.md"),
        "---\nname: orc-platform\ndescription: Use when: shadowing\n---\nInjected",
      );
      const broken: { path: string; error: string }[] = [];
      const base = scanSkills(broken).find((x) => x.name === "orc-platform");
      expect(base?.source).toBe("builtin");
      expect(broken.some((b) => b.path.startsWith(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── listSkills ──────────────────────────────────────────────────────────────

describe("listSkills", () => {
  test("routes platform domain queries to its entry point without advertising retired skills", () => {
    for (const q of [
      "memory",
      "tasks",
      "gateway",
      "embedding",
      "handoff",
      "CLI",
      "MCP",
      "SSH",
      "rules",
      "GitHub",
      "audit",
      "tags",
    ]) {
      expect(listSkills({ source: "builtin", q, reload: true }).map((s) => s.name)).toEqual([
        "orc-platform",
      ]);
    }
  });
  test("returns all skills", () => {
    const skills = listSkills({ reload: true });
    expect(skills.length).toBeGreaterThan(0);
    const names = skills.map((s) => s.name);
    expect(names).toContain("orc-sdlc");
  });

  test("filters by source", () => {
    const builtin = listSkills({ source: "builtin", reload: true });
    expect(builtin.every((s) => s.source === "builtin")).toBe(true);
  });

  test("keyword search on name", () => {
    const results = listSkills({ q: "sdlc", reload: true });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((s) => s.name.includes("sdlc"))).toBe(true);
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
  test("legacy names stay readable without becoming discovery entries", () => {
    reloadCache();
    for (const name of [
      "orc-coder",
      "orc-worker-base",
      "orc-reviewer",
      "orc-memory",
      "orc-handoff",
    ]) {
      expect(
        listSkills({ source: "builtin", include_hidden: true }).some((s) => s.name === name),
      ).toBe(false);
      const skill = readSkill(name) as SkillFull;
      expect(skill.name).toBe(name);
      expect(skill.files.length).toBeGreaterThan(0);
      const raw = readSkill(name, "SKILL.md") as SkillRefContent;
      expect(parseFrontmatter(raw.content).frontmatter.name).toBe(name);
    }
    expect((readSkill("orc-handoff", "scripts/upload-session.py") as SkillRefContent).content).toBe(
      (readSkill("orc-platform", "scripts/upload-session.py") as SkillRefContent).content,
    );
    expect(() => readSkill("orc-handoff", "../secret.md")).toThrow("Invalid");
    expect(readSkill("constructor")).toBeNull();
  });

  test("entry points inventory supporting files without preloading them", () => {
    for (const name of ["orc-platform", "orc-sdlc"]) {
      const skill = readSkill(name) as SkillFull;
      expect(skill.references.length).toBeGreaterThan(0);
      for (const file of skill.references) {
        const ref = readSkill(name, file.name) as SkillRefContent;
        expect(ref.encoding).toBe("utf8");
        expect(ref.content.length).toBeGreaterThan(0);
        expect(skill.content).not.toContain(ref.content);
      }
    }
  });

  test("reads a built-in skill", () => {
    reloadCache();
    const skill = readSkill("orc-sdlc") as SkillFull;
    expect(skill).toBeTruthy();
    expect(skill.name).toBe("orc-sdlc");
    expect(skill.content).toBe(
      parseFrontmatter(readFileSync(join(getBuiltinSkillsDir(), "orc-sdlc", "SKILL.md"), "utf8"))
        .body,
    );
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
    const skill = readSkill("orc-sdlc") as SkillFull;
    expect(skill.content).not.toMatch(/^---\r?\n/);
    expect(skill.content).not.toContain("name:");
  });
});

// ─── readSkill with ref ──────────────────────────────────────────────────────

describe("readSkill with ref", () => {
  const TMP_SKILL_DIR = join(getUserSkillsDir(), "test-refs-skill");

  beforeAll(() => {
    mkdirSync(join(TMP_SKILL_DIR, "references"), { recursive: true });
    writeFileSync(
      join(TMP_SKILL_DIR, "SKILL.md"),
      `---
name: test-refs-skill
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
    const skill = readSkill("test-refs-skill") as SkillFull;
    expect(skill).toBeTruthy();
    expect(skill.references.length).toBe(2);
    const names = skill.references.map((r) => r.name).sort();
    expect(names).toEqual(["data.json", "example.md"]);
  });

  test("reads a specific reference file", () => {
    const ref = readSkill("test-refs-skill", "example.md") as SkillRefContent;
    expect(ref).toBeTruthy();
    expect(ref.name).toBe("example.md");
    expect(ref.content).toContain("Example content");
  });

  test("reads non-markdown reference file", () => {
    const ref = readSkill("test-refs-skill", "data.json") as SkillRefContent;
    expect(ref).toBeTruthy();
    expect(ref.content).toContain('"key"');
  });

  test("throws for path traversal", () => {
    expect(() => readSkill("test-refs-skill", "../SKILL.md")).toThrow("Invalid reference");
  });

  test("throws for nonexistent ref", () => {
    expect(() => readSkill("test-refs-skill", "nope.md")).toThrow("not found");
  });
});

// ─── createSkill ─────────────────────────────────────────────────────────────

describe("createSkill", () => {
  const TEST_NAME = "test-create-skill";
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

describe("validateAuthoredSkillDescription", () => {
  const skill = (description: string) =>
    ["---", "name: demo", `description: ${description}`, "---", "", "Body"].join("\n");

  test("accepts descriptions up to 300 characters", () => {
    expect(() => validateAuthoredSkillDescription(skill("a".repeat(300)))).not.toThrow();
  });

  test("rejects longer descriptions on authored skills", () => {
    expect(() => validateAuthoredSkillDescription(skill("a".repeat(301)))).toThrow(
      "skills written in ORC keep it to 300",
    );
  });

  test("allows an unchanged long description when editing", () => {
    const long = skill("a".repeat(500));
    expect(() => validateAuthoredSkillDescription(`${long}\nMore`, long)).not.toThrow();
    expect(() => validateAuthoredSkillDescription(skill("b".repeat(500)), long)).toThrow();
  });
});
