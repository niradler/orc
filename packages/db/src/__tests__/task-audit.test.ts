import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { installAudit } from "../audit.js";
import { withTaskAudit } from "../task-audit.js";

let sqlite: Database;
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(
    "CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT,project_id TEXT,progress INTEGER)",
  );
  installAudit(sqlite);
});
afterEach(() => sqlite.close());

test("should roll back source and audit when the outer transaction fails", () => {
  expect(() =>
    sqlite
      .transaction(() => {
        withTaskAudit(sqlite, ["task"], () => {
          sqlite.exec("INSERT INTO tasks VALUES('task','todo','project',0)");
        });
        throw new Error("outer mutation failed");
      })
      .immediate(),
  ).toThrow("outer mutation failed");
  expect(sqlite.query("SELECT count(*) AS count FROM tasks").get()).toEqual({ count: 0 });
  expect(sqlite.query("SELECT count(*) AS count FROM audit_log").get()).toEqual({ count: 0 });
});

test("should roll back the source when audit persistence fails", () => {
  sqlite.exec("CREATE UNIQUE INDEX one_audit_action ON audit_log(action)");
  withTaskAudit(sqlite, ["first"], () =>
    sqlite.exec("INSERT INTO tasks VALUES('first','todo',NULL,0)"),
  );
  expect(() =>
    withTaskAudit(sqlite, ["second"], () => {
      sqlite.exec("INSERT INTO tasks VALUES('second','todo',NULL,0)");
    }),
  ).toThrow();
  expect(sqlite.query("SELECT id FROM tasks").all()).toEqual([{ id: "first" }]);
});

test("should ignore progress and unchanged statuses and deduplicate requested IDs", () => {
  withTaskAudit(sqlite, ["task", "task"], () =>
    sqlite.exec("INSERT INTO tasks VALUES('task','todo',NULL,0)"),
  );
  withTaskAudit(sqlite, ["task"], () => sqlite.exec("UPDATE tasks SET progress=75,status='todo'"));
  expect(sqlite.query("SELECT action,snapshot FROM audit_log").all()).toEqual([
    { action: "task.created", snapshot: '{"status":"todo"}' },
  ]);
});
