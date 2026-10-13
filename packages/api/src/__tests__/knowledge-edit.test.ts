import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeKnowledgeEngine } from "@orc/mcp/knowledge";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const directory = mkdtempSync(join(tmpdir(), "orc-knowledge-edit-"));
const previousPath = process.env.ORC_KNOWLEDGE_DB_PATH;
let app: ReturnType<typeof setupTestApp>;
const content = "# Original\n\nA real source file with spaces in its filename.";
const file = join(directory, "My Guide.md");
const url = "/knowledge/documents/qmd%3A%2F%2Feditor-docs%2FMy-Guide.md";

beforeAll(async () => {
  await closeKnowledgeEngine();
  process.env.ORC_KNOWLEDGE_DB_PATH = join(directory, "knowledge.db");
  writeFileSync(file, content);
  app = setupTestApp();
  const response = await req(app, "POST", "/knowledge/collections", {
    name: "editor-docs",
    path: directory,
  });
  expect(response.status).toBe(201);
});
afterAll(async () => {
  await closeKnowledgeEngine();
  if (previousPath === undefined) delete process.env.ORC_KNOWLEDGE_DB_PATH;
  else process.env.ORC_KNOWLEDGE_DB_PATH = previousPath;
  teardownTestApp();
});

test("should require authentication and save the original physical file behind a normalized index path", async () => {
  expect(
    (
      await app.request(`/api${url}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "attack", expectedContent: content }),
      })
    ).status,
  ).toBe(401);
  const opened = await (await req(app, "GET", url)).json();
  expect(opened.editable).toBe(true);
  expect(opened.content).toBe(content);
  const updated = "# Saved\n\nVerified Markdown persistence.";
  const saved = await req(app, "PUT", url, { content: updated, expectedContent: content });
  expect(saved.status).toBe(200);
  expect(readFileSync(file, "utf8")).toBe(updated);
  expect((await (await req(app, "GET", url)).json()).content).toBe(updated);
  expect((await req(app, "PUT", url, { content: "stale", expectedContent: content })).status).toBe(
    409,
  );
  expect(readFileSync(file, "utf8")).toBe(updated);
});

test("should read external edits from disk and refuse ambiguous normalized filenames", async () => {
  writeFileSync(file, "# External edit\nKeep this content.");
  expect((await (await req(app, "GET", url)).json()).content).toContain("External edit");
  writeFileSync(join(directory, "My-Guide.md"), "# A second file\nDo not overwrite either source.");
  const response = await req(app, "PUT", url, {
    content: "overwrite",
    expectedContent: "# External edit\nKeep this content.",
  });
  expect(response.status).toBe(400);
  expect(readFileSync(file, "utf8")).toContain("External edit");
});
