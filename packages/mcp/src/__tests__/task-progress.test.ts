import { afterAll, beforeAll, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
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
