import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { closeDb, getSqlite } from "@orc/db/client";
import { executeTool } from "../tools.js";

const originalPath = process.env.ORC_DB_PATH;
const originalProject = process.env.ORC_ACTIVE_PROJECT;
const dbDir = mkdtempSync(join(tmpdir(), "orc-mcp-task-search-"));

beforeAll(() => {
  process.env.ORC_DB_PATH = join(dbDir, "tasks.db");
  process.env.ORC_ACTIVE_PROJECT = "";
  closeDb();
  resetConfig();
});

afterAll(() => {
  closeDb();
  if (originalPath === undefined) delete process.env.ORC_DB_PATH;
  else process.env.ORC_DB_PATH = originalPath;
  if (originalProject === undefined) delete process.env.ORC_ACTIVE_PROJECT;
  else process.env.ORC_ACTIVE_PROJECT = originalProject;
  resetConfig();
  Bun.gc(true);
  // Bun 1.4.4 ignores rmSync maxRetries; Windows releases the sqlite handle
  // lazily, so retry explicitly until the dir removes.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dbDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt >= 40) throw error;
      Bun.sleepSync(50);
    }
  }
});

test("MCP task search returns each matching task once after legacy index repair and reopen", async () => {
  const db = getSqlite();
  db.exec(`
    INSERT INTO tasks(id,title) VALUES
      ('search-first','quantum first'),('search-second','quantum second');
    INSERT INTO tasks_fts(id,title,body,tags)
      SELECT id,title,'','' FROM tasks;
    INSERT INTO tasks_fts(id,title,body,tags)
      SELECT id,title,'','' FROM tasks;
  `);
  for (let attempt = 0; attempt < 3; attempt++) {
    closeDb();
    const result = await executeTool("search", {
      query: "quantum",
      resources: ["tasks"],
      limit: 10,
    });
    expect(
      result
        .split("\n")
        .filter((line) => line.includes("[task]"))
        .sort(),
    ).toEqual([
      "  [task] search-first todo - quantum first",
      "  [task] search-second todo - quantum second",
    ]);
  }
});
