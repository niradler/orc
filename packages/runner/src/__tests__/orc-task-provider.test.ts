import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { closeDb, createTestDb, getDb, getSqlite } from "@orc/db/client";
import { comments, task_links, tasks } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { OrcTaskProvider } from "../orc-task-provider.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
});

afterAll(() => {
  closeDb();
  delete process.env.ORC_DB_PATH;
  resetConfig();
});

function makeTask(overrides: Partial<typeof tasks.$inferInsert> = {}): typeof tasks.$inferInsert {
  const now = new Date();
  return {
    id: ulid(),
    title: "Test task",
    status: "todo",
    priority: "normal",
    author: "human",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("OrcTaskProvider.pickWorkTasks()", () => {
  test("returns empty array when no eligible tasks", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    // Insert a task that has no skill/backend/agent tag — should not be returned
    const id = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "No skill task" }));
    const result = await provider.pickWorkTasks();
    expect(result.find((t) => t.id === id)).toBeUndefined();
  });

  test("returns task with skill_name set and status todo", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Skill task", skill_name: "my-skill" }));
    const result = await provider.pickWorkTasks();
    expect(result.find((t) => t.id === id)).toBeDefined();
  });

  test("returns task with agent_backend set and status todo", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Backend task", agent_backend: "claude" }));
    const result = await provider.pickWorkTasks();
    expect(result.find((t) => t.id === id)).toBeDefined();
  });

  test("returns task tagged 'agent' with status todo", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    // tags column is json — Drizzle handles serialization when using insert
    await db.insert(tasks).values(makeTask({ id, title: "Agent tagged task", tags: ["agent"] }));
    const result = await provider.pickWorkTasks();
    expect(result.find((t) => t.id === id)).toBeDefined();
  });

  test("returns task with status changes_requested", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db.insert(tasks).values(
      makeTask({
        id,
        title: "Changes requested task",
        status: "changes_requested",
        skill_name: "my-skill",
      }),
    );
    const result = await provider.pickWorkTasks();
    expect(result.find((t) => t.id === id)).toBeDefined();
  });

  test("does NOT return task that is claimed_by someone", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    const sessionId = ulid();
    await db.insert(tasks).values(
      makeTask({
        id,
        title: "Claimed task",
        skill_name: "my-skill",
        claimed_by: sessionId,
      }),
    );
    const result = await provider.pickWorkTasks();
    expect(result.find((t) => t.id === id)).toBeUndefined();
  });

  test("does NOT return task blocked by an unfinished blocker", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const blockerId = ulid();
    const blockedId = ulid();

    // blocker task — not done
    await db
      .insert(tasks)
      .values(makeTask({ id: blockerId, title: "Blocker task", status: "todo" }));
    // blocked task — eligible otherwise
    await db
      .insert(tasks)
      .values(makeTask({ id: blockedId, title: "Blocked task", skill_name: "my-skill" }));
    // link: blockerId blocks blockedId
    await db.insert(task_links).values({
      id: ulid(),
      from_task_id: blockerId,
      to_task_id: blockedId,
      link_type: "blocks",
      created_at: new Date(),
    });

    const result = await provider.pickWorkTasks();
    expect(result.find((t) => t.id === blockedId)).toBeUndefined();
  });

  test("does NOT return tasks with status review, done, or doing", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();

    const reviewId = ulid();
    const doneId = ulid();
    const doingId = ulid();

    await db
      .insert(tasks)
      .values([
        makeTask({ id: reviewId, title: "Review task", status: "review", skill_name: "my-skill" }),
        makeTask({ id: doneId, title: "Done task", status: "done", skill_name: "my-skill" }),
        makeTask({ id: doingId, title: "Doing task", status: "doing", skill_name: "my-skill" }),
      ]);

    const result = await provider.pickWorkTasks();
    expect(result.find((t) => t.id === reviewId)).toBeUndefined();
    expect(result.find((t) => t.id === doneId)).toBeUndefined();
    expect(result.find((t) => t.id === doingId)).toBeUndefined();
  });
});

describe("OrcTaskProvider.pickReviewTasks()", () => {
  test("returns task with status review and no claimed_by", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Review ready task", status: "review" }));
    const result = await provider.pickReviewTasks();
    expect(result.find((t) => t.id === id)).toBeDefined();
  });

  test("does NOT return tasks with non-review statuses", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const todoId = ulid();
    const doingId = ulid();

    await db
      .insert(tasks)
      .values([
        makeTask({ id: todoId, title: "Todo task for review test", status: "todo" }),
        makeTask({ id: doingId, title: "Doing task for review test", status: "doing" }),
      ]);

    const result = await provider.pickReviewTasks();
    expect(result.find((t) => t.id === todoId)).toBeUndefined();
    expect(result.find((t) => t.id === doingId)).toBeUndefined();
  });

  test("does NOT return review tasks that are already claimed", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    const sessionId = ulid();
    await db
      .insert(tasks)
      .values(
        makeTask({ id, title: "Claimed review task", status: "review", claimed_by: sessionId }),
      );
    const result = await provider.pickReviewTasks();
    expect(result.find((t) => t.id === id)).toBeUndefined();
  });
});

describe("OrcTaskProvider.claimTask()", () => {
  test("sets claimed_by on the task", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    const sessionId = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Claim me" }));

    await provider.claimTask(id, sessionId);

    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBe(sessionId);
  });

  test("works regardless of current task status", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    const sessionId = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Claim done task", status: "done" }));

    await provider.claimTask(id, sessionId);

    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBe(sessionId);
    expect(task?.status).toBe("done");
  });
});

describe("OrcTaskProvider.releaseTask()", () => {
  test("sets claimed_by to NULL on the task", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    const sessionId = ulid();
    await db
      .insert(tasks)
      .values(makeTask({ id, title: "Release me", claimed_by: sessionId, status: "doing" }));

    await provider.releaseTask(id);

    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBeNull();
  });
});

describe("OrcTaskProvider.updateTaskStatus()", () => {
  test("returns { ok: true } on valid transition (todo → doing)", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Transition task" }));

    const result = await provider.updateTaskStatus({ taskId: id, status: "doing" });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("sets the task status correctly on success", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Status set task" }));

    await provider.updateTaskStatus({ taskId: id, status: "doing" });

    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.status).toBe("doing");
  });

  test("returns { ok: false, error } on invalid transition (todo → todo)", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Same status task" }));

    // todo → todo is the one invalid transition (cannot transition to same status)
    const result = await provider.updateTaskStatus({ taskId: id, status: "todo" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("todo");
  });
});

describe("OrcTaskProvider.addComment()", () => {
  test("inserts a comment row for the task", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Comment task" }));

    await provider.addComment(id, "This is a comment", "agent");

    const rows = await db.query.comments.findMany({
      where: eq(comments.resource_id, id),
    });
    expect(rows.length).toBe(1);
  });

  test("comment content is readable back from DB", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db.insert(tasks).values(makeTask({ id, title: "Comment content task" }));

    const content = "Hello from the test";
    await provider.addComment(id, content, "tester");

    const rows = await db.query.comments.findMany({
      where: eq(comments.resource_id, id),
    });
    expect(rows[0]?.content).toBe(content);
    expect(rows[0]?.author).toBe("tester");
    expect(rows[0]?.resource_type).toBe("task");
  });
});

describe("OrcTaskProvider.getTask()", () => {
  test("returns PickedTask for an existing task", async () => {
    const provider = new OrcTaskProvider();
    const db = getDb();
    const id = ulid();
    await db
      .insert(tasks)
      .values(makeTask({ id, title: "Get me", skill_name: "skill-x", agent_backend: "claude" }));

    const task = await provider.getTask(id);
    expect(task).not.toBeNull();
    expect(task?.id).toBe(id);
    expect(task?.title).toBe("Get me");
    expect(task?.skill_name).toBe("skill-x");
    expect(task?.agent_backend).toBe("claude");
  });

  test("returns null for a non-existent taskId", async () => {
    const provider = new OrcTaskProvider();
    const result = await provider.getTask(ulid());
    expect(result).toBeNull();
  });
});
