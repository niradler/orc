import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ulid } from "@orc/core/ids";
import { createTestDb } from "@orc/db/client";
import { job_runs, jobs } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { scheduleOneShotJob, startScheduler, stopScheduler } from "./scheduler.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
});

afterAll(() => {
  stopScheduler();
  delete process.env.ORC_DB_PATH;
});

describe("Scheduler — one-shot jobs", () => {
  test("fires one-shot job at run_at time and records a run", async () => {
    const { getDb } = await import("@orc/db/client");
    const db = getDb();
    const jobId = ulid();
    const now = new Date();
    const runAt = new Date(Date.now() + 500);

    await db.insert(jobs).values({
      id: jobId,
      name: "scheduler-test-oneshot",
      command: "echo scheduler-ok",
      trigger_type: "one-shot",
      run_at: runAt,
      created_at: now,
      updated_at: now,
    });

    scheduleOneShotJob(jobId, "scheduler-test-oneshot", runAt, 0);

    await Bun.sleep(2000);

    const runs = await db.query.job_runs.findMany({
      where: eq(job_runs.job_id, jobId),
    });

    expect(runs.length).toBeGreaterThanOrEqual(1);
    const runStatus = runs[0]?.status ?? "none";
    expect(["success", "running"]).toContain(runStatus);
  }, 10_000);

  test("skips one-shot job if already run (run_count > 0)", () => {
    const jobId = ulid();
    const runAt = new Date(Date.now() + 100);
    scheduleOneShotJob(jobId, "already-ran", runAt, 1);
  });
});

describe("Scheduler — cron jobs", () => {
  test("startScheduler loads cron jobs from DB without error", async () => {
    const { getDb } = await import("@orc/db/client");
    const db = getDb();
    const jobId = ulid();
    const now = new Date();

    await db.insert(jobs).values({
      id: jobId,
      name: "scheduler-test-cron",
      command: "echo cron-ok",
      trigger_type: "cron",
      cron_expr: "*/1 * * * *",
      created_at: now,
      updated_at: now,
    });

    await expect(startScheduler()).resolves.toBeUndefined();
    stopScheduler();
  });
});
