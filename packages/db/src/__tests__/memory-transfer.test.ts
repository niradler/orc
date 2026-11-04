import type { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseMarkdownFrontmatter } from "@orc/core/markdown-frontmatter";
import { createDb, getSqlite } from "../client.js";
import { MemoryStore } from "../memories.js";
import {
  exportNativeMemories,
  importNativeMemories,
  listNativeMemorySources,
  nativeMemoryText,
  planMemoryExport,
  previewMemoryImport,
} from "../memory-transfer.js";

const root = mkdtempSync(join(tmpdir(), "orc-memory-transfer-"));
const previousConfig = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const backups: string[] = [];
const testing =
  "Run the full test suite before every merge and fix every failure, never dismiss one as pre-existing.";
const release = "Bump all package versions together, then run the release script with the OTP.";
let db: Database;
let store: MemoryStore;
let dir: string;
let counter = 0;

function file(name: string, description: string, body: string, extra = ""): void {
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`,
  );
}

function statuses(): Record<string, string> {
  return Object.fromEntries(
    previewMemoryImport(db, "p1", dir).memories.map((memory) => [memory.name, memory.status]),
  );
}

beforeEach(() => {
  db = getSqlite(createDb(":memory:"));
  db.exec("INSERT INTO projects(id, name) VALUES ('p1', 'orc')");
  store = new MemoryStore(db, { maxContentChars: 800 });
  dir = join(root, `memory-${++counter}`);
  mkdirSync(dir, { recursive: true });
});

afterAll(() => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  for (const backup of backups) rmSync(dirname(backup), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("native memory import", () => {
  test("should list Claude project memory folders with the matching project first", () => {
    const projects = join(root, "claude", "projects");
    mkdirSync(join(projects, "C--Projects-other", "memory"), { recursive: true });
    mkdirSync(join(projects, "C--Projects-orc", "memory"), { recursive: true });
    writeFileSync(join(projects, "C--Projects-other", "memory", "a.md"), "x");
    writeFileSync(join(projects, "C--Projects-other", "memory", "MEMORY.md"), "x");
    const sources = listNativeMemorySources("orc");
    expect(sources.map((source) => [source.label, source.project_match, source.count])).toEqual([
      ["C--Projects-orc", true, 0],
      ["C--Projects-other", false, 1],
    ]);
  });

  test("should classify new, installed, near duplicates, conflicts and invalid files", () => {
    store.create({
      project_id: "p1",
      name: "testing",
      description: "Testing rule",
      content: testing,
    });
    store.create({
      project_id: "p1",
      name: "release",
      description: "Release flow",
      content: release,
    });
    store.create({
      project_id: "p1",
      name: "deploy",
      description: "Deploy",
      content: "Deploy with docker compose on the lab host after pulling the branch.",
    });
    file("testing", "Testing rule", testing);
    file("release", "Release flow", release.replace("together", "togther"));
    file("deploy", "Deploy", "Something unrelated about writing poems in the evening light.");
    file("testing-copy", "Testing rule", testing.replace("merge", "merg"));
    file("fresh", "Fresh memory", "A completely new memory about keyboard shortcuts.");
    writeFileSync(join(dir, "broken.md"), "---\nname: broken\n---\nno description");
    writeFileSync(join(dir, "MEMORY.md"), "- [testing](testing.md) — index");
    expect(statuses()).toEqual({
      broken: "invalid",
      deploy: "conflict",
      fresh: "new",
      release: "duplicate",
      testing: "installed",
      "testing-copy": "duplicate",
    });
    const copy = previewMemoryImport(db, "p1", dir).memories.find((m) => m.name === "testing-copy");
    expect(copy?.match).toMatchObject({ name: "testing", level: "near", where: "orc" });
  });

  test("should import new memories, replace only on request and skip near copies", () => {
    store.create({
      project_id: "p1",
      name: "release",
      description: "Release flow",
      content: release,
    });
    file("release", "Release flow", release.replace("together", "togther"));
    file("fresh", "Fresh memory", testing);
    file("fresh-twin", "Fresh memory", testing.replace("suite", "suit"));
    file(
      "feedback_style",
      "Style",
      "Prefer small focused functions.",
      "metadata:\n  type: feedback\n",
    );
    const result = importNativeMemories(db, "p1", dir, [
      { name: "release" },
      { name: "fresh" },
      { name: "fresh-twin" },
      { name: "feedback-style" },
      { name: "missing" },
    ]);
    expect(result.imported).toEqual(["fresh", "feedback-style"]);
    expect(result.replaced).toEqual([]);
    expect(result.skipped.map((item) => item.name)).toEqual(["release", "fresh-twin", "missing"]);
    expect(result.skipped[1]?.reason).toBe("Same as fresh, imported in this batch");
    expect(store.get("p1", "fresh").content).toBe(testing);
    const replaced = importNativeMemories(db, "p1", dir, [{ name: "release", replace: true }]);
    expect(replaced.replaced).toEqual(["release"]);
    expect(store.get("p1", "release").content).toContain("togther");
  });

  test("should mark files that map to one name and over-long content as invalid", () => {
    file("one_name", "First", "First body");
    file("one-name", "Second", "Second body");
    file("long", "Long", "x".repeat(900));
    const memories = previewMemoryImport(db, "p1", dir, store).memories;
    expect(memories.every((memory) => memory.status === "invalid")).toBe(true);
    expect(memories.find((memory) => memory.name === "long")?.error).toContain("800");
  });

  test("should reject relative folders and unknown projects", () => {
    expect(() => previewMemoryImport(db, "p1", "relative")).toThrow("absolute");
    expect(() => previewMemoryImport(db, "nope", dir)).toThrow();
  });
});

describe("native memory export", () => {
  test("should write Claude memory files, index them and round-trip as installed", () => {
    store.create({
      project_id: "p1",
      name: "testing",
      description: "Testing: rule",
      content: testing,
    });
    const target = join(root, "claude", "projects", "C--Projects-orc", "memory");
    rmSync(target, { recursive: true, force: true });
    const plan = planMemoryExport(db, "p1", target);
    expect(plan.index).toBe(true);
    expect(plan.memories.map((item) => item.status)).toEqual(["new"]);
    const result = exportNativeMemories(db, "p1", target);
    expect(result.exported.map((item) => item.name)).toEqual(["testing"]);
    expect(result.index_updated).toBe(true);
    const written = parseMarkdownFrontmatter(readFileSync(join(target, "testing.md"), "utf8"));
    expect(written.fields).toEqual({ name: "testing", description: "Testing: rule" });
    expect(written.body).toBe(testing);
    expect(readFileSync(join(target, "MEMORY.md"), "utf8")).toContain(
      "- [testing](testing.md) — Testing: rule",
    );
    const again = previewMemoryImport(db, "p1", target).memories;
    expect(again.map((memory) => memory.status)).toEqual(["installed"]);
    expect(exportNativeMemories(db, "p1", target).skipped[0]?.reason).toBe(
      "Already identical in the folder",
    );
  });

  test("should replace a near copy only on request, keeping its other frontmatter and a backup", () => {
    store.create({
      project_id: "p1",
      name: "release",
      description: "Release flow",
      content: release,
    });
    file("Release", "Release flow", release.replace("script", "scirpt"), "type: project\n");
    const plan = planMemoryExport(db, "p1", dir);
    expect(plan.index).toBe(false);
    expect(plan.memories[0]).toMatchObject({ status: "near", can_overwrite: true });
    expect(exportNativeMemories(db, "p1", dir).exported).toEqual([]);
    const result = exportNativeMemories(db, "p1", dir, { overwrite: ["release"] });
    const exported = result.exported[0];
    expect(exported).toMatchObject({ name: "release", replaced: true });
    backups.push(exported?.backup as string);
    expect(readFileSync(exported?.backup as string, "utf8")).toContain("scirpt");
    const written = parseMarkdownFrontmatter(readFileSync(join(dir, "Release.md"), "utf8"));
    expect(written.fields).toEqual({
      name: "Release",
      description: "Release flow",
      type: "project",
    });
    expect(written.body).toBe(release);
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
  });

  test("should flag the same memory under another file name as a duplicate", () => {
    store.create({
      project_id: "p1",
      name: "testing",
      description: "Testing rule",
      content: testing,
    });
    file("qa_rule", "Testing rule", testing);
    const item = planMemoryExport(db, "p1", dir).memories[0];
    expect(item).toMatchObject({
      status: "duplicate",
      match: { name: "qa-rule", level: "identical" },
    });
    expect(exportNativeMemories(db, "p1", dir).exported).toEqual([]);
    const forced = exportNativeMemories(db, "p1", dir, { overwrite: ["testing"] });
    expect(forced.exported[0]).toMatchObject({ name: "testing", replaced: false });
  });

  test("should quote YAML-sensitive descriptions", () => {
    const text = nativeMemoryText("x", "a: b # c", "body");
    expect(parseMarkdownFrontmatter(text).fields.description).toBe("a: b # c");
    expect(() => planMemoryExport(db, "p1", dir, ["missing"])).toThrow();
  });
});
