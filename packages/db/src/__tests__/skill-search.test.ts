import { describe, expect, test } from "bun:test";
import { rankSkillMatches } from "../skill-search.js";

const skills = [
  { name: "code-review", description: "Review a pull request for correctness bugs" },
  { name: "orc-memory", description: "Store and recall project knowledge" },
  { name: "release-notes", description: "Write notes that mention code review findings" },
  { name: "deploy", description: "Ship the build to production" },
];

function matchedNames(query: string): string[] {
  const ranks = rankSkillMatches(skills, query);
  return [...ranks.entries()].sort((left, right) => left[1] - right[1]).map(([name]) => name);
}

describe("rankSkillMatches", () => {
  test("should match words in any order across hyphenated names", () => {
    expect(matchedNames("review code")[0]).toBe("code-review");
  });

  test("should rank a name match above a description-only match", () => {
    expect(matchedNames("code review")).toEqual(["code-review", "release-notes"]);
  });

  test("should match word prefixes", () => {
    expect(matchedNames("mem")).toEqual(["orc-memory"]);
  });

  test("should return nothing when no skill has every term", () => {
    expect(matchedNames("deploy kubernetes")).toEqual([]);
  });

  test("should fall back to substring matching inside words", () => {
    expect(matchedNames("ploy")).toEqual(["deploy"]);
  });

  test("should treat FTS syntax characters as plain text", () => {
    expect(() => rankSkillMatches(skills, 'code" OR NOT (*')).not.toThrow();
    expect(matchedNames('"(*)"')).toEqual([]);
  });
});
