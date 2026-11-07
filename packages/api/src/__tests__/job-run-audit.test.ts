import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { ulid } from "@orc/core/ids";
import { AuditLog } from "@orc/db/audit";
import { getSqlite } from "@orc/db/client";
import { executeJob } from "@orc/runner/executor";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(teardownTestApp);

test("should audit job start and outcomes independently of notification policy without output or command secrets", async () => {
  for (const exit of [0, 1]) {
    const job = await (
      await req(app, "POST", "/jobs", {
        name: `PRIVATE_NAME_${exit}`,
        trigger_type: "manual",
        command: "PRIVATE_COMMAND",
        notify_on: "never",
      })
    ).json<{ id: string }>();
    const run = await executeJob({
      jobId: job.id,
      execution: {
        argv: [process.execPath, "-e", `console.log('PRIVATE_OUTPUT');process.exit(${exit})`],
        stdin: "PRIVATE_STDIN",
        timeout_ms: 10000,
        cwd: process.cwd(),
      },
    });
    const events = new AuditLog(getSqlite())
      .list({ entityType: "job_run" })
      .filter((event) => event.subject_ids.includes(run));
    expect(events.map((event) => event.action).sort()).toEqual(
      [exit === 0 ? "job_run.success" : "job_run.failed", "job_run.started"].sort(),
    );
    expect(events.every((event) => event.actor === null)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
  }
});

test("should audit setup failure for a precreated pending run", async () => {
  const job = await (
    await req(app, "POST", "/jobs", {
      name: "setup failure",
      trigger_type: "manual",
      command: "fixture",
      notify_on: "never",
    })
  ).json<{ id: string }>();
  const sqlite = getSqlite();
  const run = ulid();
  sqlite
    .query("INSERT INTO job_runs(id,job_id,status,created_at) VALUES (?,?,'pending',?)")
    .run(run, job.id, Math.floor(Date.now() / 1000));
  await expect(
    executeJob({
      jobId: job.id,
      runId: run,
      execution: {
        argv: ["__orc_nonexistent_audit_fixture__"],
        stdin: "",
        timeout_ms: 10000,
        cwd: process.cwd(),
      },
    }),
  ).rejects.toThrow();
  const events = new AuditLog(sqlite)
    .list({ entityType: "job_run" })
    .filter((event) => event.subject_ids.includes(run));
  expect(events.map((event) => event.action).sort()).toEqual(["job_run.failed", "job_run.started"]);
  expect(events.find((event) => event.action === "job_run.failed")?.snapshot).toMatchObject({
    job_id: job.id,
    status: "failed",
  });
});

test("should audit failure before execution starts without inventing a started event", async () => {
  const job = await (
    await req(app, "POST", "/jobs", {
      name: "disabled setup failure",
      trigger_type: "manual",
      command: "fixture",
      notify_on: "never",
    })
  ).json<{ id: string }>();
  const sqlite = getSqlite();
  sqlite.query("UPDATE jobs SET enabled=0 WHERE id=?").run(job.id);
  const run = ulid();
  sqlite
    .query("INSERT INTO job_runs(id,job_id,status,created_at) VALUES (?,?,'pending',?)")
    .run(run, job.id, Math.floor(Date.now() / 1000));
  await expect(
    executeJob({ jobId: job.id, runId: run, triggerBy: "webhook:test" }),
  ).rejects.toThrow("Job is disabled");
  const events = new AuditLog(sqlite)
    .list({ entityType: "job_run" })
    .filter((event) => event.subject_ids.includes(run));
  expect(events.map((event) => event.action)).toEqual(["job_run.failed"]);
});

test("should keep a pending job run unchanged if its audit write fails", async () => {
  const job = await (
    await req(app, "POST", "/jobs", {
      name: "atomic job audit",
      trigger_type: "manual",
      command: "fixture",
      notify_on: "never",
    })
  ).json<{ id: string }>();
  const sqlite = getSqlite();
  const run = ulid();
  sqlite
    .query("INSERT INTO job_runs(id,job_id,status,created_at) VALUES (?,?,'pending',?)")
    .run(run, job.id, Math.floor(Date.now() / 1000));
  const record = spyOn(AuditLog.prototype, "record").mockImplementation(() => {
    throw new Error("audit unavailable");
  });
  try {
    await expect(executeJob({ jobId: job.id, runId: run })).rejects.toThrow("audit unavailable");
  } finally {
    record.mockRestore();
  }
  expect(
    sqlite
      .query<{ status: string; started_at: number | null; ended_at: number | null }, [string]>(
        "SELECT status,started_at,ended_at FROM job_runs WHERE id=?",
      )
      .get(run),
  ).toEqual({ status: "pending", started_at: null, ended_at: null });
});
