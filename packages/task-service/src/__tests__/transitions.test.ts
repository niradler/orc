import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ulid } from "@orc/core/ids";
import { closeDb, createTestDb, getDb } from "@orc/db/client";
import { comments, gateway_sessions, task_links, tasks } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { addTaskComment, updateTaskStatus } from "../transitions.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
});

afterAll(() => {
  closeDb();
  delete process.env.ORC_DB_PATH;
});

async function createTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  const db = getDb();
  const id = ulid();
  const now = new Date();
  await db.insert(tasks).values({
    id,
    title: `Test task ${id.slice(-4)}`,
    status: "todo",
    priority: "normal",
    author: "agent",
    created_at: now,
    updated_at: now,
    ...overrides,
  });
  return id;
}

describe("updateTaskStatus", () => {
  test("transitions todo → doing", async () => {
    const id = await createTask();
    const result = await updateTaskStatus({ taskId: id, status: "doing" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("doing");
  });

  test("allows any-to-any transition (todo → done) Trello-style", async () => {
    const id = await createTask();
    const result = await updateTaskStatus({ taskId: id, status: "done" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("done");
  });

  test("adds comment on transition", async () => {
    const db = getDb();
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "doing", comment: "Starting work" });
    const rows = await db.query.comments.findMany({ where: eq(comments.resource_id, id) });
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("Starting work");
  });

  test("sets claimed_by on doing transition", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "doing", claimedBy: "session-123" });
    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBe("session-123");
  });

  test("sets claimed_by on queued transition", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "queued", claimedBy: "session-456" });
    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBe("session-456");
  });

  test("clears claimed_by on paused transition", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "doing", claimedBy: "s1" });
    await updateTaskStatus({ taskId: id, status: "paused" });
    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBeNull();
  });

  test("clears claimed_by on queued → todo fallback", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "queued", claimedBy: "s2" });
    await updateTaskStatus({ taskId: id, status: "todo" });
    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBeNull();
  });

  test("rejects doing when blockers exist", async () => {
    const db = getDb();
    const blockerId = await createTask();
    const blockedId = await createTask();
    await db.insert(task_links).values({
      id: ulid(),
      from_task_id: blockerId,
      to_task_id: blockedId,
      link_type: "blocks",
      created_at: new Date(),
    });
    const result = await updateTaskStatus({ taskId: blockedId, status: "doing" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("blocked by");
  });

  test("unblocks dependents on done", async () => {
    const db = getDb();
    const blockerId = await createTask();
    const blockedId = await createTask({ status: "blocked" });
    await db.insert(task_links).values({
      id: ulid(),
      from_task_id: blockerId,
      to_task_id: blockedId,
      link_type: "blocks",
      created_at: new Date(),
    });
    await updateTaskStatus({ taskId: blockerId, status: "doing" });
    await updateTaskStatus({ taskId: blockerId, status: "review" });
    await updateTaskStatus({ taskId: blockerId, status: "done" });
    const blocked = await db.query.tasks.findFirst({ where: eq(tasks.id, blockedId) });
    expect(blocked?.status).toBe("todo");
  });

  test("queued → doing transition works", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "queued" });
    const result = await updateTaskStatus({ taskId: id, status: "doing" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("doing");
  });

  test("paused → todo re-enables pickup", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "doing" });
    await updateTaskStatus({ taskId: id, status: "paused" });
    const result = await updateTaskStatus({ taskId: id, status: "todo" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("todo");
  });
});

describe("max_review_rounds", () => {
  test("pauses task after exceeding max review rounds", async () => {
    const db = getDb();
    const id = await createTask({ max_review_rounds: 2 });
    const sessionId = ulid();
    const now = new Date();
    await db.insert(gateway_sessions).values({
      id: sessionId,
      chat_id: "__task-loop__",
      backend: "claude",
      mode: "agent:claude",
      status: "running",
      task_id: id,
      review_rounds: 1,
      created_at: now,
      updated_at: now,
    });
    await updateTaskStatus({ taskId: id, status: "doing" });
    await updateTaskStatus({ taskId: id, status: "review" });
    await updateTaskStatus({ taskId: id, status: "changes_requested" });
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.status).toBe("paused");
    expect(task?.claimed_by).toBeNull();
  });

  test("does not pause when under max review rounds", async () => {
    const db = getDb();
    const id = await createTask({ max_review_rounds: 3 });
    const sessionId = ulid();
    const now = new Date();
    await db.insert(gateway_sessions).values({
      id: sessionId,
      chat_id: "__task-loop__",
      backend: "claude",
      mode: "agent:claude",
      status: "running",
      task_id: id,
      review_rounds: 0,
      created_at: now,
      updated_at: now,
    });
    await updateTaskStatus({ taskId: id, status: "doing" });
    await updateTaskStatus({ taskId: id, status: "review" });
    await updateTaskStatus({ taskId: id, status: "changes_requested" });
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.status).toBe("changes_requested");
  });
});

describe("addTaskComment", () => {
  test("creates a comment on a task", async () => {
    const db = getDb();
    const id = await createTask();
    const commentId = await addTaskComment(id, "Test comment", "human");
    expect(commentId).toBeTruthy();
    const row = await db.query.comments.findFirst({ where: eq(comments.id, commentId) });
    expect(row?.content).toBe("Test comment");
    expect(row?.author).toBe("human");
    expect(row?.resource_type).toBe("task");
  });
});
