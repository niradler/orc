import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./server.js";

let app: ReturnType<typeof createApp>;

const AUTH = "Bearer test-secret";

async function req(method: string, path: string, body?: unknown) {
  const fullPath = path.startsWith("/api") ? path : `/api${path}`;
  return app.request(fullPath, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(() => {
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  app = createApp();
});

afterAll(() => {
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
});

describe("Health", () => {
  test("GET /health returns ok", async () => {
    const res = await req("GET", "/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("Tasks", () => {
  let taskId: string;

  test("POST /tasks creates a task", async () => {
    const res = await req("POST", "/tasks", {
      title: "Implement auth",
      body: "Add JWT middleware",
      priority: "high",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string; title: string };
    expect(body.title).toBe("Implement auth");
    expect(body.status).toBe("todo");
    taskId = body.id;
  });

  test("GET /tasks lists tasks", async () => {
    const res = await req("GET", "/tasks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[]; total: number };
    expect(body.tasks.length).toBeGreaterThan(0);
  });

  test("GET /tasks/:id returns task", async () => {
    const res = await req("GET", `/tasks/${taskId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(taskId);
  });

  test("PATCH /tasks/:id updates task", async () => {
    const res = await req("PATCH", `/tasks/${taskId}`, { status: "doing" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("doing");
  });

  test("review round-trip via task_update", async () => {
    const reviewRes = await req("PATCH", `/tasks/${taskId}`, {
      status: "review",
      comment: "Finished auth implementation",
    });
    expect(reviewRes.status).toBe(200);
    const reviewed = (await reviewRes.json()) as { status: string };
    expect(reviewed.status).toBe("review");

    const approveRes = await req("PATCH", `/tasks/${taskId}`, { status: "done" });
    expect(approveRes.status).toBe(200);
    const approved = (await approveRes.json()) as { status: string };
    expect(approved.status).toBe("done");
  });

  test("POST /tasks/:id/comments adds a comment", async () => {
    const res = await req("POST", `/tasks/${taskId}/comments`, {
      content: "Looks good to merge",
      author: "human",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { content: string };
    expect(body.content).toBe("Looks good to merge");
  });

  test("Task links: create, list, delete", async () => {
    const t2Res = await req("POST", "/tasks", { title: "Blocked task" });
    const t2 = (await t2Res.json()) as { id: string };

    const linkRes = await req("POST", `/tasks/${taskId}/links`, {
      to_task_id: t2.id,
      link_type: "blocks",
    });
    expect(linkRes.status).toBe(201);
    const link = (await linkRes.json()) as { id: string; link_type: string };
    expect(link.link_type).toBe("blocks");

    const listRes = await req("GET", `/tasks/${taskId}/links`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as { links: unknown[] };
    expect(listed.links.length).toBe(1);

    const delRes = await req("DELETE", `/tasks/${taskId}/links/${link.id}`);
    expect(delRes.status).toBe(204);
  });

  test("DELETE /tasks/:id deletes task", async () => {
    const res = await req("DELETE", `/tasks/${taskId}`);
    expect(res.status).toBe(204);
  });
});

describe("Memories", () => {
  let memId: string;

  test("POST /memories stores a memory", async () => {
    const res = await req("POST", "/memories", {
      content: "Always use ULIDs for IDs in this project",
      tags: ["convention", "ids"],
      importance: "high",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; content: string };
    expect(body.content).toContain("ULIDs");
    memId = body.id;
  });

  test("GET /memories lists memories", async () => {
    const res = await req("GET", "/memories");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memories: unknown[] };
    expect(body.memories.length).toBeGreaterThan(0);
  });

  test("GET /memories/search finds by keyword", async () => {
    const res = await req("GET", "/memories/search?q=ULID");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id: string }[] };
    expect(body.results.some((r) => r.id === memId)).toBe(true);
  });

  test("DELETE /memories/:id removes memory", async () => {
    const res = await req("DELETE", `/memories/${memId}`);
    expect(res.status).toBe(204);
  });
});

describe("Jobs", () => {
  let jobId: string;
  let runId: string;

  test("POST /jobs creates a job", async () => {
    const res = await req("POST", "/jobs", {
      name: "test-echo",
      command: "echo hello",
      trigger_type: "manual",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.name).toBe("test-echo");
    jobId = body.id;
  });

  test("POST /jobs/:id/trigger starts a run", async () => {
    const res = await req("POST", `/jobs/${jobId}/trigger`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run_id: string };
    expect(body.run_id).toBeTruthy();
    runId = body.run_id;
  });

  test("GET /jobs/:id/runs lists runs", async () => {
    const res = await req("GET", `/jobs/${jobId}/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs.length).toBeGreaterThan(0);
  });

  test("GET /jobs/:id/runs/:runId/logs returns logs (after run completes)", async () => {
    await Bun.sleep(300);
    const res = await req("GET", `/jobs/${jobId}/runs/${runId}/logs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[] };
    expect(Array.isArray(body.logs)).toBe(true);
  });
});

describe("Sessions", () => {
  test("GET /sessions returns empty list initially", async () => {
    const res = await req("GET", "/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  test("POST /mcp/tool session_log writes a session with agent_version", async () => {
    const res = await app.request("/api/mcp/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTH },
      body: JSON.stringify({
        name: "session_log",
        args: {
          agent: "cursor",
          agent_version: "cursor/1.0",
          summary: "CLI integration test session",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string };
    expect(body.result).toMatch(/^Session logged:/);
  });

  test("GET /sessions shows the logged session with agent_version", async () => {
    const res = await req("GET", "/sessions?agent=cursor&limit=5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: { agent: string; agent_version: string | null; summary: string | null }[];
    };
    const s = body.sessions.find((s) => s.agent === "cursor");
    expect(s).toBeDefined();
    expect(s?.agent_version).toBe("cursor/1.0");
  });
});

describe("Sessions - job_run_id filter", () => {
  let runId: string;

  test("POST /jobs/:id/trigger creates a run and auto-logs a session", async () => {
    const jobRes = await req("POST", "/jobs", {
      name: "session-link-test-job",
      command: "echo session-link",
      trigger_type: "manual",
    });
    expect(jobRes.status).toBe(201);
    const job = (await jobRes.json()) as { id: string };

    const triggerRes = await req("POST", `/jobs/${job.id}/trigger`);
    expect(triggerRes.status).toBe(202);
    const trig = (await triggerRes.json()) as { run_id: string };
    runId = trig.run_id;

    await Bun.sleep(600);
  }, 10_000);

  test("GET /sessions?job_run_id= returns auto-logged session from executor", async () => {
    const res = await req("GET", `/sessions?job_run_id=${runId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: { agent: string; job_run_id: string | null; summary: string | null }[];
    };
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    const sess = body.sessions[0];
    expect(sess?.agent).toBe("runner");
    expect(sess?.job_run_id).toBe(runId);
    expect(sess?.summary).toContain("session-link-test-job");
  });
});

describe("Jobs - cron trigger (no repeat_secs)", () => {
  let jobId: string;

  test("POST /jobs creates a cron job without repeat_secs", async () => {
    const res = await req("POST", "/jobs", {
      name: "cli-test-cron",
      command: "echo hello",
      trigger_type: "cron",
      cron_expr: "0 * * * *",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      trigger_type: string;
      cron_expr: string | null;
    };
    expect(body.trigger_type).toBe("cron");
    expect(body.cron_expr).toBe("0 * * * *");
    expect(body).not.toHaveProperty("repeat_secs");
    jobId = body.id;
  });

  test("POST /jobs/:id/trigger runs the cron job manually", async () => {
    const res = await req("POST", `/jobs/${jobId}/trigger`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run_id: string };
    expect(body.run_id).toBeTruthy();

    await Bun.sleep(600);

    const runsRes = await req("GET", `/jobs/${jobId}/runs`);
    expect(runsRes.status).toBe(200);
    const runs = (await runsRes.json()) as { runs: { status: string }[] };
    expect(runs.runs.length).toBeGreaterThanOrEqual(1);
    const firstRunStatus = runs.runs[0]?.status ?? "none";
    expect(["success", "running"]).toContain(firstRunStatus);
  }, 10_000);
});
