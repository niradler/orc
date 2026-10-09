import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { getUserSkillsDir, reloadCache } from "@orc/core/skill-service";
import { createTestDb } from "@orc/db/client";
import { executeTool } from "../tools.js";

const originalActiveProject = process.env.ORC_ACTIVE_PROJECT;

beforeAll(() => {
  process.env.ORC_ACTIVE_PROJECT = "";
  resetConfig();
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
  reloadCache();
});

afterAll(() => {
  if (originalActiveProject === undefined) delete process.env.ORC_ACTIVE_PROJECT;
  else process.env.ORC_ACTIVE_PROJECT = originalActiveProject;
  resetConfig();
  delete process.env.ORC_DB_PATH;
});

// ─── skill_list ──────────────────────────────────────────────────────────────

describe("skill_list", () => {
  test("lists all built-in skills", async () => {
    const result = await executeTool("skill_list", {});
    expect(result).toContain("orc-coder");
    expect(result).toContain("orc-worker-base");
    expect(result).toContain("orc-reviewer");
    expect(result).toContain("orc-gateway");
  });

  test("keyword search", async () => {
    const result = await executeTool("skill_list", { q: "coder" });
    expect(result).toContain("orc-coder");
    expect(result).not.toContain("orc-reviewer");
  });

  test("returns message for no match", async () => {
    const result = await executeTool("skill_list", { q: "xyznonexistent123" });
    expect(result).toContain("No skills found");
  });

  test("reload rebuilds cache", async () => {
    const result = await executeTool("skill_list", { reload: true });
    expect(result).toContain("orc-coder");
  });
});

// ─── skill_read ──────────────────────────────────────────────────────────────

describe("skill_read", () => {
  test("reads a built-in skill", async () => {
    const result = await executeTool("skill_read", { name: "orc-coder" });
    expect(result).toContain("# orc-coder");
    expect(result).toContain("Coder");
  });

  test("returns not found message for nonexistent skill", async () => {
    const result = await executeTool("skill_read", { name: "nonexistent-xyz" });
    expect(result).toContain("Skill not found");
  });

  test("shows description in output", async () => {
    const result = await executeTool("skill_read", { name: "orc-coder" });
    expect(result).toContain("Implementation workflow");
  });
});

// ─── skill_create ────────────────────────────────────────────────────────────

describe("skill_create", () => {
  const TEST_NAME = "test-mcp-create";
  const skillDir = join(getUserSkillsDir(), TEST_NAME);

  afterAll(() => {
    rmSync(skillDir, { recursive: true, force: true });
    reloadCache();
  });

  test("creates a new user skill", async () => {
    const content = `---
name: ${TEST_NAME}
description: MCP test skill
---

MCP test body.`;

    const result = await executeTool("skill_create", { name: TEST_NAME, content });
    expect(result).toContain("Created skill");
    expect(result).toContain(TEST_NAME);
  });

  test("created skill appears in skill_list", async () => {
    const result = await executeTool("skill_list", { reload: true });
    expect(result).toContain(TEST_NAME);
  });

  test("created skill is readable via skill_read", async () => {
    const result = await executeTool("skill_read", { name: TEST_NAME });
    expect(result).toContain("MCP test body");
  });

  test("returns error for duplicate", async () => {
    const result = await executeTool("skill_create", {
      name: TEST_NAME,
      content: `---\nname: ${TEST_NAME}\n---\ndup`,
    });
    expect(result).toContain("Error");
    expect(result).toContain("already exists");
  });
});

describe("multi-file skills MCP", () => {
  const name = `mcp-bundle-${process.pid}`;
  afterAll(() => {
    rmSync(join(getUserSkillsDir(), name), { recursive: true, force: true });
    reloadCache();
  });

  test("should create a bundle, inventory resources and read a script without executing it", async () => {
    const created = await executeTool("skill_create", {
      name,
      content: `---\nname: ${name}\ndescription: Bundle\n---\nMain instructions`,
      files: [
        { path: "scripts/run.py", content: "raise RuntimeError('do not execute while reading')" },
        { path: "references/deep/guide.md", content: "Detailed guide" },
      ],
    });
    expect(created).toContain("Created skill");
    const entry = await executeTool("skill_read", { name });
    expect(entry).toContain("scripts/run.py");
    expect(entry).toContain("references/deep/guide.md");
    expect(entry).not.toContain("raise RuntimeError");
    const script = await executeTool("skill_read", { name, ref: "scripts/run.py" });
    expect(script).toContain("raise RuntimeError");
    expect(await executeTool("skill_read", { name, ref: "references/deep/guide.md" })).toContain(
      "Detailed guide",
    );
  });
});
