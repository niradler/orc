import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AuditLog } from "../audit.js";
import { createDb, getSqlite } from "../client.js";
import { WikiStore } from "../wiki.js";

let sqlite: Database;
let store: WikiStore;

beforeEach(() => {
  sqlite = getSqlite(createDb(":memory:"));
  sqlite.exec("INSERT INTO projects(id, name) VALUES ('p1', 'one'), ('p2', 'two')");
  store = new WikiStore(sqlite);
});

afterEach(() => sqlite.close());

const page = {
  project_id: "p1" as string | null,
  slug: "windows-port-zombie",
  kind: "lesson" as const,
  title: "Zombie sockets on Windows",
  summary: "Kill the whole bun process tree, not only the launcher",
  content: "The grandchild bun process holds the listening socket. Use taskkill /T.",
  tags: ["Windows", "windows", "bun"],
  sources: ["session:abc"],
  note: "Root cause found during API restart",
  expected_revision: 0,
  author: "claude",
  session_id: "abc",
};

describe("WikiStore", () => {
  test("should create a page at revision 1 with normalized tags", () => {
    const written = store.write(page);
    expect(written.revision).toBe(1);
    expect(written.tags).toEqual(["windows", "bun"]);
    expect(store.get("p1", page.slug).content).toBe(page.content);
  });

  test("should reject a stale expected_revision", () => {
    store.write(page);
    expect(() => store.write(page)).toThrow("revision 1");
    const second = store.write({ ...page, expected_revision: 1, note: "Clarified" });
    expect(second.revision).toBe(2);
  });

  test("should keep every revision with note, author and session", () => {
    store.write(page);
    store.write({
      ...page,
      expected_revision: 1,
      content: "Updated content",
      note: "Added detail",
      author: "digest",
      session_id: undefined,
    });
    const history = store.history("p1", page.slug);
    expect(history.map((revision) => revision.revision)).toEqual([2, 1]);
    expect(history[0]).toMatchObject({ note: "Added detail", author: "digest", session_id: null });
    expect(history[1]).toMatchObject({ note: page.note, session_id: "abc" });
  });

  test("should list project pages together with global pages but not other projects", () => {
    store.write(page);
    store.write({ ...page, project_id: null, slug: "global-lesson" });
    store.write({ ...page, project_id: "p2", slug: "other-project" });
    expect(store.list("p1").map((entry) => entry.slug)).toEqual([
      "global-lesson",
      "windows-port-zombie",
    ]);
    expect(store.list(null).map((entry) => entry.slug)).toEqual(["global-lesson"]);
  });

  test("should let a project page hide the global page with the same slug", () => {
    store.write({ ...page, project_id: null, content: "Global grandchild advice" });
    store.write({ ...page, content: "Project grandchild advice", note: "Project override" });

    expect(store.list("p1").map((entry) => entry.project_id)).toEqual(["p1"]);
    expect(store.list("p2").map((entry) => entry.project_id)).toEqual([null]);
    expect(store.search("grandchild", { projectId: "p1" }).map((hit) => hit.project_id)).toEqual([
      "p1",
    ]);
    expect(store.search("grandchild", { projectId: "p2" }).map((hit) => hit.project_id)).toEqual([
      null,
    ]);
    expect(store.get("p1", page.slug).content).toBe("Project grandchild advice");
    expect(store.get("p2", page.slug).content).toBe("Global grandchild advice");
    expect(store.get(null, page.slug).content).toBe("Global grandchild advice");
    expect(store.history("p1", page.slug).map((revision) => revision.note)).toEqual([
      "Project override",
    ]);
    expect(store.history("p2", page.slug).map((revision) => revision.project_id)).toEqual([null]);
    expect(store.history(null, page.slug).map((revision) => revision.project_id)).toEqual([null]);
  });

  test("should return recent changes newest first", () => {
    store.write(page);
    store.write({ ...page, expected_revision: 1, note: "Second" });
    expect(store.changes("p1").map((change) => change.note)).toEqual(["Second", page.note]);
  });

  test("should search titles and content and track updates", () => {
    store.write(page);
    store.write({ ...page, project_id: "p2", slug: "hidden", content: "grandchild socket" });
    const hits = store.search("grandchild socket", { projectId: "p1" });
    expect(hits.map((hit) => hit.slug)).toEqual([page.slug]);
    expect(hits[0]?.snippet).toContain("[");

    store.write({ ...page, expected_revision: 1, content: "Replaced text", note: "Rewrite" });
    expect(store.search("grandchild", { projectId: "p1" })).toEqual([]);
    expect(store.search("replaced", { projectId: "p1" })).toHaveLength(1);
  });

  test("should fall back to OR matching and survive FTS syntax characters", () => {
    store.write(page);
    expect(store.search('socket "unrelatedword* AND (', { projectId: "p1" })).toHaveLength(1);
    expect(store.search("!!!", { projectId: "p1" })).toEqual([]);
  });

  test("should audit every write per project", () => {
    store.write(page);
    store.write({ ...page, expected_revision: 1, note: "Second", author: "digest" });
    store.write({ ...page, project_id: "p2", slug: "other" });
    const entries = new AuditLog(sqlite).list({ projectId: "p1", entityType: "wiki" });
    expect(entries).toMatchObject([
      { action: "wiki.updated", subject_ids: [page.slug], actor: "digest", note: "Second" },
      {
        action: "wiki.created",
        subject_ids: [page.slug],
        session_id: "abc",
        snapshot: { revision: 1 },
      },
    ]);
    expect(new AuditLog(sqlite).list({ since: Math.floor(Date.now() / 1000) + 60 })).toEqual([]);
  });

  test("should throw not found for a missing page", () => {
    expect(() => store.get("p1", "missing")).toThrow("not found");
    expect(() => store.history("p1", "missing")).toThrow("not found");
  });
});
