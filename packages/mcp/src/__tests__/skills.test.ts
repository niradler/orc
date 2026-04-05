import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getUserSkillsDir, reloadCache } from "@orc/core/skill-service";
import { createTestDb } from "@orc/db/client";
import { executeTool } from "../tools.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
  reloadCache();
});

afterAll(() => {
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
  const TEST_NAME = "__test-mcp-create__";
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
