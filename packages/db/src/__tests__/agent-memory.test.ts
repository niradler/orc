import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleEventSchema } from "@orc/core/rules";
import { syncClaudeMemory } from "../agent-memory.js";

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
  expect(syncClaudeMemory(db, event, null, source)).toBe(0);
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
