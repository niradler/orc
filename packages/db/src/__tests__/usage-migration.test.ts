import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

function migrateAndRead(path: string, refresh: boolean): unknown {
  const module = new URL("../client.ts", import.meta.url).href;
  const script = `import { createDb, getSqlite } from ${JSON.stringify(module)};
    const sqlite = getSqlite(createDb(process.argv.at(-1)));
    try {
      console.log(JSON.stringify(sqlite.query("SELECT tokens_used, tokens_version FROM gateway_sessions WHERE id = 'old-claude'").get()));
      if (${refresh}) sqlite.run("UPDATE gateway_sessions SET tokens_used = 1500, tokens_version = 1 WHERE id = 'old-claude'");
    } finally { sqlite.close(); }`;
  const result = Bun.spawnSync([process.execPath, "-e", script, path], {
    timeout: 30000,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

async function cleanup(root: string): Promise<void> {
  if (
    dirname(root) !== realpathSync(tmpdir()) ||
    !basename(root).startsWith("orc-usage-migration-")
  )
    throw new Error("Unexpected temporary database directory");
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("should preserve old counts on migration and retain refreshed count versions after reopen", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orc-usage-migration-")));
  const path = join(root, "legacy.db");
  let sqlite: Database | undefined;
  try {
    sqlite = new Database(path);
    sqlite.exec(`CREATE TABLE gateway_sessions (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, backend TEXT NOT NULL, mode TEXT NOT NULL,
      runtime_session_id TEXT, execution_host TEXT, cwd TEXT, title TEXT, model TEXT,
      status TEXT NOT NULL DEFAULT 'stopped', last_error TEXT, last_activity_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()), tokens_used INTEGER
    );
    INSERT INTO gateway_sessions (id, chat_id, backend, mode, tokens_used) VALUES ('old-claude', 'old-chat', 'claude', 'direct', 100);`);
    sqlite.close();
    sqlite = undefined;
    expect(migrateAndRead(path, true)).toEqual({ tokens_used: 100, tokens_version: 0 });
    expect(migrateAndRead(path, false)).toEqual({ tokens_used: 1500, tokens_version: 1 });
  } finally {
    if (sqlite) {
      sqlite.close();
    }
    await cleanup(root);
  }
});
