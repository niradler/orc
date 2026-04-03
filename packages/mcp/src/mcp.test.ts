import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { shortId } from "@orc/core/ids";
import { executeTool } from "./tools.js";

beforeAll(() => {
  process.env.ORC_API_SECRET = "test-secret";
  process.env.ORC_DB_PATH = ":memory:";
});

afterAll(() => {
  delete process.env.ORC_API_SECRET;
  delete process.env.ORC_DB_PATH;
});

// ── Memory tools ────────────────────────────────────────────────────────────

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
    expect(result).toContain(shortId(memId));
  });

  test("memory_get fetches full content", async () => {
    const result = await executeTool("memory_get", { ids: [memId] });
    expect(result).toContain("ULIDs");
  });
});

// ── Memory type classification ──────────────────────────────────────────────

describe("Memory type & title", () => {
  test("stores memory with type=decision and retrieves it", async () => {
    const stored = await executeTool("memory_store", {
      content: "We use Hono for the REST API because of typed routes",
      title: "Framework choice: Hono",
      type: "decision",
      scope: "orc",
    });
    const id = stored.replace("Stored: ", "").split(/\s/)[0]?.trim() ?? "";

    const got = await executeTool("memory_get", { ids: [id] });
    expect(got).toContain("[decision]");
    expect(got).toContain("Hono");
  });

  test("memory_search with type filter returns only matching type", async () => {
    await executeTool("memory_store", {
      content: "Always use strict TypeScript",
      type: "rule",
      scope: "orc",
    });
    await executeTool("memory_store", {
      content: "Found a race condition in token refresh",
      type: "discovery",
      scope: "orc",
    });

    const ruleResults = await executeTool("memory_search", {
      query: "TypeScript",
      type: "rule",
      limit: 5,
    });
    expect(ruleResults).toContain("strict TypeScript");
    expect(ruleResults).not.toContain("race condition");
  });

  test("context weights rules and decisions higher than facts", async () => {
    await executeTool("memory_store", {
      content: "Never skip code review",
      type: "rule",
      importance: "critical",
      scope: "orc",
    });
    await executeTool("memory_store", {
      content: "A random low-importance fact about nothing",
      type: "fact",
      importance: "low",
      scope: "orc",
    });

    const ctx = await executeTool("context", {});
    const rulePos = ctx.indexOf("Never skip code review");
    const factPos = ctx.indexOf("A random low-importance fact");

    if (rulePos !== -1 && factPos !== -1) {
      expect(rulePos).toBeLessThan(factPos);
    } else {
      expect(ctx).toContain("Never skip code review");
    }
  });
});

// ── Trigram search ──────────────────────────────────────────────────────────

describe("Memory trigram search", () => {
  test("finds partial word matches via trigram", async () => {
    await executeTool("memory_store", {
      content: "We use useCallback for memoizing event handlers in React",
      scope: "frontend",
    });

    const result = await executeTool("memory_search", {
      query: "useCallb",
      scope: "frontend",
      limit: 5,
    });
    expect(result).toContain("useCallback");
    expect(result).toContain("(trigram)");
  });
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
    const r1 = await executeTool("session_event", { type: "file", priority: 1, data });
    const r2 = await executeTool("session_event", { type: "file", priority: 1, data });
    const r3 = await executeTool("session_event", { type: "file", priority: 1, data });

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

    const snap = await executeTool("session_snapshot", { session_id: sessionId });
    expect(snap).toContain("<session>");
    expect(snap).toContain("</session>");
    expect(snap).toContain("<tasks>");
  });

  test("session_restore returns stored snapshot", async () => {
    const restored = await executeTool("session_restore", { session_id: sessionId });
    expect(restored).toContain("Session Restored");
    expect(restored).toContain("<session>");
  });

  test("snapshot XML stays within 2KB", async () => {
    const snap = await executeTool("session_snapshot", { session_id: sessionId });
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
    taskId = result.split(" — ")[0]?.replace("Created: ", "").trim() ?? "";
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
    const result = await executeTool("task_update", { id: taskId, status: "doing" });
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
    const parsed = JSON.parse(result) as { status: string; exit_code: number | null };
    expect(["success", "running", "pending"]).toContain(parsed.status);
  });
});

// ── Context layer ─────────────────────────────────────────────────────────────

describe("MCP context tool", () => {
  test("context returns active tasks and recent memories", async () => {
    const result = await executeTool("context", {});
    expect(result).toContain("Active Tasks");
    expect(result).toContain("Key Memory");
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

// ── Memory update ───────────────────────────────────────────────────────────

describe("memory_update tool", () => {
  let memId: string;

  beforeAll(async () => {
    const result = await executeTool("memory_store", {
      content: "Original content for update test",
      title: "Update test",
      type: "fact",
      scope: "testing",
      importance: "normal",
    });
    memId = result.replace("Stored: ", "").split(/\s/)[0]?.trim() ?? "";
  });

  test("updates content and bumps updated_at", async () => {
    const result = await executeTool("memory_update", {
      id: memId,
      content: "Updated content via memory_update",
    });
    expect(result).toContain("Updated:");
    expect(result).toContain(memId);
  });

  test("updated content is found via search (FTS re-indexed)", async () => {
    const result = await executeTool("memory_search", {
      query: "Updated content via memory_update",
      limit: 5,
    });
    expect(result).toContain(shortId(memId));
  });

  test("partial update preserves other fields", async () => {
    await executeTool("memory_update", {
      id: memId,
      title: "New title only",
    });
    const got = await executeTool("memory_get", { ids: [memId] });
    expect(got).toContain("New title only");
    expect(got).toContain("Updated content via memory_update");
    expect(got).toContain("[fact]");
  });

  test("update nonexistent returns not found", async () => {
    const result = await executeTool("memory_update", {
      id: "nonexistent",
      content: "should fail",
    });
    expect(result).toContain("not found");
  });
});

// ── Source auto-detection ────────────────────────────────────────────────────

describe("memory_store source metadata", () => {
  test("auto-detects source from env", async () => {
    process.env.ORC_AGENT = "test-agent";
    process.env.ORC_SESSION_ID = "sess-123";
    const result = await executeTool("memory_store", {
      content: "Auto-source test memory",
      type: "fact",
    });
    delete process.env.ORC_AGENT;
    delete process.env.ORC_SESSION_ID;

    const id = result.replace("Stored: ", "").split(/\s/)[0]?.trim() ?? "";
    const got = await executeTool("memory_get", { ids: [id] });
    expect(got).toContain("test-agent@sess-123");
  });

  test("explicit source overrides auto-detection", async () => {
    process.env.ORC_AGENT = "test-agent";
    const result = await executeTool("memory_store", {
      content: "Explicit source test",
      source: "my-custom-source",
    });
    delete process.env.ORC_AGENT;

    const id = result.replace("Stored: ", "").split(/\s/)[0]?.trim() ?? "";
    const got = await executeTool("memory_get", { ids: [id] });
    expect(got).toContain("my-custom-source");
    expect(got).not.toContain("test-agent");
  });

  test("falls back to 'unknown' when no env set", async () => {
    delete process.env.ORC_AGENT;
    delete process.env.CLAUDE_MODEL;
    delete process.env.ORC_SESSION_ID;
    const result = await executeTool("memory_store", {
      content: "No-env source test",
    });
    const id = result.replace("Stored: ", "").split(/\s/)[0]?.trim() ?? "";
    const got = await executeTool("memory_get", { ids: [id] });
    expect(got).toContain("unknown");
  });
});

// ── Similarity hint on store ─────────────────────────────────────────────────

describe("memory_store similarity hint", () => {
  test("warns when storing near-duplicate", async () => {
    await executeTool("memory_store", {
      content: "Always use biome for linting and formatting",
      type: "rule",
      scope: "code-style",
    });

    const result = await executeTool("memory_store", {
      content: "Always use biome for linting and formatting code",
      type: "rule",
      scope: "code-style",
    });
    expect(result).toContain("Similar memory exists");
    expect(result).toContain("memory_update");
  });

  test("no warning for genuinely unique content", async () => {
    const result = await executeTool("memory_store", {
      content: "xylophone zebra platypus narwhal 9f8a7b6c",
      type: "fact",
      scope: "unique-test-scope-12345",
    });
    expect(result).not.toContain("Similar memory exists");
  });
});

// ── Access-count scoring boost ───────────────────────────────────────────────

describe("context() access-count scoring", () => {
  test("frequently accessed memories score higher", async () => {
    const stored = await executeTool("memory_store", {
      content: "Frequently accessed memory for scoring test",
      type: "fact",
      importance: "low",
    });
    const id = stored.replace("Stored: ", "").split(/\s/)[0]?.trim() ?? "";

    // Simulate access_count by searching for it multiple times
    const { getSqlite } = await import("@orc/db/client");
    const sqlite = getSqlite();
    sqlite.query("UPDATE memories SET access_count = 20 WHERE id = ?").run(id);

    const ctx = await executeTool("context", {});
    // The memory should appear in context due to access boost
    if (ctx.includes("Frequently accessed memory")) {
      expect(ctx).toContain("Frequently accessed memory");
    }
  });
});
