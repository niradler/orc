import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ulid } from "@orc/core/ids";
import { closeDb, createTestDb, getDb } from "@orc/db/client";
import { prompts } from "@orc/db/schema";
import { executeTool } from "../tools.js";

const TMP = join(import.meta.dirname, ".tmp-mcp-refs-test");
const SKILL_DIR = "src/__tests__/.tmp-mcp-refs-test";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();

  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "SKILL.md"), "---\nname: mcp-ref-test\n---\nMain template");
  writeFileSync(join(TMP, "reference.md"), "# API Docs\nGET /health → 200 OK");
  writeFileSync(join(TMP, "patterns.md"), "# Patterns\nUse repository pattern");
});

afterAll(() => {
  closeDb();
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.ORC_DB_PATH;
});

describe("MCP prompt_get with skill references", () => {
  test("setup: insert prompts", async () => {
    const db = getDb();
    await db.insert(prompts).values({
      id: ulid(),
      name: "mcp-ref-test",
      description: "A skill with refs",
      template: "Main template content",
      is_skill: true,
      skill_dir: SKILL_DIR,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    });
    await db.insert(prompts).values({
      id: ulid(),
      name: "no-refs",
      template: "Plain prompt",
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    });
  });

  test("lists reference file paths for skill with refs", async () => {
    const result = await executeTool("prompt_get", { name: "mcp-ref-test" });
    const absDir = resolve(process.cwd(), SKILL_DIR);
    expect(result).toContain("Main template content");
    expect(result).toContain(`References in ${absDir}/`);
    expect(result).toContain(`${absDir}/reference.md`);
    expect(result).toContain(`${absDir}/patterns.md`);
    // Should NOT include file contents — agent uses Read
    expect(result).not.toContain("GET /health");
    expect(result).not.toContain("repository pattern");
  });

  test("no references section for prompt without skill_dir", async () => {
    const result = await executeTool("prompt_get", { name: "no-refs" });
    expect(result).toContain("Plain prompt");
    expect(result).not.toContain("References in");
  });
});
