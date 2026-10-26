import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { constraintFailure } from "./sqlite-errors.js";

function sqliteError(sql: string): unknown {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE p(id TEXT PRIMARY KEY);");
  db.exec("CREATE TABLE c(id TEXT PRIMARY KEY, p TEXT REFERENCES p(id), n TEXT NOT NULL)");
  db.exec("INSERT INTO p VALUES('a')");
  try {
    db.exec(sql);
  } catch (err) {
    return err;
  } finally {
    db.close();
  }
  throw new Error("expected a constraint failure");
}

describe("constraintFailure", () => {
  test("maps unique and primary key violations to 409", () => {
    expect(constraintFailure(sqliteError("INSERT INTO p VALUES('a')"))).toEqual({
      status: 409,
      code: "CONFLICT",
      error: "A record with this key already exists",
      detail: "UNIQUE constraint failed: p.id",
    });
  });

  test("maps a missing reference to 422, also when wrapped as a cause", () => {
    const err = sqliteError("INSERT INTO c VALUES('1','missing','x')");
    expect(constraintFailure(err)?.status).toBe(422);
    expect(constraintFailure(new Error("query failed", { cause: err }))).toEqual({
      status: 422,
      code: "REFERENCE_NOT_FOUND",
      error: "A referenced record does not exist",
      detail: "FOREIGN KEY constraint failed",
    });
  });

  test("maps not-null to 422 and leaves trigger and storage failures as server errors", () => {
    expect(constraintFailure(sqliteError("INSERT INTO c VALUES('1','a',NULL)"))).toMatchObject({
      code: "CONSTRAINT_VIOLATION",
      error: "A required field is missing or invalid",
    });
    expect(constraintFailure(new Error("disk I/O error"))).toBeNull();
    const raised = Object.assign(new Error("fixture"), { code: "SQLITE_CONSTRAINT_TRIGGER" });
    expect(constraintFailure(raised)).toBeNull();
  });
});
