import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SCRATCHPAD_CONTENT_MAX_BYTES } from "@orc/core/scratchpad";
import { stopChangeTracking } from "../changes.js";
import { createDb, getSqlite } from "../client.js";
import { ScratchpadStore } from "../scratchpads.js";

let sqlite: Database;
let store: ScratchpadStore;

beforeEach(() => {
  sqlite = getSqlite(createDb(":memory:"));
  sqlite.exec("INSERT INTO projects(id, name) VALUES ('p1', 'one'), ('p2', 'two')");
  store = new ScratchpadStore(sqlite);
});

afterEach(() => {
  stopChangeTracking(sqlite);
  sqlite.close();
});

const scene = (elements: unknown[] = []) =>
  JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} });

describe("ScratchpadStore", () => {
  test("should create each kind at revision 1 with kind-appropriate empty content", () => {
    const doc = store.create({ kind: "doc", title: " Plan ", author: "agent", session_id: "s1" });
    expect(doc).toMatchObject({
      kind: "doc",
      title: "Plan",
      content: "",
      project_id: null,
      session_id: "s1",
      tags: [],
      author: "agent",
      revision: 1,
    });
    const diagram = store.create({ kind: "diagram", title: "Arch", project_id: "p1" });
    expect(JSON.parse(diagram.content)).toMatchObject({ type: "excalidraw", elements: [] });
    expect(diagram.author).toBe("human");
    expect(store.create({ kind: "html", title: "Chart" }).content).toBe("");
  });

  test("should reject diagram content that is not an .excalidraw file", () => {
    expect(() =>
      store.create({ kind: "diagram", title: "Bad", content: "graph TD; a-->b" }),
    ).toThrow("must be an .excalidraw JSON file");
    expect(() =>
      store.create({ kind: "diagram", title: "Bad", content: JSON.stringify({ elements: [] }) }),
    ).toThrow('"type": "excalidraw"');
    const pad = store.create({ kind: "diagram", title: "Ok", content: scene([{ id: "a" }]) });
    expect(() => store.update(pad.id, { content: "{}" })).toThrow(".excalidraw");
  });

  test("should reject content over the size cap and an unknown project", () => {
    expect(() =>
      store.create({
        kind: "doc",
        title: "Huge",
        content: "x".repeat(SCRATCHPAD_CONTENT_MAX_BYTES + 1),
      }),
    ).toThrow("the limit is");
    expect(() => store.create({ kind: "doc", title: "Lost", project_id: "nope" })).toThrow(
      "Project not found",
    );
  });

  test("should bump the revision on every write and refuse a stale if_revision", () => {
    const pad = store.create({ kind: "doc", title: "Notes", author: "agent" });
    const first = store.update(pad.id, { content: "# One", if_revision: 1, author: "human" });
    expect(first).toMatchObject({ content: "# One", revision: 2, author: "human" });
    expect(store.update(pad.id, { title: "Renamed" }).revision).toBe(3);
    expect(() => store.update(pad.id, { content: "# Stale", if_revision: 2 })).toThrow(
      "revision 3 by human, expected 2",
    );
    expect(store.get(pad.id).content).toBe("# One");
  });

  test("should keep unchanged fields and allow clearing project and session links", () => {
    const pad = store.create({
      kind: "doc",
      title: "Linked",
      project_id: "p1",
      session_id: "s1",
      tags: ["Plan", "plan", " api "],
    });
    expect(pad.tags).toEqual(["plan", "api"]);
    const moved = store.update(pad.id, { project_id: "p2" });
    expect(moved).toMatchObject({ project_id: "p2", session_id: "s1", tags: ["plan", "api"] });
    const cleared = store.update(pad.id, { project_id: null, session_id: null, tags: [] });
    expect(cleared).toMatchObject({ project_id: null, session_id: null, tags: [] });
  });

  test("should list newest first without content and filter by kind, project, session, tag and q", () => {
    const a = store.create({ kind: "doc", title: "Alpha plan", project_id: "p1", tags: ["x"] });
    const b = store.create({
      kind: "diagram",
      title: "Beta",
      project_id: "p2",
      session_id: "s9",
    });
    const c = store.create({ kind: "html", title: "Gamma", content: "<b>100%_done</b>" });
    store.update(a.id, { content: "mentions beta" });
    // updated_at has second resolution; pin it so the order does not depend on timing.
    for (const [id, at] of [
      [b.id, 100],
      [c.id, 200],
      [a.id, 300],
    ] as const)
      sqlite.query("UPDATE scratchpads SET updated_at=? WHERE id=?").run(at, id);

    const all = store.list();
    expect(all.map((pad) => pad.id)).toEqual([a.id, c.id, b.id]);
    expect(all[0]).not.toHaveProperty("content");
    expect(all.find((pad) => pad.id === c.id)?.size_bytes).toBe(16);

    expect(store.list({ kind: "diagram" }).map((pad) => pad.id)).toEqual([b.id]);
    expect(store.list({ project_id: "p1" }).map((pad) => pad.id)).toEqual([a.id]);
    expect(store.list({ project_id: null }).map((pad) => pad.id)).toEqual([c.id]);
    expect(store.list({ session_id: "s9" }).map((pad) => pad.id)).toEqual([b.id]);
    expect(store.list({ tag: "X" }).map((pad) => pad.id)).toEqual([a.id]);
    expect(
      store
        .list({ q: "beta" })
        .map((pad) => pad.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    // LIKE wildcards in the query match literally.
    expect(store.list({ q: "%_" }).map((pad) => pad.id)).toEqual([c.id]);
  });

  test("should delete a pad with its project and report missing pads", () => {
    const pad = store.create({ kind: "doc", title: "Goes with p2", project_id: "p2" });
    const unassigned = store.create({ kind: "doc", title: "Stays" });
    sqlite.exec("DELETE FROM projects WHERE id='p2'");
    expect(() => store.get(pad.id)).toThrow("Scratchpad not found");
    expect(store.get(unassigned.id).project_id).toBeNull();
    store.remove(unassigned.id);
    expect(() => store.get(unassigned.id)).toThrow("Scratchpad not found");
    expect(() => store.get(pad.id)).toThrow("Scratchpad not found");
    expect(() => store.remove(unassigned.id)).toThrow("Scratchpad not found");
  });
});
