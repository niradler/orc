import { describe, expect, test } from "bun:test";
import type { GlobalSearchHit } from "../../src/api/client";
import { commandMatches, searchHitPath } from "../../src/lib/command-palette";

describe("command palette", () => {
  test("matches words across labels and synonyms", () => {
    expect(commandMatches("Create task", "new todo", "new task")).toBe(true);
    expect(commandMatches("Go to Knowledge base", "Knowledge", "BASE knowledge")).toBe(true);
    expect(commandMatches("Create task", "new todo", "project")).toBe(false);
  });
  test("builds encoded internal deep links and preserves global wiki scope", () => {
    const hit: GlobalSearchHit = {
      kind: "task",
      id: "a/b?c",
      title: "https://untrusted.test",
      detail: "",
      project_id: null,
      project_name: null,
    };
    expect(searchHitPath(hit)).toBe("/tasks/a%2Fb%3Fc");
    expect(searchHitPath({ ...hit, kind: "wiki" })).toBe(
      "/knowledge/wiki?page=a%2Fb%3Fc&scope=global",
    );
    expect(searchHitPath({ ...hit, kind: "wiki", project_id: "p" })).toBe(
      "/knowledge/wiki?page=a%2Fb%3Fc",
    );
    expect(searchHitPath({ ...hit, kind: "session" })).toBe("/audit/a%2Fb%3Fc");
  });
});
