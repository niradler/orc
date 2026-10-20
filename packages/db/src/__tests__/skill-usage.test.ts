import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDb, getSqlite } from "../client.js";
import { SkillHistory } from "../skill-history.js";

let sqlite: Database;
let history: SkillHistory;

beforeEach(() => {
  sqlite = getSqlite(createDb(":memory:"));
  sqlite.exec("INSERT INTO projects(id, name) VALUES ('p1', 'one'), ('p2', 'two')");
  history = new SkillHistory(sqlite);
});

afterEach(() => sqlite.close());

function find(projectId: string | null, name: string) {
  const skill = history
    .list(projectId, { include_hidden: true })
    .find((item) => item.name === name);
  if (!skill) throw new Error(`Missing builtin skill ${name}`);
  return skill;
}

describe("SkillHistory usage", () => {
  test("should count entry reads separately from supporting file reads", () => {
    history.recordRead("orc-platform", null, "mcp");
    history.recordRead("orc-platform", null, "mcp", "SKILL.md");
    history.recordRead("orc-platform", null, "mcp", "references/guide.md");
    const skill = find(null, "orc-platform");
    expect(skill.read_count).toBe(2);
    expect(skill.ref_read_count).toBe(1);
    expect(skill.last_read_at).toBeGreaterThan(0);
    expect(skill.activity_at).toBe(skill.last_read_at ?? -1);
  });

  test("should split entry reads by source and leave ui views out of the agent count", () => {
    history.recordRead("orc-platform", "p1", "mcp");
    history.recordRead("orc-platform", "p1", "cli");
    history.recordRead("orc-platform", "p1", "api");
    history.recordRead("orc-platform", "p1", "ui");
    history.recordRead("orc-platform", "p1", "ui");
    const skill = find("p1", "orc-platform");
    expect(skill.reads_by_source).toEqual({ mcp: 1, cli: 1, api: 1, ui: 2 });
    expect(skill.read_count).toBe(3);
  });

  test("should not move the last read time on supporting file or ui reads", () => {
    sqlite.exec(
      "INSERT INTO skill_usage(project_key,skill_name,ref,source,read_count,last_read_at) VALUES ('project:p1','orc-platform','','mcp',1,1000), ('project:p1','orc-platform','references/guide.md','mcp',1,2000), ('project:p1','orc-platform','','ui',1,3000)",
    );
    expect(find("p1", "orc-platform").last_read_at).toBe(1000);
  });

  test("should scope counts to the project and total them globally", () => {
    history.recordRead("orc-sdlc", "p1", "mcp");
    history.recordRead("orc-sdlc", "p1", "mcp");
    history.recordRead("orc-sdlc", "p2", "mcp");
    history.recordRead("orc-sdlc", null, "mcp");
    expect(find("p1", "orc-sdlc").read_count).toBe(2);
    expect(find("p2", "orc-sdlc").read_count).toBe(1);
    expect(find(null, "orc-sdlc").read_count).toBe(4);
  });

  test("should fall back to the file date when a skill was never read or edited", () => {
    const skill = find(null, "orc-sdlc");
    expect(skill.read_count).toBe(0);
    expect(skill.last_read_at).toBeNull();
    expect(skill.activity_at).toBeGreaterThan(0);
  });

  test("should list most-read skills first by default", () => {
    history.recordRead("orc-sdlc", "p1", "mcp");
    history.recordRead("orc-sdlc", "p1", "mcp");
    history.recordRead("orc-platform", "p1", "mcp");
    const names = history.list("p1", { include_hidden: true }).map((skill) => skill.name);
    expect(names.slice(0, 2)).toEqual(["orc-sdlc", "orc-platform"]);
  });

  test("should list recently active skills first when sorted by recent", () => {
    sqlite.exec(
      "INSERT INTO skill_usage(project_key,skill_name,ref,source,read_count,last_read_at) VALUES ('project:p1','orc-sdlc','','mcp',9,1000), ('project:p1','orc-platform','','mcp',1,4102444800)",
    );
    const names = history
      .list("p1", { include_hidden: true, sort: "recent" })
      .map((skill) => skill.name);
    expect(names[0]).toBe("orc-platform");
  });

  test("should rank full-text matches by relevance before reads", () => {
    history.recordRead("orc-platform", null, "mcp");
    const names = history.list(null, { include_hidden: true, q: "orc" }).map((s) => s.name);
    expect(names).toContain("orc-sdlc");
    expect(names).toContain("orc-platform");
    expect(history.list(null, { include_hidden: true, q: "zzzunmatched" })).toEqual([]);
  });
});

test("preserves legacy scoped instruction edits without restoring retired discovery entries", () => {
  const original = history.read("orc-reviewer", "p1", "SKILL.md");
  expect(original).not.toBeNull();
  if (!original) return;
  history.update({
    project_id: "p1",
    skill_name: "orc-reviewer",
    content: `${original.content}\nProject review constraint`,
    expected_content: original.content,
    reason: "Preserve a frozen flow's authored instructions",
  });
  expect(history.read("orc-reviewer", "p1")?.content).toContain("Project review constraint");
  expect(history.read("orc-reviewer", "p2")?.content).not.toContain("Project review constraint");
  expect(history.read("orc-sdlc", "p1")?.content).toContain("orc-reviewer: project scope");
  expect(history.read("orc-sdlc", "p2")?.content).not.toContain("orc-reviewer: project scope");
  expect(history.read("orc-sdlc", "p1", "SKILL.md")?.content).not.toContain(
    "Scoped compatibility guidance available",
  );
  expect(history.list("p1", { include_hidden: true }).some((s) => s.name === "orc-reviewer")).toBe(
    false,
  );
});
