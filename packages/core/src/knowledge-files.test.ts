import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeCollection, KnowledgeDocument } from "./knowledge.js";
import { editKnowledgeFile, resolveKnowledgeFile } from "./knowledge-files.js";

function fixture(): { collection: KnowledgeCollection; document: KnowledgeDocument; file: string } {
  const root = mkdtempSync(join(tmpdir(), "orc-markdown-security-"));
  const file = join(root, "guide.md");
  writeFileSync(file, "# Original\r\nText\r\n");
  return {
    file,
    collection: {
      name: "docs",
      path: root,
      pattern: "**/*.md",
      documentCount: 1,
      lastModified: null,
      projectId: null,
    },
    document: {
      docid: "abc123",
      path: "docs/guide.md",
      collection: "docs",
      title: "Original",
      content: "# Original\r\nText\r\n",
      modifiedAt: new Date().toISOString(),
    },
  };
}

test("should save and reopen UTF-8 Markdown while rejecting a stale overwrite", () => {
  const { file, collection, document } = fixture();
  editKnowledgeFile(document, collection, "# Updated\r\nשלום\r\n", document.content);
  expect(readFileSync(file, "utf8")).toBe("# Updated\r\nשלום\r\n");
  expect(() => editKnowledgeFile(document, collection, "stale", document.content)).toThrow(
    "changed since",
  );
  expect(readFileSync(file, "utf8")).toContain("שלום");
});

test("should reject traversal, foreign collections, binary text, and non-Markdown sources", () => {
  const { file, collection, document } = fixture();
  for (const path of [
    "docs/../outside.md",
    "docs//guide.md",
    "other/guide.md",
    "docs/C:/guide.md",
    "docs/guide.txt",
    "docs/guide\\file.md",
  ]) {
    expect(() => resolveKnowledgeFile({ ...document, path }, collection)).toThrow();
  }
  expect(() => resolveKnowledgeFile({ ...document, collection: "other" }, collection)).toThrow();
  expect(() => editKnowledgeFile(document, collection, "binary\0data", document.content)).toThrow(
    "UTF-8",
  );
  writeFileSync(file, Buffer.from([255, 0]));
  expect(() => editKnowledgeFile(document, collection, "overwrite", document.content)).toThrow(
    "UTF-8",
  );
});

test("should reject symlink directories that escape a registered collection", () => {
  const { collection, document } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "orc-markdown-outside-"));
  mkdirSync(join(outside, "nested"));
  writeFileSync(join(outside, "nested", "secret.md"), "outside source");
  symlinkSync(join(outside, "nested"), join(collection.path, "linked"), "junction");
  expect(() =>
    editKnowledgeFile(
      { ...document, path: "docs/linked/secret.md" },
      collection,
      "overwrite",
      "outside source",
    ),
  ).toThrow("symlinks");
  expect(readFileSync(join(outside, "nested", "secret.md"), "utf8")).toBe("outside source");
});
