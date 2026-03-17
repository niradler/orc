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

describe("Tasks CRUD", () => {
  let taskId: string;

  describe("POST /tasks", () => {
    test("creates a task with minimal fields", async () => {
      const res = await req(app, "POST", "/tasks", { title: "Test task" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe("Test task");
      expect(body.status).toBe("todo");
      expect(body.priority).toBe("normal");
      expect(body.author).toBe("human");
      expect(body.id).toBeTruthy();
      taskId = body.id;
    });

    test("creates a task with all fields", async () => {
      const res = await req(app, "POST", "/tasks", {
        title: "Full task",
        body: "Detailed description",
        status: "doing",
        priority: "high",
        tags: ["backend", "api"],
        author: "agent",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.title).toBe("Full task");
      expect(body.body).toBe("Detailed description");
      expect(body.status).toBe("doing");
      expect(body.priority).toBe("high");
      expect(body.tags).toEqual(["backend", "api"]);
      expect(body.author).toBe("agent");
    });

    test("creates a task with a project_id", async () => {
      const projRes = await req(app, "POST", "/projects", { name: "task-proj" });
      const proj = await projRes.json();

      const res = await req(app, "POST", "/tasks", {
        title: "Scoped task",
        project_id: proj.id,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.project_id).toBe(proj.id);
    });

    test("rejects empty title", async () => {
      const res = await req(app, "POST", "/tasks", { title: "" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /tasks", () => {
    test("lists all tasks", async () => {
      const res = await req(app, "GET", "/tasks");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks.length).toBeGreaterThanOrEqual(3);
      expect(body.total).toBe(body.tasks.length);
    });

    test("filters by status", async () => {
      const res = await req(app, "GET", "/tasks?status=doing");
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const t of body.tasks) {
        expect(t.status).toBe("doing");
      }
    });

    test("filters by project_id", async () => {
      const projRes = await req(app, "GET", "/projects");
      const projects = await projRes.json();
      const projId = projects.projects[0]?.id;
      if (!projId) return;

      const res = await req(app, "GET", `/tasks?project_id=${projId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const t of body.tasks) {
        expect(t.project_id).toBe(projId);
      }
    });

    test("respects limit parameter", async () => {
      const res = await req(app, "GET", "/tasks?limit=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks.length).toBeLessThanOrEqual(1);
    });
  });

  describe("GET /tasks/:id", () => {
    test("returns a task by ID", async () => {
      const res = await req(app, "GET", `/tasks/${taskId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(taskId);
      expect(body.title).toBe("Test task");
    });

    test("returns 404 for non-existent task", async () => {
      const res = await req(app, "GET", "/tasks/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /tasks/:id", () => {
    test("updates title", async () => {
      const res = await req(app, "PATCH", `/tasks/${taskId}`, { title: "Updated title" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.title).toBe("Updated title");
    });

    test("updates status", async () => {
      const res = await req(app, "PATCH", `/tasks/${taskId}`, { status: "doing" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("doing");
    });

    test("updates priority", async () => {
      const res = await req(app, "PATCH", `/tasks/${taskId}`, { priority: "critical" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.priority).toBe("critical");
    });

    test("updates body", async () => {
      const res = await req(app, "PATCH", `/tasks/${taskId}`, { body: "New body content" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.body).toBe("New body content");
    });

    test("updates tags", async () => {
      const res = await req(app, "PATCH", `/tasks/${taskId}`, { tags: ["new-tag"] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tags).toEqual(["new-tag"]);
    });

    test("returns 404 for non-existent task", async () => {
      const res = await req(app, "PATCH", "/tasks/nonexistent-id", { title: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /tasks/:id/notes", () => {
    test("adds a note to a task", async () => {
      const res = await req(app, "POST", `/tasks/${taskId}/notes`, {
        content: "This is a note",
        author: "human",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.content).toBe("This is a note");
      expect(body.author).toBe("human");
      expect(body.task_id).toBe(taskId);
    });

    test("adds a note with default author", async () => {
      const res = await req(app, "POST", `/tasks/${taskId}/notes`, {
        content: "Default author note",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.author).toBe("human");
    });

    test("returns 404 for non-existent task", async () => {
      const res = await req(app, "POST", "/tasks/nonexistent-id/notes", {
        content: "nope",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /tasks/:id/notes", () => {
    test("lists notes for a task", async () => {
      const res = await req(app, "GET", `/tasks/${taskId}/notes`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.notes.length).toBeGreaterThanOrEqual(2);
      for (const n of body.notes) {
        expect(n.task_id).toBe(taskId);
      }
    });
  });

  describe("HITL Review", () => {
    test("submit and check review", async () => {
      const submitRes = await req(app, "POST", `/tasks/${taskId}/review`, {
        summary: "Ready for review",
      });
      expect(submitRes.status).toBe(200);
      const submitted = await submitRes.json();
      expect(submitted.status).toBe("review");

      const checkRes = await req(app, "GET", `/tasks/${taskId}/review`);
      expect(checkRes.status).toBe(200);
      const checked = await checkRes.json();
      expect(checked.status).toBe("review");
    });

    test("rejects review for task not in doing/blocked", async () => {
      const newRes = await req(app, "POST", "/tasks", { title: "Todo task" });
      const newTask = await newRes.json();

      const res = await req(app, "POST", `/tasks/${newTask.id}/review`, {
        summary: "Trying review from todo",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("Task Links", () => {
    let linkTaskId: string;

    test("create and list links", async () => {
      const t2Res = await req(app, "POST", "/tasks", { title: "Link target" });
      const t2 = await t2Res.json();
      linkTaskId = t2.id;

      const linkRes = await req(app, "POST", `/tasks/${taskId}/links`, {
        to_task_id: linkTaskId,
        link_type: "blocks",
      });
      expect(linkRes.status).toBe(201);
      const link = await linkRes.json();
      expect(link.link_type).toBe("blocks");

      const listRes = await req(app, "GET", `/tasks/${taskId}/links`);
      expect(listRes.status).toBe(200);
      const listed = await listRes.json();
      expect(listed.links.length).toBeGreaterThanOrEqual(1);
    });

    test("delete a link", async () => {
      const listRes = await req(app, "GET", `/tasks/${taskId}/links`);
      const listed = await listRes.json();
      const linkId = listed.links[0]?.id;
      if (!linkId) return;

      const delRes = await req(app, "DELETE", `/tasks/${taskId}/links/${linkId}`);
      expect(delRes.status).toBe(204);
    });
  });

  describe("DELETE /tasks/:id", () => {
    test("deletes a task", async () => {
      const res = await req(app, "DELETE", `/tasks/${taskId}`);
      expect(res.status).toBe(204);

      const getRes = await req(app, "GET", `/tasks/${taskId}`);
      expect(getRes.status).toBe(404);
    });

    test("returns 404 for non-existent task", async () => {
      const res = await req(app, "DELETE", "/tasks/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });
});
