import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDb, dbStorageStats, getSqlite, readDbStorageStats } from "../client.js";
import { HumanRequestStore } from "../human-requests.js";
import { installMcpTasks, MCP_TASK_MAX_TTL_MS, McpTaskStore } from "../mcp-tasks.js";
import { autoVacuumMode, incrementalVacuum, pruneRetention } from "../retention.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("should enable incremental auto-vacuum on a new database and report storage", () => {
  const path = join(mkdtempSync(join(tmpdir(), "orc-retention-")), "orc.db");
  dirs.push(dirname(path));
  const db = createDb(path);
  const sqlite = getSqlite(db);
  expect(autoVacuumMode(sqlite)).toBe(2);

  const stats = dbStorageStats(sqlite, path);
  expect(stats.path).toBe(path);
  expect(stats.page_count).toBeGreaterThan(0);
  expect(stats.auto_vacuum).toBe(2);
  expect(stats.database_bytes).toBeGreaterThan(0);

  // A bounded pass is a no-op when nothing is free, not an error.
  expect(incrementalVacuum(sqlite, 10)).toBe(0);

  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  sqlite.close();
  const reread = readDbStorageStats(path);
  expect(reread?.auto_vacuum).toBe(2);
  expect(reread?.database_bytes).toBeGreaterThan(0);
});

test("should prune terminal history, cap MCP tasks and leave pending work alone", () => {
  const sqlite = new Database(":memory:");
  new HumanRequestStore(sqlite);
  installMcpTasks(sqlite);
  const day = 86_400_000;
  const now = 30 * day;
  const insert = sqlite.query(
    `INSERT INTO human_requests(id,origin_key,input_hash,payload,status,version,created_at,expires_at,responded_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  );
  for (const [id, status, createdAt] of [
    ["answered-1", "answered", now - 10 * day],
    ["cancelled-1", "cancelled", now - 10 * day],
    ["pending-1", "pending", now - 10 * day],
  ] as const)
    insert.run(id, id, "hash", "{}", status, 1, createdAt, createdAt + day, createdAt);

  const tasks = new McpTaskStore(sqlite);
  const ids: string[] = [];
  const terminalBase = Date.now() - 5_000;
  for (let index = 0; index < 3; index++) {
    const task = tasks.create({
      flavor: "v2",
      owner: "retention-test",
      toolName: "project_list",
      ttlMs: MCP_TASK_MAX_TTL_MS,
    });
    tasks.complete(task.task_id, { index });
    sqlite
      .query("UPDATE mcp_tasks SET terminal_at=? WHERE task_id=?")
      .run(terminalBase + index, task.task_id);
    ids.push(task.task_id);
  }

  const outcome = pruneRetention(sqlite, {
    now,
    historyRetentionDays: 7,
    mcpTerminalRowCap: 1,
  });
  expect(outcome).toEqual({ human_requests: 2, mcp_tasks: 2, vacuumed_pages: 0 });
  expect(
    sqlite
      .query<{ id: string }, []>("SELECT id FROM human_requests")
      .all()
      .map((row) => row.id),
  ).toEqual(["pending-1"]);
  expect(
    sqlite
      .query<{ task_id: string }, [string]>("SELECT task_id FROM mcp_tasks WHERE owner=?")
      .all("retention-test")
      .map((row) => row.task_id),
  ).toEqual([ids[2] as string]);
  expect(outcome.human_requests).toBe(2);
});
