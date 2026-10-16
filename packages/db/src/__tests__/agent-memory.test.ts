import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleEventSchema } from "@orc/core/rules";
import { syncClaudeMemory } from "../agent-memory.js";
import { createDb, getSqlite } from "../client.js";
import { MemoryStore } from "../memories.js";

test("should refuse source escapes and large files without reading arbitrary files", () => {
  const root = mkdtempSync(join(tmpdir(), "orc-memory-path-"));
  const source = join(root, "memory");
  mkdirSync(source);
  const outside = join(root, "outside.md");
  writeFileSync(outside, "outside secret");
  const db = new Database(":memory:");
  const event = RuleEventSchema.parse({
    id: "e",
    session_id: "s",
    backend: "claude",
    cwd: root,
    phase: "post_tool",
    input: { file_path: outside },
  });
  expect(syncClaudeMemory(db, event, null, source)).toEqual({ updated: 0, skipped: [] });
  const large = join(source, "large.md");
  writeFileSync(large, "x".repeat(65537));
  expect(() =>
    syncClaudeMemory(db, { ...event, input: { file_path: large } }, null, source),
  ).toThrow("bounded");
  const link = join(source, "linked.md");
  try {
    symlinkSync(outside, link);
  } catch {
    db.close();
    return;
  }
  expect(() =>
    syncClaudeMemory(db, { ...event, input: { file_path: link } }, null, source),
  ).toThrow("escapes");
  db.close();
});

test("should upsert Claude memory files by name and report files that cannot be memories", () => {
  const root = mkdtempSync(join(tmpdir(), "orc-memory-sync-"));
  const source = join(root, "memory");
  mkdirSync(source);
  const db = getSqlite(createDb(":memory:"));
  db.exec("INSERT INTO projects(id, name) VALUES ('p1', 'one')");
  const file = join(source, "feedback_testing.md");
  const page = (name: string, description: string, body: string): string =>
    ["---", `name: ${name}`, `description: ${description}`, "---", body].join("\n");
  writeFileSync(file, page("feedback_testing", "Run tests first", "Always run tests."));
  writeFileSync(join(source, "long.md"), page("long", "d", "x".repeat(900)));
  const event = RuleEventSchema.parse({
    id: "e",
    session_id: "s",
    backend: "claude",
    cwd: root,
    phase: "session_start",
    input: {},
  });
  expect(() => syncClaudeMemory(db, event, null, source)).toThrow("requires a project");
  const first = syncClaudeMemory(db, event, "p1", source);
  expect(first.updated).toBe(1);
  expect(first.skipped.map((skip) => skip.reason).join()).toContain("make it a skill");
  expect(new MemoryStore(db).get("p1", "feedback-testing")).toMatchObject({
    description: "Run tests first",
    content: "Always run tests.",
    session_id: "s",
  });
  expect(syncClaudeMemory(db, event, "p1", source).updated).toBe(0);
  writeFileSync(file, page("feedback_testing", "Run tests first", "Changed."));
  expect(syncClaudeMemory(db, event, "p1", source).updated).toBe(1);
  expect(new MemoryStore(db).get("p1", "feedback-testing").content).toBe("Changed.");
  db.close();
});
