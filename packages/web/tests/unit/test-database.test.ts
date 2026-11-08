import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTestDatabasePath } from "../../scripts/test-database.js";

const fixtures: string[] = [];

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): { caller: string; api: string } {
  const root = mkdtempSync(join(tmpdir(), "orc-test-database-"));
  fixtures.push(root);
  const caller = join(root, "caller");
  const api = join(root, "api");
  mkdirSync(caller);
  mkdirSync(api);
  return { caller, api };
}

test("should keep a relative fixture database separate from an existing API-working-directory database", () => {
  const { caller, api } = fixture();
  const name = "state.db";
  const existing = new Database(join(api, name));
  try {
    existing.exec("CREATE TABLE markers (value TEXT); INSERT INTO markers VALUES ('preserve')");
  } finally {
    existing.close();
  }
  const path = resolveTestDatabasePath(name, caller);
  if (!path) throw new Error("Missing fixture database path");
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      "const {Database}=require('bun:sqlite'); const db=new Database(process.env.FIXTURE_DB); try { db.exec(\"CREATE TABLE IF NOT EXISTS markers (value TEXT); INSERT INTO markers VALUES ('fixture')\"); } finally { db.close(); }",
    ],
    { cwd: api, env: { ...process.env, FIXTURE_DB: path }, timeout: 10_000 },
  );
  expect(child.exitCode).toBe(0);
  const preserved = new Database(join(api, name), { readonly: true });
  try {
    expect(preserved.query("SELECT value FROM markers").all()).toEqual([{ value: "preserve" }]);
  } finally {
    preserved.close();
  }
  expect(existsSync(join(caller, name))).toBe(true);
  expect(path).toBe(join(caller, name));
});

test("should reject an existing relative or absolute database without changing it", () => {
  const { caller } = fixture();
  const path = join(caller, "existing.db");
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE markers (value TEXT); INSERT INTO markers VALUES ('preserve')");
  } finally {
    db.close();
  }
  for (const candidate of ["existing.db", path])
    expect(() => resolveTestDatabasePath(candidate, caller)).toThrow(
      "existing paths are never adopted",
    );
  const preserved = new Database(path, { readonly: true });
  try {
    expect(preserved.query("SELECT value FROM markers").all()).toEqual([{ value: "preserve" }]);
  } finally {
    preserved.close();
  }
});
