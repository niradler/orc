import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { PassageIndex } from "../retrieval.js";
import { getSkillSnapshot, revertSkill } from "../skill-evolution.js";
import { WikiStore } from "../wiki.js";

test("should reopen persisted wiki evidence, contribution history and promoted skill, then retain a human revert", async () => {
  // Retained private test artifacts; never uses the configured ORC database.
  const root = join(import.meta.dir, "../../../../../.claude/tooling/wiki-reopen");
  mkdirSync(root, { recursive: true });
  const path = join(mkdtempSync(join(root, "run-")), "wiki.db");
  let sqlite = new Database(path);
  try {
    let wiki = new WikiStore(sqlite);
    const source = {
      kind: "session" as const,
      source_id: "persisted-session",
      project_id: "orc",
      title: "Verified incident",
      content: "Whole-process-tree inspection identified socket ownership.",
      location: "orc://sessions/persisted-session",
    };
    const contribution = wiki.enqueue(source);
    const evidence = (
      await new PassageIndex(sqlite).search({ query: "ownership", project_id: "orc" })
    ).passages.map((p) => p.id);
    wiki.apply({
      contribution_id: contribution,
      project_id: "orc",
      outcome: "applied",
      summary: "Retain incident",
      edits: [
        {
          slug: "ownership",
          title: "Socket ownership",
          content: "Inspect process-tree ownership.",
          expected_revision: 0,
          tags: ["windows"],
          evidence,
          summary: "Retain evidence",
        },
      ],
    });
    const baseline = getSkillSnapshot(sqlite, "orc-worker-base", "orc");
    const proposal = wiki.propose({
      project_id: "orc",
      skill_name: "orc-worker-base",
      baseline_hash: baseline.hash,
      candidate: `${baseline.raw}\nInspect process-tree ownership.\n`,
      rationale: "Persistence mechanics test",
      evidence,
    });
    expect(
      wiki.evaluate({
        proposal_id: proposal,
        project_id: "orc",
        suite: "persistence-control",
        cases: Array.from({ length: 10 }, (_, i) => ({
          id: `case-${i}`,
          baseline: false,
          candidate: true,
        })),
        validation_passed: true,
        notes: "Controlled outcomes; no claim of agent improvement",
      }).result,
    ).toBe("activated");
    sqlite.close();
    sqlite = new Database(path);
    wiki = new WikiStore(sqlite);
    expect(wiki.enqueue(source)).toBe(contribution);
    expect(wiki.history("orc", "ownership")[0]?.evidence).toEqual(evidence);
    expect(getSkillSnapshot(sqlite, "orc-worker-base", "orc").raw).toContain(
      "Inspect process-tree ownership.",
    );
    const activation = sqlite
      .query<{ id: string }, []>("SELECT id FROM skill_activations WHERE active=1")
      .get();
    revertSkill(sqlite, activation?.id ?? "", "orc", "Human persistence check");
    sqlite.close();
    sqlite = new Database(path);
    expect(getSkillSnapshot(sqlite, "orc-worker-base", "orc").raw).toBe(baseline.raw);
    expect(sqlite.query("SELECT count(*) AS count FROM skill_activations").get()).toEqual({
      count: 2,
    });
    expect(sqlite.query("SELECT count(*) AS count FROM skill_evaluations").get()).toEqual({
      count: 1,
    });
  } finally {
    sqlite.close();
  }
});
