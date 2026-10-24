import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changes, type ResourceChange } from "@orc/core/changes";
import { installChangeTracking, stopChangeTracking } from "../changes.js";
import { HumanRequestStore } from "../human-requests.js";
import { installKnowledgeBases } from "../kb.js";

describe("database change notifications", () => {
  test("should publish human request transitions but ignore waiting-owner heartbeats", async () => {
    const sqlite = new Database(":memory:");
    let now = 1000;
    const store = new HumanRequestStore(sqlite, () => now);
    installChangeTracking(sqlite, ":memory:");
    const events: ResourceChange[] = [];
    const unsubscribe = changes.subscribe((event) => events.push(event));
    try {
      const request = store.create(
        {
          origin: { session_id: "s", backend: "claude", request_id: "q" },
          kind: "question",
          prompt: "Choose",
        },
        "owner",
      );
      await Bun.sleep(50);
      expect(events).toEqual([{ resources: ["human-requests"] }]);
      events.length = 0;
      now += 1000;
      store.heartbeat(request.id, "owner");
      await Bun.sleep(50);
      expect(events).toEqual([]);
      store.respond(request.id, 1, { kind: "question", answer: "Blue" });
      await Bun.sleep(50);
      expect(events).toEqual([{ resources: ["human-requests"] }]);
    } finally {
      unsubscribe();
      sqlite.close();
    }
  });
  test("should identify skill counter updates separately from skill content changes", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE skill_usage(skill_name TEXT, read_count INTEGER)");
    installChangeTracking(sqlite, ":memory:");
    const events: ResourceChange[] = [];
    const unsubscribe = changes.subscribe((event) => events.push(event));
    try {
      sqlite.query("INSERT INTO skill_usage VALUES ('example', 1)").run();
      await Bun.sleep(50);
      expect(events).toEqual([{ resources: ["skill-usage"] }]);
    } finally {
      unsubscribe();
      sqlite.close();
    }
  });
  test("should notify knowledge base writes but not the usage recorded by reads", async () => {
    const sqlite = new Database(":memory:");
    installKnowledgeBases(sqlite);
    installChangeTracking(sqlite, ":memory:");
    const events: ResourceChange[] = [];
    const unsubscribe = changes.subscribe((event) => events.push(event));
    try {
      sqlite
        .query(
          "INSERT INTO kb_usage_totals (document_id, kb_id, source, kind, count, last_at) VALUES ('d', 'kb1', 'ui', 'fetch', 1, 1)",
        )
        .run();
      await Bun.sleep(50);
      expect(events).toEqual([]);
      sqlite
        .query(
          "INSERT INTO knowledge_bases (id, name, created_at, updated_at) VALUES ('kb1', 'Runbooks', 1, 1)",
        )
        .run();
      await Bun.sleep(50);
      expect(events).toEqual([{ resources: ["knowledge"] }]);
    } finally {
      unsubscribe();
      sqlite.close();
    }
  });
  test("should notify committed changes, ignore reads, no-op updates and rollbacks", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT, updated_at INTEGER)");
    installChangeTracking(sqlite, ":memory:");
    const events: ResourceChange[] = [];
    const unsubscribe = changes.subscribe((event) => events.push(event));
    try {
      sqlite.query("INSERT INTO tasks VALUES ('one', 'First', 1)").run();
      await Bun.sleep(50);
      expect(events).toEqual([{ resources: ["tasks"] }]);
      events.length = 0;
      sqlite.query("SELECT * FROM tasks").all();
      sqlite.query("UPDATE tasks SET title='First',updated_at=2").run();
      expect(() =>
        sqlite.transaction(() => {
          sqlite.query("UPDATE tasks SET title='Rolled back'").run();
          throw new Error("rollback");
        })(),
      ).toThrow("rollback");
      await Bun.sleep(50);
      expect(events).toEqual([]);
      sqlite.exec("BEGIN");
      sqlite.query("UPDATE tasks SET title='Uncommitted'").run();
      await Bun.sleep(50);
      expect(events).toEqual([]);
      sqlite.exec("ROLLBACK");
      await Bun.sleep(50);
      expect(events).toEqual([]);
      sqlite.query("UPDATE tasks SET title='Second'").run();
      await Bun.sleep(50);
      expect(events).toEqual([{ resources: ["tasks"] }]);
    } finally {
      unsubscribe();
      stopChangeTracking(sqlite);
      sqlite.close();
    }
  });
  test("should observe writes from a separate database connection through filesystem events", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "orc-change-watch-")), "state.db");
    const sqlite = new Database(path);
    sqlite.exec("PRAGMA journal_mode=WAL; CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT)");
    installChangeTracking(sqlite, path);
    const writer = new Database(path);
    let unsubscribe = (): void => {};
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const notification = new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("External write did not notify")), 2000);
        unsubscribe = changes.subscribe((event) => {
          if (event.resources.includes("tasks")) resolve();
        });
      });
      writer.query("INSERT INTO tasks VALUES ('external','Created outside API')").run();
      await notification;
      expect(sqlite.query("SELECT title FROM tasks").get()).toEqual({
        title: "Created outside API",
      });
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      writer.close();
      sqlite.close();
    }
  });
});
