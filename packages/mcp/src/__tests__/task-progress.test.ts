import { afterAll, beforeAll, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { AuditLog } from "@orc/db/audit";
import { closeDb, createTestDb, getDb, getSqlite } from "@orc/db/client";
import { projects, tasks } from "@orc/db/schema";
import { executeTool } from "../tools.js";

beforeAll(async () => {
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
  await getDb().insert(projects).values({ id: "progress-project", name: "progress-project" });
  await getDb().insert(tasks).values({
    id: "progress-task",
    title: "Track observed progress",
    status: "doing",
    progress: 40,
    project_id: "progress-project",
  });
});
afterAll(() => {
  closeDb();
  delete process.env.ORC_DB_PATH;
  resetConfig();
});
test("should persist progress and comments without changing flow-owned status", async () => {
  await executeTool("task_update", {
    id: "progress-task",
    progress: 75,
    comment: "Artifact implemented; verification remains",
  });
  expect(
    getSqlite().query("SELECT progress,status FROM tasks WHERE id=?").get("progress-task"),
  ).toEqual({ progress: 75, status: "doing" });
  expect(await executeTool("task_get", { ids: ["progress-task"] })).toContain("Progress: 75%");
  expect(await executeTool("task_list", { project: "progress-project" })).toContain("75%");
  await executeTool("task_update", { id: "progress-task", progress: 0 });
  expect(getSqlite().query("SELECT progress FROM tasks WHERE id=?").get("progress-task")).toEqual({
    progress: 0,
  });
});

test("should audit MCP creation and transitions but ignore progress and claims", async () => {
  await executeTool("task_create", { title: "Private MCP content", project: "progress-project" });
  const task = getSqlite()
    .query<{ id: string }, []>("SELECT id FROM tasks WHERE title='Private MCP content'")
    .get();
  expect(task).not.toBeNull();
  if (!task) throw new Error("MCP creation did not persist a task");
  const id = task.id;
  const audit = new AuditLog(getSqlite());
  const events = () =>
    audit
      .list({ entityType: "task", limit: 100 })
      .filter((entry) => entry.subject_ids.includes(id));
  expect(events()[0]?.snapshot).toEqual({ status: "todo" });
  expect(events()[0]?.project_id).toBe("progress-project");
  await executeTool("task_update", { id, status: "doing" });
  expect(events()[0]?.snapshot).toEqual({ from: "todo", status: "doing" });
  await executeTool("task_update", { id, progress: 70 });
  getSqlite()
    .query("UPDATE tasks SET claimed_by='session',claim_expires_at=123 WHERE id=?")
    .run(id);
  expect(events()).toHaveLength(2);
  expect(JSON.stringify(events())).not.toContain("Private MCP content");
});
