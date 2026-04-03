import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { closeDb, createTestDb, getDb, getSqlite } from "@orc/db/client";
import { job_runs, jobs, tasks } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import {
  cleanupStaleSessions,
  ensureSystemJob,
  recordedCycle,
  SYSTEM_JOB_NAME,
} from "../task-loop.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  process.env.ORC_AGENT_LOOP_ENABLED = "true";
  process.env.ORC_AGENT_LOOP_IDLE_TIMEOUT = "1";
  resetConfig();
  createTestDb();
});

afterAll(() => {
  closeDb();
  delete process.env.ORC_DB_PATH;
  delete process.env.ORC_AGENT_LOOP_ENABLED;
  delete process.env.ORC_AGENT_LOOP_IDLE_TIMEOUT;
  resetConfig();
});

describe("ensureSystemJob", () => {
  test("seeds the system job on first call", async () => {
    const db = getDb();
    const jobId = await ensureSystemJob();
    expect(jobId).toBeTruthy();

    const job = await db.query.jobs.findFirst({ where: eq(jobs.name, SYSTEM_JOB_NAME) });
    expect(job).toBeTruthy();
    expect(job?.trigger_type).toBe("cron");
    expect(job?.command).toBe("__internal:task-loop-cycle__");
  });

  test("returns existing job ID on second call", async () => {
    const id1 = await ensureSystemJob();
    const id2 = await ensureSystemJob();
    expect(id1).toBe(id2);
  });
});

describe("recordedCycle", () => {
  test("creates a job_run record for each cycle", async () => {
    const db = getDb();
    await ensureSystemJob();

    await recordedCycle();

    const job = await db.query.jobs.findFirst({ where: eq(jobs.name, SYSTEM_JOB_NAME) });
    expect(job).toBeTruthy();

    const runs = await db.query.job_runs.findMany({ where: eq(job_runs.job_id, job?.id) });
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const lastRun = runs[runs.length - 1];
    expect(lastRun.status).toBe("success");
    expect(lastRun.stdout).toContain("Active workers:");
    expect(lastRun.stdout).toContain("No eligible tasks");
  });

  test("increments job run_count", async () => {
    const db = getDb();
    const job = await db.query.jobs.findFirst({ where: eq(jobs.name, SYSTEM_JOB_NAME) });
    const countBefore = job?.run_count;

    await recordedCycle();

    const jobAfter = await db.query.jobs.findFirst({ where: eq(jobs.name, SYSTEM_JOB_NAME) });
    expect(jobAfter?.run_count).toBe(countBefore + 1);
  });
});

describe("cleanupStaleSessions", () => {
  test("marks idle worker sessions as error and releases tasks", async () => {
    const db = getDb();
    const sqlite = getSqlite();

    const taskId = ulid();
    const sessionId = ulid();
    const now = new Date();

    await db.insert(tasks).values({
      id: taskId,
      title: "Stale task",
      status: "doing",
      priority: "normal",
      author: "agent",
      claimed_by: sessionId,
      created_at: now,
      updated_at: now,
    });

    // Insert a session that's been idle for over 1 minute (our test config)
    const staleTime = Math.floor(Date.now() / 1000) - 120;
    sqlite
      .query(
        `INSERT INTO gateway_sessions (id, chat_id, backend, mode, status, role, task_id, last_activity_at, created_at, updated_at)
         VALUES (?, '__task-loop__', 'claude', 'agent:claude', 'running', 'worker', ?, ?, ?, ?)`,
      )
      .run(sessionId, taskId, staleTime, staleTime, staleTime);

    const cleaned = cleanupStaleSessions();
    expect(cleaned).toBe(1);

    // Session should be marked as error
    const session = sqlite
      .query("SELECT status, last_error FROM gateway_sessions WHERE id = ?")
      .get(sessionId) as { status: string; last_error: string };
    expect(session.status).toBe("error");
    expect(session.last_error).toBe("idle timeout");

    // Task should be released back to todo
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(task?.status).toBe("todo");
    expect(task?.claimed_by).toBeNull();
  });

  test("does not clean up active sessions", async () => {
    const sqlite = getSqlite();
    const sessionId = ulid();

    const recentTime = Math.floor(Date.now() / 1000);
    sqlite
      .query(
        `INSERT INTO gateway_sessions (id, chat_id, backend, mode, status, role, last_activity_at, created_at, updated_at)
         VALUES (?, '__task-loop__', 'claude', 'agent:claude', 'running', 'worker', ?, ?, ?)`,
      )
      .run(sessionId, recentTime, recentTime, recentTime);

    const cleaned = cleanupStaleSessions();
    expect(cleaned).toBe(0);

    const session = sqlite
      .query("SELECT status FROM gateway_sessions WHERE id = ?")
      .get(sessionId) as { status: string };
    expect(session.status).toBe("running");
  });
});
