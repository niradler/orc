import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSqlite } from "@orc/db/client";
import { closeKnowledgeEngine } from "@orc/mcp/knowledge";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const directory = mkdtempSync(join(tmpdir(), "orc-pattern-api-"));
const previousPath = process.env.ORC_KNOWLEDGE_DB_PATH;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await closeKnowledgeEngine();
  process.env.ORC_KNOWLEDGE_DB_PATH = join(directory, "knowledge.db");
  writeFileSync(join(directory, "real.md"), "# Pattern validation\n\nReal Markdown evidence.");
  writeFileSync(join(directory, "real.txt"), "# Plain text\n\nReal text evidence.");
  app = setupTestApp();
});

afterAll(async () => {
  await closeKnowledgeEngine();
  if (previousPath === undefined) delete process.env.ORC_KNOWLEDGE_DB_PATH;
  else process.env.ORC_KNOWLEDGE_DB_PATH = previousPath;
  teardownTestApp();
});

test("should reject unsafe HTTP collection patterns before persisting them and retain normal indexing", async () => {
  for (const pattern of [
    `${"{".repeat(4900)}x${"}".repeat(4900)}`,
    `${"{".repeat(9)}x${"}".repeat(9)}`,
    "{a,b}".repeat(9),
    "{1..1000000000}",
  ]) {
    const response = await req(app, "POST", "/knowledge/collections", {
      name: "rejected-pattern",
      path: directory,
      pattern,
    });
    expect(response.status).toBe(400);
    expect(
      getSqlite()
        .query("SELECT name FROM knowledge_collections WHERE name='rejected-pattern'")
        .get(),
    ).toBeNull();
    const collections = await (await req(app, "GET", "/knowledge/collections")).json();
    expect(
      collections.collections.some(
        (collection: { name: string }) => collection.name === "rejected-pattern",
      ),
    ).toBe(false);
    expect((await req(app, "GET", "/health")).status).toBe(200);
  }
  const normal = await req(app, "POST", "/knowledge/collections", {
    name: "normal-pattern",
    path: directory,
    pattern: "**/*.{md,txt}",
  });
  expect(normal.status).toBe(201);
  expect((await normal.json()).indexed).toBe(2);
});
