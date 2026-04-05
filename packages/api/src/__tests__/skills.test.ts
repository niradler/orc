import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getUserSkillsDir, reloadCache } from "@orc/core/skill-service";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = setupTestApp();
  reloadCache();
});

afterAll(() => {
  teardownTestApp();
});

// ─── GET /skills ─────────────────────────────────────────────────────────────

describe("GET /skills", () => {
  test("lists built-in skills", async () => {
    const res = await req(app, "GET", "/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: { name: string; source: string }[] };
    expect(body.skills.length).toBeGreaterThan(0);
    const names = body.skills.map((s) => s.name);
    expect(names).toContain("orc-coder");
    expect(names).toContain("orc-worker-base");
  });

  test("filters by source=builtin", async () => {
    const res = await req(app, "GET", "/skills?source=builtin");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: { source: string }[] };
    expect(body.skills.every((s) => s.source === "builtin")).toBe(true);
  });

  test("keyword search with q param", async () => {
    const res = await req(app, "GET", "/skills?q=coder");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: { name: string }[] };
    expect(body.skills.some((s) => s.name.includes("coder"))).toBe(true);
  });

  test("returns empty for no match", async () => {
    const res = await req(app, "GET", "/skills?q=xyznonexistent123");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: unknown[] };
    expect(body.skills).toEqual([]);
  });

  test("reload=true forces cache rebuild", async () => {
    const res = await req(app, "GET", "/skills?reload=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: unknown[] };
    expect(body.skills.length).toBeGreaterThan(0);
  });
});

// ─── GET /skills/:name ──────────────────────────────────────────────────────

describe("GET /skills/:name", () => {
  test("reads a built-in skill", async () => {
    const res = await req(app, "GET", "/skills/orc-coder");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; content: string; references: unknown[] };
    expect(body.name).toBe("orc-coder");
    expect(body.content).toContain("Coder");
    expect(Array.isArray(body.references)).toBe(true);
  });

  test("returns 404 for nonexistent skill", async () => {
    const res = await req(app, "GET", "/skills/nonexistent-xyz");
    expect(res.status).toBe(404);
  });

  test("content excludes frontmatter", async () => {
    const res = await req(app, "GET", "/skills/orc-coder");
    const body = (await res.json()) as { content: string };
    expect(body.content).not.toContain("---");
    expect(body.content).not.toContain("name: orc-coder");
  });
});

// ─── POST /skills ────────────────────────────────────────────────────────────

describe("POST /skills", () => {
  const TEST_NAME = "__test-api-create__";
  const skillDir = join(getUserSkillsDir(), TEST_NAME);

  afterAll(() => {
    rmSync(skillDir, { recursive: true, force: true });
    reloadCache();
  });

  test("creates a new user skill", async () => {
    const content = `---
name: ${TEST_NAME}
description: Created via API test
---

API test body.`;

    const res = await req(app, "POST", "/skills", { name: TEST_NAME, content });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; source: string; content: string };
    expect(body.name).toBe(TEST_NAME);
    expect(body.source).toBe("user");
    expect(body.content).toBe("API test body.");
  });

  test("created skill appears in list", async () => {
    const res = await req(app, "GET", "/skills?reload=true");
    const body = (await res.json()) as { skills: { name: string }[] };
    expect(body.skills.some((s) => s.name === TEST_NAME)).toBe(true);
  });

  test("rejects duplicate name", async () => {
    const res = await req(app, "POST", "/skills", {
      name: TEST_NAME,
      content: `---\nname: ${TEST_NAME}\n---\ndup`,
    });
    expect(res.status).toBe(409);
  });

  test("rejects empty name", async () => {
    const res = await req(app, "POST", "/skills", { name: "", content: "---\nname: x\n---\nbody" });
    expect(res.status).toBe(400);
  });

  test("rejects empty content", async () => {
    const res = await req(app, "POST", "/skills", { name: "foo", content: "" });
    expect(res.status).toBe(400);
  });
});
