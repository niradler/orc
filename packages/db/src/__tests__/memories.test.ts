import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuditLog } from "../audit.js";
import { createDb, getSqlite } from "../client.js";
import { installMemories, MemoryStore } from "../memories.js";

let sqlite: Database;
let store: MemoryStore;

beforeEach(() => {
  sqlite = getSqlite(createDb(":memory:"));
  sqlite.exec("INSERT INTO projects(id, name) VALUES ('p1', 'one'), ('p2', 'two')");
  store = new MemoryStore(sqlite, { maxContentChars: 80 });
});

afterEach(() => sqlite.close());

function create(name: string, extra: { priority?: number | null; project_id?: string } = {}) {
  return store.create({
    project_id: extra.project_id ?? "p1",
    name,
    description: `About ${name}`,
    content: `Content of ${name}`,
    priority: extra.priority,
    author: "tester",
    session_id: "s1",
  });
}

describe("MemoryStore", () => {
  test("should create a memory per project and reject duplicates in the same project", () => {
    const memory = create("dev-port");
    expect(memory).toMatchObject({
      project_id: "p1",
      name: "dev-port",
      priority: null,
      author: "tester",
      session_id: "s1",
    });
    create("dev-port", { project_id: "p2" });
    expect(() => create("dev-port")).toThrow("already exists");
  });

  test("should validate name, description, content and priority", () => {
    const base = { project_id: "p1", description: "d", content: "c" };
    expect(() => store.create({ ...base, name: "Bad Name" })).toThrow("Invalid memory name");
    expect(() => store.create({ ...base, name: "ok", description: "x".repeat(301) })).toThrow(
      "limit is 300",
    );
    expect(() => store.create({ ...base, name: "ok", content: "x".repeat(81) })).toThrow(
      "make it a skill",
    );
    expect(() => store.create({ ...base, name: "ok", priority: 101 })).toThrow("0 to 100");
    expect(() => store.create({ ...base, name: "ok", project_id: "missing" })).toThrow("Project");
  });

  test("should update fields partially and clear priority with null", () => {
    create("dev-port", { priority: 40 });
    const updated = store.update("p1", "dev-port", { content: "Port 7711" }, { author: "a2" });
    expect(updated).toMatchObject({ content: "Port 7711", priority: 40, author: "a2" });
    expect(store.update("p1", "dev-port", { priority: null }).priority).toBeNull();
  });

  test("should count reads per source and rank agent reads only", () => {
    create("a");
    create("b");
    store.read("p1", "b", "mcp");
    store.read("p1", "b", "cli");
    store.read("p1", "a", "ui");
    store.read("p1", "a", "ui");
    const [first, second] = store.list("p1");
    expect(first).toMatchObject({ name: "b", read_count: 2 });
    expect(second?.reads_by_source.ui).toBe(2);
    expect(second?.read_count).toBe(0);
  });

  test("should search name and description and scope by project", () => {
    create("dev-port");
    create("deploy-steps", { project_id: "p2" });
    expect(store.list("p1", { q: "port" }).map((m) => m.name)).toEqual(["dev-port"]);
    expect(store.list("p1", { q: "deploy" })).toEqual([]);
    expect(
      store
        .list(null)
        .map((m) => m.key)
        .sort(),
    ).toEqual(["p1/dev-port", "p2/deploy-steps"]);
  });

  test("should load context by priority, unscored last, without counting reads", () => {
    create("low", { priority: 10 });
    create("none");
    create("high", { priority: 90 });
    store.read("p1", "none", "mcp");
    expect(store.context("p1", 2).map((m) => m.name)).toEqual(["high", "low"]);
    expect(store.list("p1", { sort: "priority" }).map((m) => m.name)).toEqual([
      "high",
      "low",
      "none",
    ]);
    expect(store.list("p1").find((m) => m.name === "high")?.read_count).toBe(0);
  });

  test("should keep history and revert updates, creations and deletions", () => {
    create("dev-port");
    store.update("p1", "dev-port", { content: "Changed" });
    let [latest] = store.history("p1", "dev-port");
    expect(latest?.action).toBe("memory.updated");
    if (!latest) throw new Error("missing history");
    store.revert("p1", "dev-port", latest.id, latest.id, { reason: "undo" });
    expect(store.get("p1", "dev-port").content).toBe("Content of dev-port");

    store.remove("p1", "dev-port", { author: "human" });
    [latest] = store.history("p1", "dev-port");
    if (!latest) throw new Error("missing history");
    expect(() =>
      store.revert("p1", "dev-port", latest?.id ?? "", "stale", { reason: "r" }),
    ).toThrow("changed since review");
    store.revert("p1", "dev-port", latest.id, latest.id, { reason: "restore" });
    expect(store.get("p1", "dev-port").content).toBe("Content of dev-port");

    const created = store.history("p1", "dev-port").at(-1);
    const [newest] = store.history("p1", "dev-port");
    if (!created || !newest) throw new Error("missing history");
    expect(created.action).toBe("memory.created");
    expect(store.revert("p1", "dev-port", created.id, newest.id, { reason: "drop" })).toBeNull();
    expect(() => store.get("p1", "dev-port")).toThrow("not found");
  });

  test("should audit changes by name and find them by session", () => {
    create("dev-port");
    store.update("p1", "dev-port", { content: "x" }, { session_id: "s2" });
    const entries = new AuditLog(sqlite).list({ entityType: "memory" });
    expect(entries.map((e) => e.subject_ids)).toEqual([["dev-port"], ["dev-port"]]);
    expect(store.sessionChanges("s1").map((c) => c.action)).toEqual(["memory.created"]);
  });

  test("should drop a project's memories, history and reads", () => {
    create("dev-port");
    store.read("p1", "dev-port", "mcp");
    store.removeProject("p1");
    for (const table of ["memories", "memory_changes", "memory_usage"])
      expect(sqlite.query(`SELECT 1 FROM ${table}`).get()).toBeNull();
  });
});

describe("installMemories", () => {
  test("should drop the old memories table, its search index and sync sources", () => {
    const old = new Database(":memory:");
    old.exec(`
      CREATE TABLE projects(id TEXT PRIMARY KEY);
      CREATE TABLE memories(id TEXT PRIMARY KEY, type TEXT, content TEXT);
      CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content);
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(id, content) VALUES (new.id, new.content);
      END;
      CREATE TABLE agent_memory_sources(source_key TEXT PRIMARY KEY);
      INSERT INTO memories VALUES ('m1', 'fact', 'old');
    `);
    installMemories(old);
    const tables = old
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name LIKE '%memor%'")
      .all()
      .map((row) => row.name);
    expect(tables).not.toContain("memories_fts");
    expect(tables).not.toContain("agent_memory_sources");
    expect(tables).not.toContain("memories_ai");
    expect(old.query("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
    installMemories(old);
    old.close();
  });

  test("should keep new memories after an older build re-adds its columns and triggers", () => {
    create("kept");
    sqlite.exec(`
      ALTER TABLE memories ADD COLUMN type TEXT NOT NULL DEFAULT 'fact';
      CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content);
      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(id, content) VALUES (new.id, new.content);
      END;
    `);
    expect(() => create("blocked")).toThrow("no such column");
    installMemories(sqlite);
    expect(store.get("p1", "kept").content).toBe("Content of kept");
    expect(create("after").name).toBe("after");
  });
});
