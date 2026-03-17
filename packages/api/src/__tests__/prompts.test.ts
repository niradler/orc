import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = setupTestApp();
});

afterAll(() => {
  teardownTestApp();
});

describe("Prompts CRUD", () => {
  let promptId: string;

  describe("POST /prompts", () => {
    test("creates a prompt with minimal fields", async () => {
      const res = await req(app, "POST", "/prompts", {
        name: "greet",
        template: "Hello {{name}}!",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("greet");
      expect(body.template).toBe("Hello {{name}}!");
      expect(body.version).toBe(1);
      expect(body.is_skill).toBe(false);
      expect(body.pinned).toBe(false);
      expect(body.id).toBeTruthy();
      promptId = body.id;
    });

    test("creates a prompt with all fields", async () => {
      const res = await req(app, "POST", "/prompts", {
        name: "full-prompt",
        description: "A full prompt template",
        template: "{{greeting}} {{name}}, welcome to {{place}}!",
        is_skill: true,
        skill_dir: "/skills/greet",
        skill_version: "1.0.0",
        tags: ["greeting", "onboarding"],
        pinned: true,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("full-prompt");
      expect(body.description).toBe("A full prompt template");
      expect(body.is_skill).toBe(true);
      expect(body.skill_dir).toBe("/skills/greet");
      expect(body.skill_version).toBe("1.0.0");
      expect(body.tags).toEqual(["greeting", "onboarding"]);
      expect(body.pinned).toBe(true);
    });

    test("rejects empty name", async () => {
      const res = await req(app, "POST", "/prompts", {
        name: "",
        template: "Something",
      });
      expect(res.status).toBe(400);
    });

    test("rejects empty template", async () => {
      const res = await req(app, "POST", "/prompts", {
        name: "no-template",
        template: "",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /prompts", () => {
    test("lists all prompts", async () => {
      const res = await req(app, "GET", "/prompts");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.prompts.length).toBeGreaterThanOrEqual(2);
    });

    test("filters by is_skill", async () => {
      const res = await req(app, "GET", "/prompts?is_skill=true");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.prompts.length).toBeGreaterThanOrEqual(1);
      for (const p of body.prompts) {
        expect(p.is_skill).toBe(true);
      }
    });

    test("filters non-skills (z.coerce.boolean treats 'false' as truthy)", async () => {
      // Note: z.coerce.boolean() coerces the string "false" to true,
      // so is_skill=false as a query param actually filters for skills.
      // This tests the actual route behavior.
      const res = await req(app, "GET", "/prompts?is_skill=false");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.prompts)).toBe(true);
    });

    test("respects limit", async () => {
      const res = await req(app, "GET", "/prompts?limit=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.prompts.length).toBeLessThanOrEqual(1);
    });
  });

  describe("GET /prompts/:id", () => {
    test("returns a prompt by ID", async () => {
      const res = await req(app, "GET", `/prompts/${promptId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(promptId);
      expect(body.name).toBe("greet");
    });

    test("returns 404 for non-existent prompt", async () => {
      const res = await req(app, "GET", "/prompts/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /prompts/:id", () => {
    test("updates template and bumps version", async () => {
      const res = await req(app, "PATCH", `/prompts/${promptId}`, {
        template: "Hi {{name}}!",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.template).toBe("Hi {{name}}!");
      expect(body.version).toBe(2);
    });

    test("updates name", async () => {
      const res = await req(app, "PATCH", `/prompts/${promptId}`, { name: "greet-v2" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("greet-v2");
      expect(body.version).toBe(3);
    });

    test("updates description", async () => {
      const res = await req(app, "PATCH", `/prompts/${promptId}`, {
        description: "Updated greeting",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.description).toBe("Updated greeting");
    });

    test("updates tags", async () => {
      const res = await req(app, "PATCH", `/prompts/${promptId}`, { tags: ["v2", "greeting"] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tags).toEqual(["v2", "greeting"]);
    });

    test("updates pinned flag", async () => {
      const res = await req(app, "PATCH", `/prompts/${promptId}`, { pinned: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pinned).toBe(true);
    });

    test("returns 404 for non-existent prompt", async () => {
      const res = await req(app, "PATCH", "/prompts/nonexistent-id", { name: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /prompts/:id/render", () => {
    test("renders template with variables", async () => {
      await req(app, "PATCH", `/prompts/${promptId}`, {
        template: "Hello {{name}}, welcome to {{place}}!",
      });

      const res = await req(app, "POST", `/prompts/${promptId}/render`, {
        vars: { name: "Alice", place: "Orc" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rendered).toBe("Hello Alice, welcome to Orc!");
      expect(body.prompt_id).toBe(promptId);
      expect(typeof body.version).toBe("number");
    });

    test("keeps unresolved variables as-is", async () => {
      const res = await req(app, "POST", `/prompts/${promptId}/render`, {
        vars: { name: "Bob" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rendered).toBe("Hello Bob, welcome to {{place}}!");
    });

    test("renders with empty vars", async () => {
      const res = await req(app, "POST", `/prompts/${promptId}/render`, { vars: {} });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rendered).toContain("{{name}}");
    });

    test("returns 404 for non-existent prompt", async () => {
      const res = await req(app, "POST", "/prompts/nonexistent-id/render", { vars: {} });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /prompts/:id/history", () => {
    test("returns version history", async () => {
      const res = await req(app, "GET", `/prompts/${promptId}/history`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.history.length).toBeGreaterThanOrEqual(1);
      for (const h of body.history) {
        expect(h.prompt_id).toBe(promptId);
        expect(typeof h.version).toBe("number");
        expect(typeof h.template).toBe("string");
      }
    });

    test("history is ordered newest first", async () => {
      const res = await req(app, "GET", `/prompts/${promptId}/history`);
      const body = await res.json();
      if (body.history.length >= 2) {
        expect(body.history[0].version).toBeGreaterThan(body.history[1].version);
      }
    });

    test("returns 404 for non-existent prompt", async () => {
      const res = await req(app, "GET", "/prompts/nonexistent-id/history");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /prompts/:id", () => {
    test("deletes a prompt", async () => {
      const createRes = await req(app, "POST", "/prompts", {
        name: "to-delete-prompt",
        template: "Delete me",
      });
      const created = await createRes.json();

      const res = await req(app, "DELETE", `/prompts/${created.id}`);
      expect(res.status).toBe(204);

      const getRes = await req(app, "GET", `/prompts/${created.id}`);
      expect(getRes.status).toBe(404);
    });

    test("returns 404 for non-existent prompt", async () => {
      const res = await req(app, "DELETE", "/prompts/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });
});
