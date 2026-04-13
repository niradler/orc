import { describe, expect, test } from "bun:test";
import { createDb, getSqlite } from "./client.js";
import * as schema from "./schema.js";

describe("createDb", () => {
  test("initializes an in-memory sqlite database with core tables", () => {
    const db = createDb(":memory:");
    const sqlite = getSqlite(db);
    const rows = sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("projects")).toBe(true);
    expect(names.has("tasks")).toBe(true);
    expect(names.has("jobs")).toBe(true);
    expect(names.has("sessions")).toBe(true);
    sqlite.close();
  });
});

describe("schema", () => {
  test("exports core tables", () => {
    expect(schema.projects).toBeDefined();
    expect(schema.tasks).toBeDefined();
    expect(schema.jobs).toBeDefined();
    expect(schema.sessions).toBeDefined();
    expect(schema.memories).toBeDefined();
  });
});
