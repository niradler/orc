import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig, resetConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { getDb } from "@orc/db/client";
import { comments, gateway_sessions, tasks } from "@orc/db/schema";
import { executeTool } from "@orc/mcp/tools";
import { updateTaskStatus } from "@orc/task-service";
import { eq } from "drizzle-orm";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

function getSqlite(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  app = setupTestApp();
  await Bun.sleep(200);
});

afterAll(() => {
  teardownTestApp();
});

// ─── Shared state across the story ───────────────────────────────────────────

let projectId: string;
const coderSkillName = "orc-coder";
let parentId: string;
let t1Id: string;
let t2Id: string;
let t3Id: string;
let t4Id: string;

// ─── 1. Project Setup (Human creates project) ───────────────────────────────

describe("1. Project Setup", () => {
  test("human creates stretch-reminder project via API", async () => {
    const res = await req(app, "POST", "/projects", {
      name: "stretch-reminder",
      description: "Desktop app that reminds you to stretch every 25 minutes",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; max_workers: number | null };
    expect(body.name).toBe("stretch-reminder");
    expect(body.max_workers).toBeNull();
    projectId = body.id;
  });

  test("human sets per-project concurrency limit", async () => {
    const res = await req(app, "PATCH", `/projects/${projectId}`, { max_workers: 2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { max_workers: number };
    expect(body.max_workers).toBe(2);
  });

  test("agent sees project via MCP project_list", async () => {
    const result = await executeTool("project_list", {});
    expect(result).toContain("stretch-reminder");
  });
});

// ─── 2. Skill Discovery (Agent explores available workflows) ────────────────

describe("2. Skill Discovery", () => {
  test("agent lists all built-in skills", async () => {
    const result = await executeTool("skill_list", {});
    expect(result).toContain("orc-worker-base");
    expect(result).toContain("orc-coder");
    expect(result).toContain("orc-planner");
    expect(result).toContain("orc-reviewer");
    expect(result).toContain("orc-bugfix");
    expect(result).toContain("orc-report");
    expect(result).toContain("orc-main-base");
    expect(result).toContain("orc-requirements");
  });

  test("agent filters skills by workflow tag", async () => {
    const result = await executeTool("skill_list", { tags: ["workflow"] });
    expect(result).toContain("orc-coder");
    expect(result).toContain("orc-planner");
    expect(result).toContain("orc-reviewer");
    expect(result).toContain("orc-bugfix");
    expect(result).not.toContain("orc-worker-base");
  });

  test("agent loads full orc-coder skill content", async () => {
    const result = await executeTool("skill_read", { name: "orc-coder" });
    expect(result).toContain("# orc-coder");
    expect(result).toContain("# Coder");
    expect(result).toContain("Run the full test suite");
  });
});

// ─── 3. Planning Phase (Agent creates batch of subtasks) ─────────────────────

describe("3. Planning Phase — Batch Task Creation", () => {
  test("agent creates parent + subtasks with dependencies", async () => {
    const result = await executeTool("task_batch_create", {
      project: "stretch-reminder",
      tasks: [
        {
          ref: "P",
          title: "Build stretch reminder app",
          body: "Full desktop stretch reminder with timer, notifications, and stats",
          priority: "high",
        },
        {
          ref: "T1",
          title: "Design REST API schema",
          body: "Define endpoints for timer CRUD, notification prefs, and stats",
          priority: "high",
          subtask_of: "P",
          skill_name: coderSkillName,
          agent_backend: "claude",
        },
        {
          ref: "T2",
          title: "Implement timer service",
          body: "Core timer logic with configurable intervals",
          priority: "normal",
          subtask_of: "P",
          depends_on: ["T1"],
          required_review: true,
          max_review_rounds: 2,
        },
        {
          ref: "T3",
          title: "Add desktop notifications",
          body: "System tray notifications when break time starts",
          priority: "normal",
          subtask_of: "P",
          depends_on: ["T2"],
          tags: ["agent"],
        },
        {
          ref: "T4",
          title: "Write integration tests",
          body: "E2E tests for timer + notification flow",
          priority: "low",
          subtask_of: "P",
          depends_on: ["T2", "T3"],
        },
      ],
    });
    expect(result).toContain("Created 5 tasks");

    const lines = result.split("\n").filter((l) => l.includes("→"));
    for (const line of lines) {
      const match = line.match(/(\w+)\s*→\s*(\S+)/);
      if (!match) continue;
      const [, ref, id] = match;
      if (ref === "P") parentId = id as string;
      else if (ref === "T1") t1Id = id as string;
      else if (ref === "T2") t2Id = id as string;
      else if (ref === "T3") t3Id = id as string;
      else if (ref === "T4") t4Id = id as string;
    }
    expect(parentId).toBeTruthy();
    expect(t1Id).toBeTruthy();
    expect(t2Id).toBeTruthy();
    expect(t3Id).toBeTruthy();
    expect(t4Id).toBeTruthy();
  });

  test("task links created correctly (subtask_of + blocks)", async () => {
    const linksRes = await req(app, "GET", `/tasks/${t1Id}/links`);
    expect(linksRes.status).toBe(200);
    const links = (await linksRes.json()) as {
      links: { link_type: string; from_task_id: string; to_task_id: string }[];
    };
    const subtaskLink = links.links.find((l) => l.link_type === "subtask_of");
    expect(subtaskLink).toBeTruthy();
    expect(subtaskLink?.to_task_id).toBe(parentId);

    const t2LinksRes = await req(app, "GET", `/tasks/${t2Id}/links`);
    const t2Links = (await t2LinksRes.json()) as {
      links: { link_type: string; from_task_id: string; to_task_id: string }[];
    };
    const blocksLink = t2Links.links.find(
      (l) => l.link_type === "blocks" && l.from_task_id === t1Id,
    );
    expect(blocksLink).toBeTruthy();
  });

  test("new task fields stored correctly", async () => {
    const res = await req(app, "GET", `/tasks/${t1Id}`);
    const task = (await res.json()) as {
      skill_name: string;
      agent_backend: string;
      required_review: boolean;
    };
    expect(task.skill_name).toBe(coderSkillName);
    expect(task.agent_backend).toBe("claude");
    expect(task.required_review).toBe(true);

    const res2 = await req(app, "GET", `/tasks/${t2Id}`);
    const task2 = (await res2.json()) as { max_review_rounds: number; required_review: boolean };
    expect(task2.max_review_rounds).toBe(2);
    expect(task2.required_review).toBe(true);
  });

  test("all tasks visible via MCP task_list", async () => {
    const result = await executeTool("task_list", { project: "stretch-reminder" });
    expect(result).toContain("Build stretch reminder app");
    expect(result).toContain("Design REST API schema");
    expect(result).toContain("Implement timer service");
    expect(result).toContain("Add desktop notifications");
    expect(result).toContain("Write integration tests");
  });
});

// ─── 4. Execution — Happy Path T1 (agent works, human reviews) ──────────────

describe("4. Execution — Happy Path (T1: Design API)", () => {
  test("agent starts working on T1", async () => {
    const result = await executeTool("task_update", {
      id: t1Id,
      status: "doing",
      comment: "Starting REST API design",
    });
    expect(result).toBe(`Updated: ${t1Id}`);
  });

  test("agent submits T1 for review", async () => {
    const result = await executeTool("task_update", {
      id: t1Id,
      status: "review",
      comment: "API schema: 5 endpoints for timer, prefs, stats",
    });
    expect(result).toBe(`Updated: ${t1Id}`);
  });

  test("human approves T1", async () => {
    const res = await req(app, "PATCH", `/tasks/${t1Id}`, {
      status: "done",
      comment: "LGTM, clean REST design",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("done");
  });

  test("T1 comments recorded from both sides", async () => {
    const res = await req(app, "GET", `/tasks/${t1Id}/comments`);
    const body = (await res.json()) as { comments: { content: string; author: string }[] };
    expect(body.comments.length).toBeGreaterThanOrEqual(3);
    const contents = body.comments.map((c) => c.content);
    expect(contents).toContain("Starting REST API design");
    expect(contents).toContain("LGTM, clean REST design");
  });
});

// ─── 5. Blocker / Unblock Side-Effects ───────────────────────────────────────

describe("5. Blocker / Unblock Side-Effects", () => {
  test("T2 can start now (T1 blocker is done)", async () => {
    const result = await executeTool("task_update", {
      id: t2Id,
      status: "doing",
      comment: "Starting timer service",
    });
    expect(result).toBe(`Updated: ${t2Id}`);
  });

  test("T3 CANNOT start (blocked by T2 which is in progress)", async () => {
    const result = await executeTool("task_update", { id: t3Id, status: "doing" });
    expect(result).toContain("blocked by");
  });

  test("T4 CANNOT start (blocked by T2 and T3)", async () => {
    const result = await executeTool("task_update", { id: t4Id, status: "doing" });
    expect(result).toContain("blocked by");
  });
});

// ─── 6. Feedback Loop — T2 (human rejects, agent reworks) ───────────────────

describe("6. Feedback Loop (T2: changes_requested cycle)", () => {
  test("agent submits T2 for review", async () => {
    const result = await executeTool("task_update", {
      id: t2Id,
      status: "review",
      comment: "Timer service: fixed 25min intervals",
    });
    expect(result).toBe(`Updated: ${t2Id}`);
  });

  test("human requests changes on T2", async () => {
    const res = await req(app, "PATCH", `/tasks/${t2Id}`, {
      status: "changes_requested",
      comment: "Need configurable intervals, not just 25min",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("changes_requested");
  });

  test("agent reworks T2", async () => {
    const result = await executeTool("task_update", {
      id: t2Id,
      status: "doing",
      comment: "Adding configurable interval support",
    });
    expect(result).toBe(`Updated: ${t2Id}`);
  });

  test("agent re-submits T2", async () => {
    const result = await executeTool("task_update", {
      id: t2Id,
      status: "review",
      comment: "Intervals now configurable: 15/25/45 min presets + custom",
    });
    expect(result).toBe(`Updated: ${t2Id}`);
  });

  test("human approves T2 on second round", async () => {
    const res = await req(app, "PATCH", `/tasks/${t2Id}`, {
      status: "done",
      comment: "Approved — good interval options",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("done");
  });

  test("T3 is now unblocked (T2 done)", async () => {
    const result = await executeTool("task_update", {
      id: t3Id,
      status: "doing",
      comment: "Starting notification work",
    });
    expect(result).toBe(`Updated: ${t3Id}`);
  });
});

// ─── 7. T3/T4 Execution + Parent Rollup ─────────────────────────────────────

describe("7. Parent Rollup", () => {
  test("agent completes T3: doing → review → human approves", async () => {
    await executeTool("task_update", {
      id: t3Id,
      status: "review",
      comment: "Desktop notifications working with system tray",
    });
    const res = await req(app, "PATCH", `/tasks/${t3Id}`, {
      status: "done",
      comment: "Looks great",
    });
    expect(res.status).toBe(200);
  });

  test("parent progress is 75% (3 of 4 subtasks done)", async () => {
    const res = await req(app, "GET", `/tasks/${parentId}`);
    const body = (await res.json()) as { progress: number; status: string };
    expect(body.progress).toBe(75);
    expect(body.status).not.toBe("review");
  });

  test("agent completes T4 (last subtask)", async () => {
    const result = await executeTool("task_update", {
      id: t4Id,
      status: "doing",
      comment: "Writing e2e tests",
    });
    expect(result).toBe(`Updated: ${t4Id}`);
    await executeTool("task_update", { id: t4Id, status: "review", comment: "All tests passing" });
    const res = await req(app, "PATCH", `/tasks/${t4Id}`, {
      status: "done",
      comment: "Tests look comprehensive",
    });
    expect(res.status).toBe(200);
  });

  test("parent auto-transitions to review with 100% progress", async () => {
    const res = await req(app, "GET", `/tasks/${parentId}`);
    const body = (await res.json()) as { progress: number; status: string };
    expect(body.progress).toBe(100);
    expect(body.status).toBe("review");
  });
});

// ─── 8. Max Review Rounds — Auto Pause ───────────────────────────────────────

describe("8. Max Review Rounds — Auto Pause", () => {
  let flakyId: string;
  let flakySessionId: string;

  test("create task with max_review_rounds=2", async () => {
    const res = await req(app, "POST", "/tasks", {
      title: "Flaky notification sound",
      max_review_rounds: 2,
      tags: ["agent"],
      project_id: projectId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; max_review_rounds: number };
    flakyId = body.id;
    expect(body.max_review_rounds).toBe(2);
  });

  test("insert gateway_session for the task", async () => {
    const db = getDb();
    flakySessionId = ulid();
    const now = new Date();
    await db.insert(gateway_sessions).values({
      id: flakySessionId,
      chat_id: "__task-loop__",
      backend: "claude",
      mode: "agent:claude",
      status: "running",
      auto_approve: true,
      task_id: flakyId,
      role: "worker",
      review_rounds: 0,
      created_at: now,
      updated_at: now,
    });
  });

  test("cycle 1: changes_requested increments review_rounds", async () => {
    await updateTaskStatus({ taskId: flakyId, status: "doing" });
    await updateTaskStatus({ taskId: flakyId, status: "review", comment: "Attempt 1" });
    await updateTaskStatus({
      taskId: flakyId,
      status: "changes_requested",
      comment: "Sound too quiet",
    });

    const session = getSqlite()
      .query("SELECT review_rounds FROM gateway_sessions WHERE id = ?")
      .get(flakySessionId) as { review_rounds: number };
    expect(session.review_rounds).toBe(1);

    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, flakyId) });
    expect(task?.status).toBe("changes_requested");
  });

  test("cycle 2: exceeds max rounds → auto-paused", async () => {
    await updateTaskStatus({ taskId: flakyId, status: "doing", comment: "Reworking sound" });
    await updateTaskStatus({ taskId: flakyId, status: "review", comment: "Attempt 2" });
    await updateTaskStatus({
      taskId: flakyId,
      status: "changes_requested",
      comment: "Still too quiet",
    });

    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, flakyId) });
    expect(task?.status).toBe("paused");
    expect(task?.claimed_by).toBeNull();

    const taskComments = await db.query.comments.findMany({
      where: eq(comments.resource_id, flakyId),
    });
    const systemComment = taskComments.find((c) =>
      c.content.includes("exceeded max review rounds"),
    );
    expect(systemComment).toBeTruthy();
  });

  test("paused task can be revived", async () => {
    const result = await updateTaskStatus({ taskId: flakyId, status: "todo" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("todo");
  });
});

// ─── 9. New Status Transitions (queued, paused) ─────────────────────────────

describe("9. New Status Transitions", () => {
  test("todo → queued sets claimed_by", async () => {
    const res = await req(app, "POST", "/tasks", { title: "Queued test task" });
    const task = (await res.json()) as { id: string };
    const result = await updateTaskStatus({
      taskId: task.id,
      status: "queued",
      claimedBy: "session-abc",
    });
    expect(result.ok).toBe(true);
    const db = getDb();
    const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(updated?.claimed_by).toBe("session-abc");
  });

  test("queued → todo clears claimed_by", async () => {
    const res = await req(app, "POST", "/tasks", { title: "Queued→todo test" });
    const task = (await res.json()) as { id: string };
    await updateTaskStatus({ taskId: task.id, status: "queued", claimedBy: "session-xyz" });
    await updateTaskStatus({ taskId: task.id, status: "todo" });
    const db = getDb();
    const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(updated?.claimed_by).toBeNull();
  });

  test("queued → doing works", async () => {
    const res = await req(app, "POST", "/tasks", { title: "Queued→doing test" });
    const task = (await res.json()) as { id: string };
    await updateTaskStatus({ taskId: task.id, status: "queued" });
    const result = await updateTaskStatus({ taskId: task.id, status: "doing" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("doing");
  });

  test("doing → paused clears claimed_by", async () => {
    const res = await req(app, "POST", "/tasks", { title: "Paused test" });
    const task = (await res.json()) as { id: string };
    await updateTaskStatus({ taskId: task.id, status: "doing", claimedBy: "session-p" });
    await updateTaskStatus({ taskId: task.id, status: "paused" });
    const db = getDb();
    const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
    expect(updated?.status).toBe("paused");
    expect(updated?.claimed_by).toBeNull();
  });

  test("changes_requested → queued with claimedBy", async () => {
    const res = await req(app, "POST", "/tasks", { title: "CR→queued test" });
    const task = (await res.json()) as { id: string };
    await updateTaskStatus({ taskId: task.id, status: "doing" });
    await updateTaskStatus({ taskId: task.id, status: "review" });
    await updateTaskStatus({ taskId: task.id, status: "changes_requested" });
    const result = await updateTaskStatus({
      taskId: task.id,
      status: "queued",
      claimedBy: "session-re",
    });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("queued");
  });

  test("changes_requested → paused", async () => {
    const res = await req(app, "POST", "/tasks", { title: "CR→paused test" });
    const task = (await res.json()) as { id: string };
    await updateTaskStatus({ taskId: task.id, status: "doing" });
    await updateTaskStatus({ taskId: task.id, status: "review" });
    await updateTaskStatus({ taskId: task.id, status: "changes_requested" });
    const result = await updateTaskStatus({ taskId: task.id, status: "paused" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("paused");
  });
});

// ─── 10. Context Tool — Orchestration Awareness ──────────────────────────────

describe("10. Context Tool", () => {
  test("agent stores a project decision in memory", async () => {
    const result = await executeTool("memory_store", {
      content: "Stretch intervals: 25 min work, 5 min break (Pomodoro-inspired)",
      title: "Interval decision",
      project: "stretch-reminder",
      type: "decision",
      importance: "high",
    });
    expect(result).toContain("Stored:");
  });

  test("context shows project tasks and memory", async () => {
    const result = await executeTool("context", { project: "stretch-reminder" });
    expect(result).toContain("stretch-reminder");
    expect(result).toContain("Active Tasks");
    expect(result).toContain("Key Memory");
  });

  test("context shows active worker count", async () => {
    const db = getDb();
    const workerId = ulid();
    const now = new Date();
    await db.insert(gateway_sessions).values({
      id: workerId,
      chat_id: "__task-loop__",
      backend: "claude",
      mode: "agent:claude",
      status: "running",
      role: "worker",
      review_rounds: 0,
      created_at: now,
      updated_at: now,
    });

    const result = await executeTool("context", {});
    expect(result).toContain("active worker");

    getSqlite().query("UPDATE gateway_sessions SET status = 'stopped' WHERE id = ?").run(workerId);
  });
});

// ─── 11. Task Loop Eligibility ───────────────────────────────────────────────

describe("11. Task Loop Eligibility", () => {
  const PICK_SQL = `SELECT t.id FROM tasks t
    WHERE (t.status = 'todo' OR t.status = 'changes_requested')
      AND t.claimed_by IS NULL
      AND (t.skill_name IS NOT NULL OR t.agent_backend IS NOT NULL
           OR EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = 'agent'))
      AND NOT EXISTS (
        SELECT 1 FROM task_links tl JOIN tasks blocker ON blocker.id = tl.from_task_id
        WHERE tl.to_task_id = t.id AND tl.link_type = 'blocks'
          AND blocker.status NOT IN ('done', 'cancelled')
      )`;

  test("task with skill_name is eligible", async () => {
    const res = await req(app, "POST", "/tasks", {
      title: "Eligible: skill_name",
      skill_name: coderSkillName,
    });
    const task = (await res.json()) as { id: string };
    const rows = getSqlite().query(PICK_SQL).all() as { id: string }[];
    expect(rows.some((r) => r.id === task.id)).toBe(true);
  });

  test("task with agent_backend is eligible", async () => {
    const res = await req(app, "POST", "/tasks", {
      title: "Eligible: backend",
      agent_backend: "claude",
    });
    const task = (await res.json()) as { id: string };
    const rows = getSqlite().query(PICK_SQL).all() as { id: string }[];
    expect(rows.some((r) => r.id === task.id)).toBe(true);
  });

  test("task with agent tag is eligible", async () => {
    const res = await req(app, "POST", "/tasks", { title: "Eligible: agent tag", tags: ["agent"] });
    const task = (await res.json()) as { id: string };
    const rows = getSqlite().query(PICK_SQL).all() as { id: string }[];
    expect(rows.some((r) => r.id === task.id)).toBe(true);
  });

  test("plain task without agent markers is NOT eligible", async () => {
    const res = await req(app, "POST", "/tasks", { title: "Not eligible: plain task" });
    const task = (await res.json()) as { id: string };
    const rows = getSqlite().query(PICK_SQL).all() as { id: string }[];
    expect(rows.some((r) => r.id === task.id)).toBe(false);
  });

  test("claimed task is NOT eligible", async () => {
    const res = await req(app, "POST", "/tasks", {
      title: "Not eligible: claimed",
      tags: ["agent"],
    });
    const task = (await res.json()) as { id: string };
    getSqlite().query("UPDATE tasks SET claimed_by = 'some-session' WHERE id = ?").run(task.id);
    const rows = getSqlite().query(PICK_SQL).all() as { id: string }[];
    expect(rows.some((r) => r.id === task.id)).toBe(false);
  });
});

// ─── 12. Agent Loop Config ───────────────────────────────────────────────────

describe("12. Agent Loop Config", () => {
  test("config loads with valid agent_loop shape", () => {
    resetConfig();
    const config = loadConfig();
    expect(typeof config.agent_loop.enabled).toBe("boolean");
    expect(typeof config.agent_loop.poll_interval_minutes).toBe("number");
    expect(typeof config.agent_loop.max_workers).toBe("number");
    expect(typeof config.agent_loop.default_backend).toBe("string");
    expect(typeof config.agent_loop.session_idle_timeout_minutes).toBe("number");
    expect(typeof config.agent_loop.worker_auto_approve).toBe("boolean");
  });
});
