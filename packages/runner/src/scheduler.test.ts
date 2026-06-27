import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ulid } from "@orc/core/ids";
import { createTestDb } from "@orc/db/client";
import {
  bridge_chats,
  bridge_messages,
  bridge_permissions,
  gateway_sessions,
  job_runs,
  jobs,
  sessions,
} from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { pruneHistory, scheduleOneShotJob, startScheduler, stopScheduler } from "./scheduler.js";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
});

afterAll(() => {
  stopScheduler();
  delete process.env.ORC_DB_PATH;
});

describe("Scheduler - one-shot jobs", () => {
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

describe("Scheduler - cron jobs", () => {
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

describe("Scheduler - pruneHistory", () => {
  test("prunes old runs and terminal gateway sessions, nulling FK referrers without errors", async () => {
    const { getDb } = await import("@orc/db/client");
    const db = getDb();
    // Older than the 7-day retention window.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const jobId = ulid();
    await db.insert(jobs).values({
      id: jobId,
      name: `prune-job-${jobId}`,
      command: "echo x",
      trigger_type: "manual",
    });
    const runId = ulid();
    await db
      .insert(job_runs)
      .values({ id: runId, job_id: jobId, status: "success", created_at: old });
    // A runner session and bridge rows that reference the run / a terminal
    // gateway session — the exact FK web that previously made the prune fail.
    await db
      .insert(sessions)
      .values({ id: ulid(), agent: "runner", job_run_id: runId, created_at: old });
    const chatId = ulid();
    await db.insert(bridge_chats).values({
      id: chatId,
      platform: "telegram",
      chat_id: `chat-${chatId}`,
      updated_at: old,
      created_at: old,
    });
    const gwId = ulid();
    await db.insert(gateway_sessions).values({
      id: gwId,
      chat_id: chatId,
      backend: "claude",
      mode: "interactive",
      status: "stopped",
      created_at: old,
      updated_at: old,
    });
    const msgId = ulid();
    await db.insert(bridge_messages).values({
      id: msgId,
      direction: "in",
      job_run_id: runId,
      gateway_session_id: gwId,
      created_at: old,
    });
    const permId = ulid();
    await db.insert(bridge_permissions).values({
      id: permId,
      tool: "Bash",
      job_run_id: runId,
      gateway_session_id: gwId,
      created_at: old,
    });

    expect(() => pruneHistory()).not.toThrow();

    // The run and terminal gateway session are gone.
    expect(await db.query.job_runs.findFirst({ where: eq(job_runs.id, runId) })).toBeUndefined();
    expect(
      await db.query.gateway_sessions.findFirst({ where: eq(gateway_sessions.id, gwId) }),
    ).toBeUndefined();

    // Bridge rows survive with their dangling references nulled out.
    const msg = await db.query.bridge_messages.findFirst({ where: eq(bridge_messages.id, msgId) });
    expect(msg?.job_run_id).toBeNull();
    expect(msg?.gateway_session_id).toBeNull();
    const perm = await db.query.bridge_permissions.findFirst({
      where: eq(bridge_permissions.id, permId),
    });
    expect(perm?.job_run_id).toBeNull();
    expect(perm?.gateway_session_id).toBeNull();
  });
});
