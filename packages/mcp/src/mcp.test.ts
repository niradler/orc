import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executeTool } from "./tools.js";

beforeAll(() => {
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
});

afterAll(() => {
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
});

describe("MCP memory tools", () => {
  let memId: string;

  test("memory_store persists a fact", async () => {
    const result = await executeTool("memory_store", {
      content: "The project uses ULIDs for all primary keys",
      scope: "orc",
      tags: ["convention"],
      importance: "high",
    });
    expect(result).toMatch(/^Stored: /);
    memId = result.replace("Stored: ", "").split(/\s/)[0]?.trim() ?? "";
  });

  test("memory_search finds stored fact by keyword", async () => {
    const result = await executeTool("memory_search", { query: "ULID primary keys", limit: 5 });
    expect(result).toContain(memId.slice(-6));
  });

  test("memory_timeline returns context around a memory", async () => {
    const result = await executeTool("memory_timeline", { id: memId, window: 2 });
    expect(result).toContain("Timeline Context");
  });

  test("memory_get fetches full content", async () => {
    const result = await executeTool("memory_get", { ids: [memId] });
    expect(result).toContain("ULIDs");
  });
});

describe("MCP task tools", () => {
  let taskId: string;

  test("task_create creates a task", async () => {
    const result = await executeTool("task_create", {
      title: "Write MCP integration tests",
      body: "Cover memory, task, and job tools",
      priority: "high",
      author: "agent",
    });
    expect(result).toMatch(/^Created: /);
    taskId = result.split(" — ")[0]?.replace("Created: ", "").trim() ?? "";
  });

  test("task_list shows the new task", async () => {
    const result = await executeTool("task_list", { limit: 10 });
    expect(result).toContain(taskId.slice(-6));
  });

  test("task_get returns full task detail", async () => {
    const result = await executeTool("task_get", { ids: [taskId] });
    expect(result).toContain("Write MCP integration tests");
  });

  test("task_update changes status", async () => {
    const result = await executeTool("task_update", { id: taskId, status: "doing" });
    expect(result).toBe(`Updated: ${taskId}`);
  });

  test("task_submit_review sets status to review", async () => {
    const result = await executeTool("task_submit_review", {
      id: taskId,
      summary: "Tests written and passing",
    });
    expect(result).toContain("review");
  });

  test("task_check_review reflects review status", async () => {
    const result = await executeTool("task_check_review", { id: taskId });
    const parsed = JSON.parse(result) as { status: string };
    expect(parsed.status).toBe("review");
  });
});

describe("MCP job tools", () => {
  let runId: string;

  test("job_list returns a string result", async () => {
    const result = await executeTool("job_list", { limit: 10 });
    expect(typeof result).toBe("string");
  });

  test("job_run triggers and executes a job", async () => {
    const { getDb } = await import("@orc/db/client");
    const { jobs } = await import("@orc/db/schema");
    const { ulid } = await import("@orc/core/ids");
    const db = getDb();
    const jobId = ulid();
    const now = new Date();
    await db.insert(jobs).values({
      id: jobId,
      name: "mcp-test-job",
      command: "echo mcp-works",
      trigger_type: "manual",
      created_at: now,
      updated_at: now,
    });

    const result = await executeTool("job_run", { name: "mcp-test-job" });
    expect(result).toContain("mcp-test-job");
    expect(result).toContain("run_id");
    runId = result.split("run_id: ")[1]?.trim() ?? "";
  });

  test("job_status returns run status", async () => {
    await Bun.sleep(400);
    const result = await executeTool("job_status", { run_id: runId });
    const parsed = JSON.parse(result) as { status: string; exit_code: number | null };
    expect(["success", "running", "pending"]).toContain(parsed.status);
  });
});

describe("MCP context tool", () => {
  test("context_layer1 returns active tasks and recent memories", async () => {
    const result = await executeTool("context_layer1", {});
    expect(result).toContain("Active Tasks");
    expect(result).toContain("Key Memory");
  });
});

describe("MCP /mcp/tool HTTP endpoint", () => {
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

  beforeAll(async () => {
    const { createApp } = await import("@orc/api/server");
    app = createApp();
  });

  test("POST /mcp/tool executes memory_store via API", async () => {
    const res = await app.request("/mcp/tool", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({
        name: "memory_store",
        args: { content: "Hook test fact", importance: "low" },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string };
    expect(body.result).toMatch(/^Stored: /);
  });

  test("POST /mcp/tool returns 400 for unknown tool name", async () => {
    const res = await app.request("/mcp/tool", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({ name: "does_not_exist", args: {} }),
    });

    expect(res.status).toBe(400);
  });
});
