import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { shortId } from "@orc/core/ids";
import { closeDb, createTestDb } from "@orc/db/client";
import { toolListing } from "./server.js";
import { executeTool } from "./tools.js";

const originalActiveProject = process.env.ORC_ACTIVE_PROJECT;

beforeAll(() => {
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_ACTIVE_PROJECT = "";
  resetConfig();
  // Force an in-memory DB so tools never touch the real ~/.orc/orc.db.
  createTestDb();
});

afterAll(() => {
  if (originalActiveProject === undefined) delete process.env.ORC_ACTIVE_PROJECT;
  else process.env.ORC_ACTIVE_PROJECT = originalActiveProject;
  closeDb();
  resetConfig();
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
});

// ── Session event dedup & eviction ──────────────────────────────────────────

describe("Session event dedup", () => {
  beforeAll(() => {
    process.env.ORC_SESSION_ID = "test-dedup-session";
  });

  afterAll(() => {
    delete process.env.ORC_SESSION_ID;
  });

  test("duplicate events are silently dropped", async () => {
    const data = { path: "src/auth.ts", tool: "Write" };
    const r1 = await executeTool("session_event", {
      type: "file",
      priority: 1,
      data,
    });
    const r2 = await executeTool("session_event", {
      type: "file",
      priority: 1,
      data,
    });
    const r3 = await executeTool("session_event", {
      type: "file",
      priority: 1,
      data,
    });

    expect(r1).toContain("Event recorded");
    expect(r2).toBe("Duplicate event skipped.");
    expect(r3).toBe("Duplicate event skipped.");
  });

  test("different data on same type is NOT dropped", async () => {
    const r1 = await executeTool("session_event", {
      type: "file",
      priority: 1,
      data: { path: "src/a.ts", tool: "Write" },
    });
    const r2 = await executeTool("session_event", {
      type: "file",
      priority: 1,
      data: { path: "src/b.ts", tool: "Write" },
    });
    expect(r1).toContain("Event recorded");
    expect(r2).toContain("Event recorded");
  });
});

// ── Session snapshot & restore ───────────────────────────────────────────────

describe("Session snapshot round-trip", () => {
  const sessionId = "test-snapshot-session";

  beforeAll(() => {
    process.env.ORC_SESSION_ID = sessionId;
  });

  afterAll(() => {
    delete process.env.ORC_SESSION_ID;
  });

  test("session_snapshot builds valid XML", async () => {
    await executeTool("session_event", {
      type: "file",
      priority: 1,
      data: { path: "src/main.ts", tool: "Edit" },
    });
    await executeTool("session_event", {
      type: "decision",
      priority: 2,
      data: { content: "Use Bun instead of Node" },
    });

    const snap = await executeTool("session_snapshot", {
      session_id: sessionId,
    });
    expect(snap).toContain("<session>");
    expect(snap).toContain("</session>");
    expect(snap).toContain("<tasks>");
  });

  test("session_restore returns stored snapshot", async () => {
    const restored = await executeTool("session_restore", {
      session_id: sessionId,
    });
    expect(restored).toContain("Session Restored");
    expect(restored).toContain("<session>");
  });

  test("snapshot XML stays within 2KB", async () => {
    const snap = await executeTool("session_snapshot", {
      session_id: sessionId,
    });
    expect(Buffer.byteLength(snap, "utf-8")).toBeLessThanOrEqual(2048);
  });
});

// ── Task tools ────────────────────────────────────────────────────────────────

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
    taskId = result.split(" - ")[0]?.replace("Created: ", "").trim() ?? "";
  });

  test("task_list shows the new task", async () => {
    const result = await executeTool("task_list", { limit: 10 });
    expect(result).toContain(shortId(taskId));
  });

  test("task_get returns full task detail", async () => {
    const result = await executeTool("task_get", { ids: [taskId] });
    expect(result).toContain("Write MCP integration tests");
  });

  test("task_update changes status", async () => {
    const result = await executeTool("task_update", {
      id: taskId,
      status: "doing",
    });
    expect(result).toBe(`Updated: ${taskId}`);
  });

  test("task_update to review with comment", async () => {
    const result = await executeTool("task_update", {
      id: taskId,
      status: "review",
      comment: "Tests written and passing",
    });
    expect(result).toBe(`Updated: ${taskId}`);
  });
});

// ── Job tools ─────────────────────────────────────────────────────────────────

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
    const parsed = JSON.parse(result) as {
      status: string;
      exit_code: number | null;
    };
    expect(["success", "running", "pending"]).toContain(parsed.status);
  });
});

// ── Context layer ─────────────────────────────────────────────────────────────

describe("MCP context tool", () => {
  test("context returns active tasks and a memories section", async () => {
    const result = await executeTool("context", {});
    expect(result).toContain("Active Tasks");
    expect(result).toContain("## Memories");
  });
});

describe("MCP skill tools", () => {
  test("should count skill_read and list most-read skills first", async () => {
    await executeTool("skill_read", { name: "orc-platform", scope: "global" });
    await executeTool("skill_read", { name: "orc-platform", scope: "global", ref: "SKILL.md" });
    const listing = await executeTool("skill_list", { scope: "global", limit: 1 });
    expect(listing.split("\n")[0]).toContain("orc-platform");
    expect(listing).toContain("(2 reads)");
    expect(listing).toMatch(/Showing 1 of \d+; total=\d+, offset=0, limit=1, next_offset=1/);
  });

  test("should not count a read of a missing skill", async () => {
    expect(await executeTool("skill_read", { name: "missing-skill-xyz" })).toContain(
      "Skill not found",
    );
    const listing = await executeTool("skill_list", { q: "missing-skill-xyz" });
    // Diagnostics about installed skills follow the catalog and do not represent search hits.
    expect(listing.split("\n")[0]).toBe("No skills found.");
  });
});

// ── Session log ───────────────────────────────────────────────────────────────

describe("MCP session_log tool", () => {
  test("session_log with agent_version stores session", async () => {
    const result = await executeTool("session_log", {
      agent: "codex",
      agent_version: "codex/0.1",
      summary: "Implemented scheduler integration tests",
    });
    expect(result).toMatch(/^Session logged:/);
  });

  test("session_log picks up ORC_JOB_RUN_ID from env", async () => {
    const { getDb } = await import("@orc/db/client");
    const { job_runs, jobs } = await import("@orc/db/schema");
    const { ulid } = await import("@orc/core/ids");
    const db = getDb();
    const now = new Date();
    const jobId = ulid();
    const runId = ulid();

    await db.insert(jobs).values({
      id: jobId,
      name: "env-run-test-job",
      command: "echo ok",
      trigger_type: "manual",
      created_at: now,
      updated_at: now,
    });
    await db.insert(job_runs).values({
      id: runId,
      job_id: jobId,
      status: "success",
      created_at: now,
    });

    process.env.ORC_JOB_RUN_ID = runId;
    const result = await executeTool("session_log", {
      agent: "runner",
      summary: "Job env-run-test-job succeeded in 1s (exit 0)",
    });
    delete process.env.ORC_JOB_RUN_ID;
    expect(result).toMatch(/^Session logged:/);
  });
});

// ── HTTP endpoint ─────────────────────────────────────────────────────────────

describe("MCP /mcp/tool HTTP endpoint", () => {
  let app: {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  };

  beforeAll(async () => {
    const { createApp } = await import("@orc/api/server");
    app = createApp();
  });

  test("POST /mcp/tool executes memory_create via API", async () => {
    const { getDb } = await import("@orc/db/client");
    const { projects } = await import("@orc/db/schema");
    await getDb().insert(projects).values({ id: "mcp-http-project", name: "mcp-http-project" });
    const res = await app.request("/api/mcp/tool", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret",
      },
      body: JSON.stringify({
        name: "memory_create",
        args: {
          name: "hook-test-fact",
          description: "Hook test fact",
          content: "Hook test fact content",
          project: "mcp-http-project",
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string };
    expect(body.result).toBe("Created memory hook-test-fact");
  });

  test("POST /mcp/tool returns 400 for unknown tool name", async () => {
    const res = await app.request("/api/mcp/tool", {
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

// ── Advertised tool schemas ─────────────────────────────────────────────────

describe("MCP tool schemas", () => {
  const advertised = () =>
    toolListing().map((t) => ({
      name: t.name,
      schema: t.inputSchema as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      },
    }));

  test("every tool advertises an object schema", () => {
    for (const { name, schema } of advertised()) {
      expect(`${name}:${schema.type}`).toBe(`${name}:object`);
    }
  });

  test("every tool that takes arguments advertises them", () => {
    const argless = new Set(["project_list", "agent_list", "agent_package_list"]);
    for (const { name, schema } of advertised()) {
      if (argless.has(name)) continue;
      const props = Object.keys(schema.properties ?? {});
      expect(`${name}:${props.length > 0}`).toBe(`${name}:true`);
    }
  });

  test("task_update advertises id as required and status as an enum", () => {
    const schema = advertised().find((t) => t.name === "task_update")?.schema;
    expect(schema?.required).toEqual(["id"]);
    expect((schema?.properties?.status as { enum?: string[] })?.enum).toContain("review");
  });

  test("defaulted fields are optional on the input schema", () => {
    const schema = advertised().find((t) => t.name === "task_list")?.schema;
    expect(schema?.properties).toHaveProperty("limit");
    expect(schema?.required ?? []).not.toContain("limit");
  });
});
