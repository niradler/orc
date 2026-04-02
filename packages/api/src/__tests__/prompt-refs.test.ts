import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;

const TMP_SKILL_DIR = join(import.meta.dirname, ".tmp-prompt-refs-test");
const SKILL_REL_PATH = "packages/api/src/__tests__/.tmp-prompt-refs-test";

beforeAll(() => {
  rmSync(TMP_SKILL_DIR, { recursive: true, force: true });
  mkdirSync(TMP_SKILL_DIR, { recursive: true });
  writeFileSync(join(TMP_SKILL_DIR, "SKILL.md"), "---\nname: ref-test\n---\nMain skill content");
  writeFileSync(join(TMP_SKILL_DIR, "reference.md"), "# API Reference\nGET /users");
  writeFileSync(join(TMP_SKILL_DIR, "conventions.md"), "# Conventions\nUse camelCase");

  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
  rmSync(TMP_SKILL_DIR, { recursive: true, force: true });
});

describe("Prompt with skill references via API", () => {
  let promptId: string;

  test("create prompt with skill_dir", async () => {
    const res = await req(app, "POST", "/prompts", {
      name: "ref-test-skill",
      description: "A skill with reference files",
      template: "Main skill content",
      is_skill: true,
      skill_dir: SKILL_REL_PATH,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    promptId = body.id;
    expect(body.skill_dir).toBe(SKILL_REL_PATH);
  });

  test("GET returns raw template and skill_dir (references loaded separately)", async () => {
    const res = await req(app, "GET", `/prompts/${promptId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toBe("Main skill content");
    expect(body.skill_dir).toBe(SKILL_REL_PATH);
  });
});
