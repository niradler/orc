import { describe, expect, test } from "bun:test";
import type { GlobalSearchHit } from "../../src/api/client";
import { commandMatches, searchHitPath } from "../../src/lib/command-palette";

describe("command palette", () => {
  test("matches words across labels and synonyms", () => {
    expect(commandMatches("Create task", "new todo", "new task")).toBe(true);
    expect(commandMatches("Go to Knowledge base", "Knowledge", "BASE knowledge")).toBe(true);
    expect(commandMatches("Create task", "new todo", "project")).toBe(false);
  });
  test("builds encoded internal deep links", () => {
    const hit: GlobalSearchHit = {
      kind: "task",
      id: "a/b?c",
      title: "https://untrusted.test",
      detail: "",
      project_id: null,
      project_name: null,
    };
    expect(searchHitPath(hit)).toBe("/tasks/a%2Fb%3Fc");
    expect(searchHitPath({ ...hit, kind: "session" })).toBe("/audit/a%2Fb%3Fc");
  });
  test("links memory hits to the memory in its project, keyed by name", () => {
    const hit: GlobalSearchHit = {
      kind: "memory",
      id: "api-port",
      title: "api-port",
      detail: "",
      project_id: "p/1",
      project_name: "orc",
    };
    expect(searchHitPath(hit)).toBe("/knowledge/memories/p%2F1/api-port");
    expect(searchHitPath({ ...hit, project_id: null })).toBe(
      "/knowledge/memories?memoryQuery=api-port",
    );
  });
});
