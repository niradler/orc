import { expect, test } from "bun:test";
import { QmdKnowledgeEngine } from "../knowledge.js";
import { validateKnowledgePattern } from "../knowledge-pattern.js";

test("should preserve normal glob alternatives and small stepped ranges", () => {
  for (const pattern of [
    "**/*.md",
    "**/*.{md,txt}",
    "docs/{guide,{howto,notes}}/*.md",
    "file{1..10..2}.md",
    "file{a..z}.md",
    "**/[a-z]*.md",
    "**/\\{literal\\}.md",
  ])
    expect(() => validateKnowledgePattern(pattern)).not.toThrow();
});

test("should reject unsafe persisted patterns before invoking a collection update", async () => {
  let updated = false;
  const engine = new QmdKnowledgeEngine(":memory:");
  Object.assign(engine, {
    store: {
      listCollections: async () => [{ name: "legacy-unsafe", glob_pattern: "{a,b}".repeat(9) }],
      update: async () => {
        updated = true;
        return { indexed: 0, updated: 0, removed: 0 };
      },
    },
  });
  await expect(engine.update()).rejects.toThrow("256 alternatives");
  expect(updated).toBe(false);
});

test("should reject excessive parser depth, size and multiplicative expansion without parsing", () => {
  for (const pattern of [
    "x".repeat(1025),
    `${"{".repeat(9)}x${"}".repeat(9)}`,
    `${"(".repeat(9)}x${")".repeat(9)}`,
    "{a,b}".repeat(9),
    "{1..1000000000}",
    "{1..10..0}",
    "{999999999999999999..1}",
    "{a..100}",
    "",
    "{unclosed",
  ])
    expect(() => validateKnowledgePattern(pattern)).toThrow();
  expect(() => validateKnowledgePattern("{a,b}".repeat(8))).not.toThrow();
});
