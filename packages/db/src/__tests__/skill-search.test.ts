import { describe, expect, test } from "bun:test";
import { rankSkillMatches, scoreSkillMatches } from "../skill-search.js";

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

describe("hybrid skill relevance", () => {
  const entries = [
    { name: "code-review", description: "Review pull requests for correctness" },
    { name: "release-notes", description: "Summarize code review findings" },
    { name: "deployment", description: "Deploy applications and configure servers" },
    { name: "café-guide", description: "Coffee preparation" },
  ];
  const names = (query: string) =>
    [...scoreSkillMatches(entries, query)]
      .sort((left, right) => right[1] - left[1])
      .map(([name]) => name);

  test("should rank exact names above phrase descriptions and expose positive scores", () => {
    expect(names("code review")).toEqual(["code-review", "release-notes"]);
    expect(scoreSkillMatches(entries, "code review").get("code-review")).toBeGreaterThan(100);
  });
  test("should combine prefix, infix and typo results without dropping weaker matches", () => {
    const scores = scoreSkillMatches(
      [
        { name: "deploy", description: "Ship software" },
        { name: "redeploy", description: "Ship again" },
        { name: "deplox", description: "A deployment helper" },
      ],
      "deploy",
    );
    expect([...scores.keys()].sort()).toEqual(["deplox", "deploy", "redeploy"]);
    expect(scores.get("deploy")).toBeGreaterThan(scores.get("redeploy") ?? 0);
  });
  test("should support word order, stems, accents and transposed typo characters", () => {
    expect(names("review code")[0]).toBe("code-review");
    expect(names("application")).toEqual(["deployment"]);
    expect(names("reveiw")[0]).toBe("code-review");
    expect(names("cafe")).toEqual(["café-guide"]);
  });
  test("should require every term and treat FTS expressions as text", () => {
    expect(names("deploy zebraplanet")).toEqual([]);
    expect(names('"(*)"')).toEqual([]);
    expect(() => names('code" OR NOT (*')).not.toThrow();
    expect(names("   ")).toEqual([]);
  });
  test("should rank whole-word matches above accidental infixes", () => {
    const scores = scoreSkillMatches(
      [
        { name: "decode", description: "Decode a payload" },
        { name: "review", description: "Check code for mistakes" },
      ],
      "code",
    );
    expect(scores.get("review")).toBeGreaterThan(scores.get("decode") ?? 0);
  });
  test("should return deterministic finite scores for a large catalog", () => {
    const catalog = Array.from({ length: 2000 }, (_, i) => ({
      name: `review-tool-${i}`,
      description: `Review code for platform ${i}`,
    }));
    const first = scoreSkillMatches(catalog, "review code");
    expect(first.size).toBe(2000);
    expect([...first.values()].every(Number.isFinite)).toBe(true);
    expect([...scoreSkillMatches(catalog, "review code")]).toEqual([...first]);
  });
});
