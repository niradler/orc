import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { EvidenceSource } from "@orc/core/retrieval";
import { segmentEvidence } from "../passages.js";
import { PassageIndex } from "../retrieval.js";

function source(overrides: Partial<EvidenceSource> = {}): EvidenceSource {
  return {
    kind: "document",
    source_id: "manual",
    title: "Socket recovery",
    location: "docs/recovery.md",
    project_id: "orc",
    content:
      "# Recovery\n\nA zombie socket needs the whole child process tree stopped.\n\n## Procedure\n\n1. Inspect the command line.\n2. Stop the matching process tree.\n",
    tags: ["Windows"],
    ...overrides,
  };
}

describe("Shared passage retrieval", () => {
  test("should preserve heading context, exact offsets, and bounded oversized structures", () => {
    const input = source({
      content:
        "# Manual\n\n## Commands\n\n```powershell\n# This is code\n" +
        "command\n".repeat(100) +
        "```\n\nDone.\n",
    });
    const passages = segmentEvidence(input, 256);
    expect(passages.length).toBeGreaterThan(3);
    for (const passage of passages) {
      expect(passage.content).toBe(input.content.slice(passage.start, passage.end));
      expect(passage.content.length).toBeLessThanOrEqual(256);
      expect(passage.headings).not.toContain("This is code");
    }
    expect(passages.slice(1).every((p) => p.headings.includes("Commands"))).toBe(true);
    expect(passages.some((p) => p.structural_context === "Code block powershell")).toBe(true);
    const boundary = segmentEvidence(
      source({ content: `${"x".repeat(256)}\n${"y".repeat(256)}` }),
      256,
    );
    expect(boundary.every((p) => p.content.length <= 256)).toBe(true);
  });

  test("should deduplicate copied passages without losing distinct heading context", async () => {
    const sqlite = new Database(":memory:");
    try {
      const index = new PassageIndex(sqlite);
      const original = source({
        content: "# Recovery\n\nA zombie socket needs the whole child process tree stopped.",
      });
      index.put(original);
      index.put({ ...original, source_id: "copied-manual" });
      index.put(
        source({
          source_id: "different-context",
          content:
            "# Different procedure\n\nA zombie socket needs the whole child process tree stopped.",
        }),
      );
      const result = await index.search({ query: "zombie socket", project_id: "orc" });
      expect(result.passages).toHaveLength(2);
      expect(result.passages.some((p) => p.headings.includes("Different procedure"))).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("should retrieve current cited passages with exact metadata filtering and explicit budgets", async () => {
    const sqlite = new Database(":memory:");
    try {
      const index = new PassageIndex(sqlite);
      index.put(source());
      index.put(source({ source_id: "foreign", project_id: "other" }));
      index.put(source({ source_id: "expired", valid_until: Math.floor(Date.now() / 1000) - 1 }));
      index.put(
        source({
          source_id: "untagged",
          tags: [],
          content: "Zombie socket recovery also requires inspection.",
        }),
      );
      const result = await index.search({
        query: "zombie socket",
        project_id: "orc",
        topic_tags: ["windows"],
      });
      expect(result.capabilities.semantic).toBe("off");
      expect(result.passages.some((p) => p.source_id === "untagged")).toBe(true);
      expect(
        result.passages.every((p) => p.source_id !== "foreign" && p.source_id !== "expired"),
      ).toBe(true);
      expect(result.estimated_tokens).toBeLessThanOrEqual(2000);
      const filtered = await index.search({
        query: "zombie",
        project_id: "orc",
        tags_all: [" WINDOWS "],
      });
      expect(filtered.passages.every((p) => p.tags.includes("windows"))).toBe(true);
      const passage = result.passages[0];
      expect(passage).toBeDefined();
      expect(index.expand(passage?.id ?? "", "other")).toEqual([]);
      expect(index.expand(passage?.id ?? "", "orc").length).toBeGreaterThan(0);
      const budget = await index.search({ query: "zombie", project_id: "orc", token_budget: 64 });
      expect(budget.estimated_tokens).toBeLessThanOrEqual(64);
      index.put(source({ content: "Revised recovery: use verified process tree termination." }));
      const revised = await index.search({ query: "zombie", project_id: "orc" });
      expect(revised.passages.some((p) => p.source_id === "manual")).toBe(false);
      expect(
        sqlite
          .query("SELECT count(*) AS count FROM evidence_versions WHERE source_id='manual'")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      sqlite.close();
    }
  });

  test("should fuse explicit embeddings and retain lexical results on provider failure", async () => {
    const sqlite = new Database(":memory:");
    let failing = false;
    const provider = {
      model: "test-local-v1",
      dimensions: 2,
      async embed(texts: string[]): Promise<number[][]> {
        if (failing) throw new Error("offline");
        return texts.map(() => [1, 0]);
      },
    };
    try {
      const index = new PassageIndex(sqlite, provider);
      index.put(source());
      expect(await index.embedSource("document", "manual")).toBeGreaterThan(0);
      expect(await index.embedSource("document", "manual")).toBe(0);
      const semantic = await index.search({ query: "orphaned listener", project_id: "orc" });
      expect(semantic.capabilities.semantic).toBe("ready");
      expect(semantic.passages.length).toBeGreaterThan(0);
      failing = true;
      const degraded = await index.search({ query: "zombie socket", project_id: "orc" });
      expect(degraded.capabilities.semantic).toBe("degraded");
      expect(degraded.passages.length).toBeGreaterThan(0);
    } finally {
      sqlite.close();
    }
  });
});
