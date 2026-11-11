import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RECALL,
  extractQuery,
  filterRecall,
  formatRecall,
  mergeHits,
  parseMemoryHits,
  parseSkillHits,
  queryWindows,
  recallKeys,
} from "../src/recall.js";

describe("extractQuery", () => {
  test("keeps distinctive terms and drops stopwords, numbers and duplicates", () => {
    expect(extractQuery("Please fix the kubernetes helm chart, helm values 123")).toBe(
      "kubernetes helm chart values",
    );
  });

  test("caps the number of terms and returns empty for chatter", () => {
    const many = Array.from({ length: 30 }, (_, i) => `term${i}x`).join(" ");
    expect(extractQuery(many).split(" ")).toHaveLength(12);
    expect(extractQuery("ok do it now")).toBe("");
  });
});

describe("queryWindows and mergeHits", () => {
  test("builds adjacent term pairs because ORC search needs every term to match", () => {
    expect(queryWindows("write linkedin blog post release")).toEqual([
      "write linkedin",
      "linkedin blog",
      "blog post",
      "post release",
    ]);
    expect(queryWindows("kubernetes")).toEqual(["kubernetes"]);
    expect(queryWindows("ok do it")).toEqual([]);
  });

  test("merges by name keeping the best score first", () => {
    const merged = mergeHits([
      [{ name: "a", description: "A", score: 7 }],
      [
        { name: "b", description: "B", score: 9 },
        { name: "a", description: "A", score: 12 },
      ],
    ]);
    expect(merged.map((hit) => `${hit.name}:${hit.score}`)).toEqual(["a:12", "b:9"]);
  });
});

describe("parsing ORC listings", () => {
  test("parses scored skill lines and applies the minimum score", () => {
    const text = [
      "helm-deploy [user] (3 reads) [score: 14.2] - Deploy charts with helm",
      "weak-one [user] (0 reads) [score: 2.0] - Barely related",
      "orc-sdlc (9 reads) [score: 20] - Delivery process",
      "not a line",
    ].join("\n");
    expect(parseSkillHits(text, 6)).toEqual([
      { name: "orc-sdlc", description: "Delivery process", score: 20 },
      { name: "helm-deploy", description: "Deploy charts with helm", score: 14.2 },
    ]);
  });

  test("parses memory lines and strips the project suffix", () => {
    const text = [
      "prefer-bun [p80] (4 reads) - Use bun not npm [project: orc]",
      "no-priority-line",
    ].join("\n");
    expect(parseMemoryHits(text)).toEqual([{ name: "prefer-bun", description: "Use bun not npm" }]);
  });
});

describe("filterRecall and formatRecall", () => {
  const result = {
    skills: [
      { name: "local-one", description: "already local" },
      { name: "a", description: "A" },
      { name: "b", description: "B" },
      { name: "c", description: "C" },
      { name: "d", description: "D" },
    ],
    memories: [{ name: "m1", description: "first" }],
  };

  test("drops local skills and already-offered names, and caps counts", () => {
    const found = filterRecall(
      result,
      DEFAULT_RECALL,
      new Set(["skill:a", "memory:m1"]),
      new Set(["local-one"]),
    );
    expect(found.skills.map((hit) => hit.name)).toEqual(["b", "c", "d"]);
    expect(found.memories).toEqual([]);
    expect(recallKeys(found)).toEqual(["skill:b", "skill:c", "skill:d"]);
  });

  test("renders pointers only and returns undefined when empty", () => {
    const text = formatRecall(
      {
        skills: [{ name: "a", description: "A skill" }],
        memories: [{ name: "m1", description: "x" }],
      },
      900,
    );
    expect(text).toContain("orc memory_read");
    expect(text).toContain("- m1: x");
    expect(text).toContain("- a: A skill");
    expect(formatRecall({ skills: [], memories: [] }, 900)).toBeUndefined();
  });

  test("clips long descriptions to the budget", () => {
    const long = "x".repeat(2000);
    const text =
      formatRecall({ skills: [{ name: "a", description: long }], memories: [] }, 300) ?? "";
    expect(text.length).toBeLessThan(500);
    expect(text).toContain("…");
  });
});
