import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuditLog } from "../audit.js";
import { createDb, getSqlite } from "../client.js";
import { jaccardSimilarity, MemoryStore, type StoreMemoryResult } from "../memories.js";

let sqlite: Database;
let store: MemoryStore;
let audit: AuditLog;

beforeEach(() => {
  sqlite = getSqlite(createDb(":memory:"));
  sqlite.exec("INSERT INTO projects(id, name) VALUES ('p1', 'one'), ('p2', 'two')");
  store = new MemoryStore(sqlite);
  audit = new AuditLog(sqlite);
});

afterEach(() => sqlite.close());

const content = "The orc dev API runs on port 7711 with an isolated database";

function countMemories(): number {
  return sqlite.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM memories").get()
    ?.total as number;
}

function exists(id: string): boolean {
  return sqlite.query("SELECT 1 FROM memories WHERE id = ?").get(id) !== null;
}

function addedId(result: StoreMemoryResult): string {
  if (result.status !== "added") throw new Error(`expected added, got ${result.status}`);
  return result.id;
}

function mergedId(result: StoreMemoryResult): string {
  if (result.status !== "merged") throw new Error(`expected merged, got ${result.status}`);
  return result.id;
}

describe("jaccardSimilarity", () => {
  test("should ignore case and punctuation", () => {
    expect(jaccardSimilarity("Port 7711!", "port, 7711")).toBe(1);
    expect(jaccardSimilarity("a b", "c d")).toBe(0);
  });
});

describe("MemoryStore", () => {
  test("should add a new memory, report no similar ones and audit the creation", () => {
    const result = store.store({
      content,
      project_id: "p1",
      tags: ["API", "api"],
      actor: "claude",
      session_id: "s1",
    });
    expect(result).toMatchObject({ status: "added", similar: [], superseded: [] });
    const id = addedId(result);
    const row = sqlite
      .query<{ tags: string }, [string]>("SELECT tags FROM memories WHERE id = ?")
      .get(id);
    expect(JSON.parse(row?.tags ?? "[]")).toEqual(["api"]);
    expect(audit.list()).toMatchObject([
      {
        action: "memory.created",
        entity_type: "memory",
        subject_ids: [id],
        project_id: "p1",
        actor: "claude",
        session_id: "s1",
      },
    ]);
  });

  test("should skip a near-identical memory and return the existing id", () => {
    const first = addedId(store.store({ content, project_id: "p1", scope: "dev" }));
    const second = store.store({
      content: `${content.toUpperCase()}.`,
      project_id: "p1",
      scope: "dev",
    });
    expect(second).toMatchObject({ status: "skipped", existing_id: first });
    expect(countMemories()).toBe(1);
  });

  test("should not skip across projects, scopes or types", () => {
    store.store({ content, project_id: "p1" });
    expect(store.store({ content, project_id: "p2" }).status).toBe("added");
    expect(store.store({ content, project_id: "p1", scope: "dev" }).status).toBe("added");
    expect(store.store({ content, project_id: "p1", type: "decision" }).status).toBe("added");
  });

  test("should never auto-skip short items", () => {
    store.store({ content: "use port 7711", project_id: "p1" });
    const again = store.store({ content: "use port 7711", project_id: "p1" });
    expect(again.status).toBe("added");
    if (again.status !== "added") throw new Error("expected added");
    expect(again.similar[0]?.similarity).toBe(1);
  });

  test("should add a related memory and report it as similar", () => {
    const first = addedId(store.store({ content, project_id: "p1" }));
    const result = store.store({
      content: "The orc dev API moved to port 7701 after the zombie socket cleared",
      project_id: "p1",
    });
    if (result.status !== "added") throw new Error("expected added");
    expect(result.similar[0]?.id).toBe(first);
    expect(result.similar[0]?.similarity).toBeLessThan(0.9);
    expect(result.similar[0]?.snippet.length).toBeLessThanOrEqual(151);
  });

  test("should replace merged memories with a new one and keep them in the audit log", () => {
    const first = addedId(
      store.store({ content, project_id: "p1", tags: ["api"], importance: "high", title: "Port" }),
    );
    const second = addedId(
      store.store({ content: "Web proxies the API on 3087", project_id: "p1", tags: ["web"] }),
    );
    const merged = store.store({
      content: `${content}; web proxies to it on 3087`,
      project_id: "p1",
      merge_into: [first, second],
      importance: "low",
      actor: "claude",
    });
    const id = mergedId(merged);
    expect(merged).toMatchObject({ merged: [first, second], superseded: [] });
    expect(exists(first) || exists(second)).toBe(false);
    const row = sqlite
      .query<{ title: string; tags: string; importance: string }, [string]>(
        "SELECT title, tags, importance FROM memories WHERE id = ?",
      )
      .get(id);
    expect(row).toMatchObject({ title: "Port", importance: "high" });
    expect(JSON.parse(row?.tags ?? "[]")).toEqual(["api", "web"]);

    const [entry] = audit.list({ entityType: "memory", limit: 1 });
    expect(entry).toMatchObject({
      action: "memory.merged",
      subject_ids: [first, second],
      result_ids: [id],
      actor: "claude",
    });
    expect(
      ((entry?.snapshot ?? []) as { content: string }[]).map((memory) => memory.content),
    ).toEqual([content, "Web proxies the API on 3087"]);
  });

  test("should point a stale id at its replacement", () => {
    const first = addedId(store.store({ content, project_id: "p1" }));
    const id = mergedId(
      store.store({ content: "merged text", project_id: "p1", merge_into: [first] }),
    );
    expect(() => store.store({ content: "x", project_id: "p1", merge_into: [first] })).toThrow(
      `use ${id}`,
    );
    expect(() => store.update(first, { title: "x" })).toThrow("memory.merged");
  });

  test("should reject a merge across projects or scopes and leave everything in place", () => {
    const first = addedId(store.store({ content, project_id: "p1", scope: "dev" }));
    const other = addedId(store.store({ content, project_id: "p1", scope: "prod" }));
    expect(() => store.store({ content, project_id: "p2", merge_into: [first] })).toThrow(
      "belongs to",
    );
    expect(() => store.store({ content, project_id: "p1", merge_into: [first, other] })).toThrow(
      "belongs to",
    );
    expect(countMemories()).toBe(2);
  });

  test("should remove superseded memories and record the replacement", () => {
    const old = addedId(store.store({ content: "Dev API port is 7701", project_id: "p1" }));
    const next = store.store({
      content: "Dev API port is now 7711 because 7701 holds a zombie socket",
      project_id: "p1",
      supersedes: [old],
    });
    const nextId = addedId(next);
    expect(next.superseded).toEqual([old]);
    expect(exists(old)).toBe(false);
    expect(audit.findLatest(old, ["memory.superseded"])).toMatchObject({
      result_ids: [nextId],
      snapshot: [{ id: old, content: "Dev API port is 7701" }],
    });
  });

  test("should apply supersedes on a skip, with the kept memory as the replacement", () => {
    const old = addedId(store.store({ content: "Builds run on node", project_id: "p1" }));
    const kept = addedId(store.store({ content, project_id: "p1" }));
    const skipped = store.store({ content, project_id: "p1", supersedes: [old] });
    expect(skipped).toMatchObject({ status: "skipped", existing_id: kept, superseded: [old] });
    expect(exists(old)).toBe(false);
  });

  test("should supersede as a follow-up and validate the targets", () => {
    const old = addedId(store.store({ content: "Builds run on node", project_id: "p1" }));
    const other = addedId(store.store({ content: "Builds run on node", project_id: "p2" }));
    const next = addedId(store.store({ content: "Builds run on bun now", project_id: "p1" }));
    expect(() => store.supersede(next, [next])).toThrow("itself");
    expect(() => store.supersede(next, [other])).toThrow("belongs to");
    expect(store.supersede(next, [old])).toEqual([old]);
    expect(() => store.supersede(next, [old])).toThrow("memory.superseded");
  });

  test("should roll back the insert when a superseded id is invalid", () => {
    expect(() => store.store({ content, project_id: "p1", supersedes: ["missing"] })).toThrow(
      "not found",
    );
    expect(countMemories()).toBe(0);
    expect(audit.list()).toEqual([]);
  });

  test("should audit updates and deletes with the previous content", () => {
    const id = addedId(store.store({ content, project_id: "p1" }));
    store.update(id, { content: "Port is 7711", tags: ["Ops"] }, { actor: "api" });
    store.remove(id, { actor: "api" });
    const [deleted, updated] = audit.list({ entityType: "memory" });
    expect(updated).toMatchObject({ action: "memory.updated", snapshot: [{ content }] });
    expect(deleted).toMatchObject({
      action: "memory.deleted",
      snapshot: [{ content: "Port is 7711", tags: '["ops"]' }],
    });
    expect(() => store.remove(id)).toThrow("memory.deleted");
  });

  test("should throw not found for an unknown id", () => {
    expect(() => store.store({ content, merge_into: ["missing"] })).toThrow("not found");
  });
});
