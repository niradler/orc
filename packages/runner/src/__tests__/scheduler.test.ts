import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { scheduleOneShotJob, unscheduleJob } from "../scheduler.js";

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

describe("scheduleOneShotJob", () => {
  test("does not fire a job scheduled beyond the 24.8-day timer cap", async () => {
    getSqlite().exec(`INSERT INTO jobs(id,name,command,trigger_type,created_at,updated_at)
      VALUES('far','far-future','echo hi','one-shot',0,0)`);
    scheduleOneShotJob("far", "far-future", new Date(Date.now() + 30 * 86_400_000), 0);
    try {
      await Bun.sleep(50);
      expect(getSqlite().query("SELECT count(*) AS n FROM job_runs").get()).toEqual({ n: 0 });
    } finally {
      unscheduleJob("far");
    }
  });
});
