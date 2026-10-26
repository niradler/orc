import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { stopChangeTracking } from "../changes.js";
import { createDb, getSqlite, type OrcDb } from "../client.js";
import { jobs, projects } from "../schema.js";
import { deleteJob, withSqliteTx, withTx } from "../tx.js";

let db: OrcDb;
function open(): OrcDb {
  db = createDb(":memory:");
  return db;
}
afterEach(() => {
  const sqlite = getSqlite(db);
  stopChangeTracking(sqlite);
  sqlite.close();
});

const projectCount = () => getSqlite(db).query("SELECT count(*) AS n FROM projects").get();

describe("withTx", () => {
  test("rolls back every statement when the callback throws", () => {
    open();
    expect(() =>
      withTx((tx) => {
        tx.insert(projects).values({ id: "p1", name: "one" }).run();
        throw new Error("boom");
      }, db),
    ).toThrow("boom");
    expect(projectCount()).toEqual({ n: 0 });
  });

  test("rejects async callbacks at compile time", () => {
    open();
    // An async drizzle callback commits at its first await, so the rest escapes the transaction.
    // @ts-expect-error promise-returning callbacks are not allowed
    const run = () => withTx(async (tx) => tx.insert(projects).values({ id: "p", name: "p" }), db);
    expect(typeof run).toBe("function");
  });

  test("nests as a savepoint inside an outer transaction", () => {
    open();
    const sqlite = getSqlite(db);
    withSqliteTx(() => {
      sqlite.query("INSERT INTO projects(id,name) VALUES('outer','o')").run();
      expect(() =>
        withTx((tx) => {
          tx.insert(projects).values({ id: "inner", name: "i" }).run();
          throw new Error("inner");
        }, db),
      ).toThrow("inner");
    }, sqlite);
    expect(sqlite.query("SELECT id FROM projects").all()).toEqual([{ id: "outer" }]);
  });
});

describe("deleteJob", () => {
  test("detaches run referrers created without ON DELETE and removes the job with its runs", () => {
    open();
    const sqlite = getSqlite(db);
    sqlite.exec(`
      INSERT INTO jobs(id,name,command,trigger_type,created_at,updated_at) VALUES('j','job','true','manual',0,0);
      INSERT INTO job_runs(id,job_id,status,trigger_by,created_at) VALUES('r','j','success','manual',0);
      INSERT INTO sessions(id,agent,job_run_id,created_at) VALUES('s','runner','r',0);
    `);
    deleteJob("j", sqlite);
    expect(db.select().from(jobs).where(eq(jobs.id, "j")).all()).toEqual([]);
    expect(sqlite.query("SELECT count(*) AS n FROM job_runs").get()).toEqual({ n: 0 });
    expect(sqlite.query("SELECT job_run_id FROM sessions WHERE id='s'").get()).toEqual({
      job_run_id: null,
    });
  });
});

describe("transaction usage", () => {
  test("no source file passes an async callback to a transaction", () => {
    const root = join(import.meta.dir, "../../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
          if (/\.transaction\(\s*async\b/.test(readFileSync(path, "utf8"))) offenders.push(path);
        }
      }
    };
    for (const pkg of readdirSync(root)) {
      const src = join(root, pkg, "src");
      try {
        walk(src);
      } catch {
        // package without src
      }
    }
    expect(offenders).toEqual([]);
  });
});
