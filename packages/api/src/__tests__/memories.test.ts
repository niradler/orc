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

describe("Memories CRUD", () => {
  let memoryId: string;

  describe("POST /memories", () => {
    test("creates a memory with minimal fields", async () => {
      const res = await req(app, "POST", "/memories", {
        content: "Always use ULIDs for primary keys",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.content).toBe("Always use ULIDs for primary keys");
      expect(body.type).toBe("fact");
      expect(body.importance).toBe("normal");
      expect(body.id).toBeTruthy();
      memoryId = body.id;
    });

    test("creates a memory with all fields", async () => {
      const res = await req(app, "POST", "/memories", {
        content: "Use PostgreSQL for concurrent writes",
        title: "DB Choice",
        type: "decision",
        source: "arch-review",
        scope: "backend",
        tags: ["database", "architecture"],
        importance: "high",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.content).toBe("Use PostgreSQL for concurrent writes");
      expect(body.title).toBe("DB Choice");
      expect(body.type).toBe("decision");
      expect(body.source).toBe("arch-review");
      expect(body.scope).toBe("backend");
      expect(body.tags).toEqual(["database", "architecture"]);
      expect(body.importance).toBe("high");
    });

    test("creates a memory with project_id", async () => {
      const projRes = await req(app, "POST", "/projects", { name: "mem-proj" });
      const proj = await projRes.json();

      const res = await req(app, "POST", "/memories", {
        content: "Project-scoped memory",
        project_id: proj.id,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.project_id).toBe(proj.id);
    });

    test("creates memories of each type", async () => {
      const types = ["fact", "decision", "event", "rule", "discovery"] as const;
      for (const type of types) {
        const res = await req(app, "POST", "/memories", {
          content: `Memory of type ${type}`,
          type,
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.type).toBe(type);
      }
    });

    test("rejects empty content", async () => {
      const res = await req(app, "POST", "/memories", { content: "" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /memories", () => {
    test("lists all memories", async () => {
      const res = await req(app, "GET", "/memories");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.memories.length).toBeGreaterThanOrEqual(7);
    });

    test("filters by type", async () => {
      const res = await req(app, "GET", "/memories?type=decision");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.memories.length).toBeGreaterThanOrEqual(1);
      for (const m of body.memories) {
        expect(m.type).toBe("decision");
      }
    });

    test("filters by scope", async () => {
      const res = await req(app, "GET", "/memories?scope=backend");
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const m of body.memories) {
        expect(m.scope).toBe("backend");
      }
    });

    test("filters by project_id", async () => {
      const projRes = await req(app, "GET", "/projects");
      const projects = await projRes.json();
      const projId = projects.projects[0]?.id;
      if (!projId) return;

      const res = await req(app, "GET", `/memories?project_id=${projId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const m of body.memories) {
        expect(m.project_id).toBe(projId);
      }
    });

    test("respects limit", async () => {
      const res = await req(app, "GET", "/memories?limit=2");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.memories.length).toBeLessThanOrEqual(2);
    });
  });

  describe("GET /memories/search", () => {
    test("finds memories by keyword", async () => {
      const res = await req(app, "GET", "/memories/search?q=ULID");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.length).toBeGreaterThanOrEqual(1);
      expect(body.results.some((r: { id: string }) => r.id === memoryId)).toBe(true);
    });

    test("finds memories by multi-word query", async () => {
      const res = await req(app, "GET", "/memories/search?q=PostgreSQL concurrent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.length).toBeGreaterThanOrEqual(1);
    });

    test("returns empty for non-matching query", async () => {
      const res = await req(app, "GET", "/memories/search?q=xyznonexistent999");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.length).toBe(0);
    });

    test("filters search by scope", async () => {
      const res = await req(app, "GET", "/memories/search?q=PostgreSQL&scope=backend");
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const r of body.results) {
        expect(r.scope).toBe("backend");
      }
    });

    test("filters search by type", async () => {
      const res = await req(app, "GET", "/memories/search?q=PostgreSQL&type=decision");
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const r of body.results) {
        expect(r.type).toBe("decision");
      }
    });

    test("respects limit in search", async () => {
      const res = await req(app, "GET", "/memories/search?q=Memory&limit=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.length).toBeLessThanOrEqual(1);
    });
  });

  describe("DELETE /memories/:id", () => {
    test("deletes a memory", async () => {
      const createRes = await req(app, "POST", "/memories", { content: "To be deleted" });
      const created = await createRes.json();

      const res = await req(app, "DELETE", `/memories/${created.id}`);
      expect(res.status).toBe(204);
    });

    test("returns 404 for non-existent memory", async () => {
      const res = await req(app, "DELETE", "/memories/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });
});
