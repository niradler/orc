import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@orc/core/ids";
import { createTestDb } from "@orc/db/client";
import { job_runs, jobs } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { startWatcher, stopWatchers } from "./watcher.js";

const WATCH_DIR = join(tmpdir(), `orc-watcher-test-${Date.now()}`);

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
  mkdirSync(WATCH_DIR, { recursive: true });
});

afterAll(async () => {
  await stopWatchers();
  try {
    rmSync(WATCH_DIR, { recursive: true, force: true });
  } catch {}
  delete process.env.ORC_DB_PATH;
});

describe("File watcher - end-to-end", () => {
  let jobId: string;

  test("sets up watch job in DB", async () => {
    const { getDb } = await import("@orc/db/client");
    const db = getDb();
    jobId = ulid();
    const now = new Date();

    await db.insert(jobs).values({
      id: jobId,
      name: "watcher-test-job",
      command: "echo watch-fired",
      trigger_type: "watch",
      watch_path: WATCH_DIR,
      created_at: now,
      updated_at: now,
    });

    const stored = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
    expect(stored?.trigger_type).toBe("watch");
    expect(stored?.watch_path).toBe(WATCH_DIR);
  });

  test("file change triggers job execution and creates a run record", async () => {
    startWatcher(jobId, "watcher-test-job", WATCH_DIR);

    await Bun.sleep(800);

    writeFileSync(join(WATCH_DIR, "trigger.txt"), "hello");

    await Bun.sleep(2500);

    const { getDb } = await import("@orc/db/client");
    const db = getDb();
    const runs = await db.query.job_runs.findMany({
      where: eq(job_runs.job_id, jobId),
    });

    expect(runs.length).toBeGreaterThanOrEqual(1);
    const status = runs[0]?.status ?? "none";
    expect(["success", "running"]).toContain(status);
  }, 15_000);
});
