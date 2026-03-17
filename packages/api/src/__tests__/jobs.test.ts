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

describe("Jobs CRUD", () => {
  let jobId: string;

  describe("POST /jobs", () => {
    test("creates a job with minimal fields", async () => {
      const res = await req(app, "POST", "/jobs", {
        name: "test-job",
        command: "echo hello",
        trigger_type: "manual",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("test-job");
      expect(body.command).toBe("echo hello");
      expect(body.trigger_type).toBe("manual");
      expect(body.enabled).toBe(true);
      expect(body.timeout_secs).toBe(300);
      expect(body.max_retries).toBe(0);
      expect(body.overlap).toBe("skip");
      expect(body.notify_on).toBe("failure");
      jobId = body.id;
    });

    test("creates a job with all fields", async () => {
      const res = await req(app, "POST", "/jobs", {
        name: "full-job",
        description: "A full job",
        command: "bun run build",
        trigger_type: "cron",
        cron_expr: "0 * * * *",
        timeout_secs: 600,
        max_retries: 3,
        overlap: "queue",
        notify_on: "always",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("full-job");
      expect(body.description).toBe("A full job");
      expect(body.trigger_type).toBe("cron");
      expect(body.cron_expr).toBe("0 * * * *");
      expect(body.timeout_secs).toBe(600);
      expect(body.max_retries).toBe(3);
      expect(body.overlap).toBe("queue");
      expect(body.notify_on).toBe("always");
    });

    test("creates a job with project_id", async () => {
      const projRes = await req(app, "POST", "/projects", { name: "job-proj" });
      const proj = await projRes.json();

      const res = await req(app, "POST", "/jobs", {
        name: "proj-job",
        command: "echo scoped",
        trigger_type: "manual",
        project_id: proj.id,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.project_id).toBe(proj.id);
    });

    test("rejects empty name", async () => {
      const res = await req(app, "POST", "/jobs", {
        name: "",
        command: "echo fail",
        trigger_type: "manual",
      });
      expect(res.status).toBe(400);
    });

    test("rejects empty command", async () => {
      const res = await req(app, "POST", "/jobs", {
        name: "no-cmd",
        command: "",
        trigger_type: "manual",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /jobs", () => {
    test("lists all jobs", async () => {
      const res = await req(app, "GET", "/jobs");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs.length).toBeGreaterThanOrEqual(3);
    });

    test("filters by project_id", async () => {
      const projRes = await req(app, "GET", "/projects");
      const projects = await projRes.json();
      const projId = projects.projects[0]?.id;
      if (!projId) return;

      const res = await req(app, "GET", `/jobs?project_id=${projId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const j of body.jobs) {
        expect(j.project_id).toBe(projId);
      }
    });

    test("respects limit", async () => {
      const res = await req(app, "GET", "/jobs?limit=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs.length).toBeLessThanOrEqual(1);
    });
  });

  describe("GET /jobs/:id", () => {
    test("returns a job by ID", async () => {
      const res = await req(app, "GET", `/jobs/${jobId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(jobId);
      expect(body.name).toBe("test-job");
    });

    test("returns 404 for non-existent job", async () => {
      const res = await req(app, "GET", "/jobs/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /jobs/:id", () => {
    test("updates name", async () => {
      const res = await req(app, "PATCH", `/jobs/${jobId}`, { name: "renamed-job" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("renamed-job");
    });

    test("updates command", async () => {
      const res = await req(app, "PATCH", `/jobs/${jobId}`, { command: "echo updated" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.command).toBe("echo updated");
    });

    test("updates enabled flag", async () => {
      const res = await req(app, "PATCH", `/jobs/${jobId}`, { enabled: false });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe(false);
    });

    test("updates timeout and retries", async () => {
      const res = await req(app, "PATCH", `/jobs/${jobId}`, {
        timeout_secs: 120,
        max_retries: 5,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.timeout_secs).toBe(120);
      expect(body.max_retries).toBe(5);
    });

    test("updates description", async () => {
      const res = await req(app, "PATCH", `/jobs/${jobId}`, { description: "New desc" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.description).toBe("New desc");
    });

    test("returns 404 for non-existent job", async () => {
      const res = await req(app, "PATCH", "/jobs/nonexistent-id", { name: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /jobs/:id/trigger", () => {
    test("triggers a job and returns run_id", async () => {
      const res = await req(app, "POST", `/jobs/${jobId}/trigger`);
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.run_id).toBeTruthy();
    });

    test("returns 404 for non-existent job", async () => {
      const res = await req(app, "POST", "/jobs/nonexistent-id/trigger");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /jobs/:id/runs", () => {
    test("lists runs for a job", async () => {
      const res = await req(app, "GET", `/jobs/${jobId}/runs`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runs.length).toBeGreaterThanOrEqual(1);
      for (const run of body.runs) {
        expect(run.job_id).toBe(jobId);
      }
    });
  });

  describe("DELETE /jobs/:id", () => {
    test("deletes a job", async () => {
      const createRes = await req(app, "POST", "/jobs", {
        name: "to-delete-job",
        command: "echo bye",
        trigger_type: "manual",
      });
      const created = await createRes.json();

      const res = await req(app, "DELETE", `/jobs/${created.id}`);
      expect(res.status).toBe(204);

      const getRes = await req(app, "GET", `/jobs/${created.id}`);
      expect(getRes.status).toBe(404);
    });

    test("returns 404 for non-existent job", async () => {
      const res = await req(app, "DELETE", "/jobs/nonexistent-id");
      expect(res.status).toBe(404);
    });
  });
});
