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
    history.recordRead("orc-knowledge", null, "mcp");
    history.recordRead("orc-knowledge", null, "mcp", "SKILL.md");
    history.recordRead("orc-knowledge", null, "mcp", "references/guide.md");
    const skill = find(null, "orc-knowledge");
    expect(skill.read_count).toBe(2);
    expect(skill.ref_read_count).toBe(1);
    expect(skill.last_read_at).toBeGreaterThan(0);
    expect(skill.activity_at).toBe(skill.last_read_at ?? -1);
  });

  test("should split entry reads by source and leave ui views out of the agent count", () => {
    history.recordRead("orc-knowledge", "p1", "mcp");
    history.recordRead("orc-knowledge", "p1", "cli");
    history.recordRead("orc-knowledge", "p1", "api");
    history.recordRead("orc-knowledge", "p1", "ui");
    history.recordRead("orc-knowledge", "p1", "ui");
    const skill = find("p1", "orc-knowledge");
    expect(skill.reads_by_source).toEqual({ mcp: 1, cli: 1, api: 1, ui: 2 });
    expect(skill.read_count).toBe(3);
  });

  test("should not move the last read time on supporting file or ui reads", () => {
    sqlite.exec(
      "INSERT INTO skill_usage(project_key,skill_name,ref,source,read_count,last_read_at) VALUES ('project:p1','orc-knowledge','','mcp',1,1000), ('project:p1','orc-knowledge','references/guide.md','mcp',1,2000), ('project:p1','orc-knowledge','','ui',1,3000)",
    );
    expect(find("p1", "orc-knowledge").last_read_at).toBe(1000);
  });

  test("should scope counts to the project and total them globally", () => {
    history.recordRead("orc-memory", "p1", "mcp");
    history.recordRead("orc-memory", "p1", "mcp");
    history.recordRead("orc-memory", "p2", "mcp");
    history.recordRead("orc-memory", null, "mcp");
    expect(find("p1", "orc-memory").read_count).toBe(2);
    expect(find("p2", "orc-memory").read_count).toBe(1);
    expect(find(null, "orc-memory").read_count).toBe(4);
  });

  test("should fall back to the file date when a skill was never read or edited", () => {
    const skill = find(null, "orc-coder");
    expect(skill.read_count).toBe(0);
    expect(skill.last_read_at).toBeNull();
    expect(skill.activity_at).toBeGreaterThan(0);
  });

  test("should list most-read skills first by default", () => {
    history.recordRead("orc-tasks", "p1", "mcp");
    history.recordRead("orc-tasks", "p1", "mcp");
    history.recordRead("orc-knowledge", "p1", "mcp");
    const names = history.list("p1", { include_hidden: true }).map((skill) => skill.name);
    expect(names.slice(0, 2)).toEqual(["orc-tasks", "orc-knowledge"]);
  });

  test("should list recently active skills first when sorted by recent", () => {
    sqlite.exec(
      "INSERT INTO skill_usage(project_key,skill_name,ref,source,read_count,last_read_at) VALUES ('project:p1','orc-tasks','','mcp',9,1000), ('project:p1','orc-knowledge','','mcp',1,4102444800)",
    );
    const names = history
      .list("p1", { include_hidden: true, sort: "recent" })
      .map((skill) => skill.name);
    expect(names[0]).toBe("orc-knowledge");
  });

  test("should rank full-text matches by relevance before reads", () => {
    history.recordRead("orc-memory-review", null, "mcp");
    const names = history.list(null, { include_hidden: true, q: "memory" }).map((s) => s.name);
    expect(names).toContain("orc-memory");
    expect(names).toContain("orc-memory-review");
    expect(history.list(null, { include_hidden: true, q: "zzzunmatched" })).toEqual([]);
  });
});
