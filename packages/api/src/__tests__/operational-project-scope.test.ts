import { afterAll, beforeAll, expect, test } from "bun:test";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
});

test("unassigned jobs and tasks filter before limit, including tagged task queries", async () => {
  const project = await (
    await req(app, "POST", "/projects", { name: "operational-scope-project" })
  ).json();
  const job = await (
    await req(app, "POST", "/jobs", {
      name: "000-unassigned-job",
      command: "echo fixture",
      trigger_type: "manual",
    })
  ).json();
  const assignedJob = await (
    await req(app, "POST", "/jobs", {
      name: "000-assigned-job",
      command: "echo fixture",
      trigger_type: "manual",
      project_id: project.id,
    })
  ).json();
  const task = await (
    await req(app, "POST", "/tasks", { title: "Unassigned task", tags: ["scope-fixture"] })
  ).json();
  const assignedTask = await (
    await req(app, "POST", "/tasks", {
      title: "Assigned task",
      project_id: project.id,
      tags: ["scope-fixture"],
    })
  ).json();
  const unassignedJobs = await (
    await req(app, "GET", "/jobs?project_id=unassigned&limit=1")
  ).json();
  expect(unassignedJobs.jobs.map((entry: { id: string }) => entry.id)).toEqual([job.id]);
  const selectedJobs = await (
    await req(app, "GET", `/jobs?project_id=${project.id}&limit=1`)
  ).json();
  expect(selectedJobs.jobs.map((entry: { id: string }) => entry.id)).toEqual([assignedJob.id]);
  const unassignedTasks = await (
    await req(app, "GET", "/tasks?project_id=unassigned&limit=1")
  ).json();
  expect(unassignedTasks.tasks.map((entry: { id: string }) => entry.id)).toEqual([task.id]);
  const tagged = await (
    await req(app, "GET", "/tasks?project_id=unassigned&tag=scope-fixture&status=todo&limit=1")
  ).json();
  expect(tagged.tasks.map((entry: { id: string }) => entry.id)).toEqual([task.id]);
  const selectedTasks = await (
    await req(app, "GET", `/tasks?project_id=${project.id}&limit=1`)
  ).json();
  expect(selectedTasks.tasks.map((entry: { id: string }) => entry.id)).toEqual([assignedTask.id]);
  for (const resource of ["jobs", "tasks"]) {
    expect((await app.request(`/api/${resource}?project_id=unassigned`)).status).toBe(401);
  }
});
