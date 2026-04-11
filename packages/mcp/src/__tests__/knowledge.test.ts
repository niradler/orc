import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "@orc/core/ids";
import { createTestDb, getDb } from "@orc/db/client";
import { projects } from "@orc/db/schema";
import { QmdKnowledgeEngine } from "../knowledge.js";

const testDir = join(tmpdir(), `orc-knowledge-test-${Date.now()}`);
const docsDir = join(testDir, "docs");
const docsDir2 = join(testDir, "notes");
const dbPath = join(testDir, "test-knowledge.db");

let engine: QmdKnowledgeEngine;
let projectAId: string;
let projectBId: string;

beforeAll(() => {
  // Set up orc.db for project scoping tests
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();

  // Create test projects
  const db = getDb();
  projectAId = ulid();
  projectBId = ulid();
  const now = new Date();
  db.insert(projects)
    .values([
      { id: projectAId, name: "project-alpha", status: "active", created_at: now, updated_at: now },
      { id: projectBId, name: "project-beta", status: "active", created_at: now, updated_at: now },
    ])
    .run();

  mkdirSync(docsDir, { recursive: true });
  mkdirSync(docsDir2, { recursive: true });
  writeFileSync(
    join(docsDir, "auth.md"),
    "# Authentication\n\nORC uses token-based authentication for API access.\nBearer tokens are passed in the Authorization header.",
  );
  writeFileSync(
    join(docsDir, "tasks.md"),
    "# Tasks\n\nTasks are the primary unit of work in ORC.\nEach task has a status, priority, and optional project association.",
  );
  writeFileSync(
    join(docsDir, "jobs.md"),
    "# Jobs\n\nJobs are scheduled or triggered automation runs.\nThey execute skills and produce session logs.",
  );

  writeFileSync(
    join(docsDir2, "meeting.md"),
    "# Meeting Notes\n\nWeekly standup notes for project beta.\nDiscussed deployment timeline and feature priorities.",
  );

  process.env.ORC_KNOWLEDGE_DB_PATH = dbPath;
  engine = new QmdKnowledgeEngine(dbPath);
});

afterAll(async () => {
  await engine.close();
  delete process.env.ORC_KNOWLEDGE_DB_PATH;
  delete process.env.ORC_DB_PATH;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Windows may hold locks on SQLite files briefly after close
  }
});

// ─── Collections ─────────────────────────────────────────────────────────────

describe("collections", () => {
  test("starts with no collections", async () => {
    const collections = await engine.listCollections();
    expect(collections).toEqual([]);
  });

  test("add a collection indexes documents", async () => {
    await engine.addCollection("test-docs", { path: docsDir, pattern: "**/*.md" });
    const collections = await engine.listCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]!.name).toBe("test-docs");
    expect(collections[0]!.documentCount).toBe(3);
    expect(collections[0]!.pattern).toBe("**/*.md");
  });

  test("remove a collection", async () => {
    await engine.addCollection("temp-col", { path: docsDir });
    const removed = await engine.removeCollection("temp-col");
    expect(removed).toBe(true);
    const collections = await engine.listCollections();
    expect(collections.find((c) => c.name === "temp-col")).toBeUndefined();
  });

  test("remove nonexistent collection returns false", async () => {
    const removed = await engine.removeCollection("nonexistent-xyz");
    expect(removed).toBe(false);
  });
});

// ─── Search ──────────────────────────────────────────────────────────────────

describe("search", () => {
  test("lexical search returns matching documents", async () => {
    const results = await engine.search("authentication token", { mode: "lexical" });
    expect(results.length).toBeGreaterThan(0);
    const authResult = results.find((r) => r.path.includes("auth"));
    expect(authResult).toBeDefined();
    expect(authResult!.score).toBeGreaterThan(0);
  });

  test("search respects limit", async () => {
    const results = await engine.search("ORC", { mode: "lexical", limit: 1 });
    expect(results).toHaveLength(1);
  });

  test("search with no results returns empty array", async () => {
    const results = await engine.search("xyznonexistent123gibberish", { mode: "lexical" });
    expect(results).toEqual([]);
  });
});

// ─── Get document ────────────────────────────────────────────────────────────

describe("get", () => {
  test("get document by docid", async () => {
    const results = await engine.search("tasks", { mode: "lexical", limit: 1 });
    expect(results.length).toBeGreaterThan(0);
    const doc = await engine.get(results[0]!.docid);
    expect(doc).not.toBeNull();
    expect(doc!.content).toContain("Tasks");
    expect(doc!.collection).toBe("test-docs");
  });

  test("get nonexistent document returns null", async () => {
    const doc = await engine.get("#nonexistent999");
    expect(doc).toBeNull();
  });
});

// ─── Status ──────────────────────────────────────────────────────────────────

describe("status", () => {
  test("returns status with collections and doc count", async () => {
    const status = await engine.getStatus();
    expect(status.collections.length).toBeGreaterThan(0);
    expect(status.totalDocuments).toBeGreaterThanOrEqual(3);
    expect(status.dbPath).toBe(dbPath);
    expect(status.searchMode).toBeDefined();
  });
});

// ─── Update / re-index ──────────────────────────────────────────────────────

describe("update", () => {
  test("re-index detects new files", async () => {
    writeFileSync(
      join(docsDir, "new-doc.md"),
      "# New Document\n\nThis document was added after initial indexing.",
    );
    const result = await engine.update({ collections: ["test-docs"] });
    expect(result.indexed).toBeGreaterThanOrEqual(1);
  });
});

// ─── Project scoping ────────────────────────────────────────────────────────

describe("project scoping", () => {
  test("addCollection with project_id stores mapping", async () => {
    await engine.addCollection("alpha-notes", {
      path: docsDir2,
      pattern: "**/*.md",
      project_id: projectAId,
    });
    const collections = await engine.listCollections();
    const alphaNotes = collections.find((c) => c.name === "alpha-notes");
    expect(alphaNotes).toBeDefined();
    expect(alphaNotes!.projectId).toBe(projectAId);
  });

  test("listCollections with project_id filters correctly", async () => {
    const alphaCollections = await engine.listCollections({ project_id: projectAId });
    expect(alphaCollections.every((c) => c.projectId === projectAId)).toBe(true);
    expect(alphaCollections.find((c) => c.name === "alpha-notes")).toBeDefined();
    // test-docs has no project, shouldn't appear in alpha filter
    expect(alphaCollections.find((c) => c.name === "test-docs")).toBeUndefined();
  });

  test("listCollections without project_id returns all", async () => {
    const all = await engine.listCollections();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test("search with project_id scopes to project collections", async () => {
    const results = await engine.search("meeting standup", {
      project_id: projectAId,
      mode: "lexical",
    });
    // Should find the meeting doc in alpha-notes
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.collection === "alpha-notes")).toBe(true);
  });

  test("search with project_id that has no collections returns empty", async () => {
    const results = await engine.search("authentication", {
      project_id: projectBId,
      mode: "lexical",
    });
    expect(results).toEqual([]);
  });

  test("removeCollection cleans up project mapping", async () => {
    await engine.addCollection("temp-project-col", {
      path: docsDir2,
      project_id: projectBId,
    });
    await engine.removeCollection("temp-project-col");
    const betaCollections = await engine.listCollections({ project_id: projectBId });
    expect(betaCollections.find((c) => c.name === "temp-project-col")).toBeUndefined();
  });
});
