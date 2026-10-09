import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PassageIndex } from "../retrieval.js";
import { getSkillSnapshot, readEvolvedSkill, revertSkill } from "../skill-evolution.js";
import { WikiStore } from "../wiki.js";

test("should automatically promote a validated project override and revert without modifying installed files", async () => {
  const sqlite = new Database(":memory:");
  try {
    const wiki = new WikiStore(sqlite);
    wiki.enqueue({
      kind: "session",
      source_id: "evolution-session",
      project_id: "orc",
      title: "Validation",
      content: "Process-tree ownership checks prevented repeat socket failures.",
      location: "orc://sessions/evolution-session",
    });
    const evidence = (
      await new PassageIndex(sqlite).search({ query: "ownership", project_id: "orc" })
    ).passages.map((p) => p.id);
    const baseline = getSkillSnapshot(sqlite, "orc-worker-base", "orc");
    const original = readFileSync(baseline.skill.path, "utf8");
    const candidate = `${baseline.raw}\n\nCheck process-tree ownership when restarting a service.\n`;
    const proposal = wiki.propose({
      project_id: "orc",
      skill_name: "orc-worker-base",
      baseline_hash: baseline.hash,
      candidate,
      rationale: "Repeated held-out outcomes support this procedure",
      evidence,
      training_cases: ["original-incident"],
    });
    const evaluation = wiki.evaluate({
      project_id: "orc",
      proposal_id: proposal,
      suite: "isolated-control-suite",
      cases: Array.from({ length: 10 }, (_, index) => ({
        id: `held-out-${index}`,
        baseline: index < 5,
        candidate: true,
      })),
      validation_passed: true,
      notes: "Controlled gate mechanics test, not evidence of real agent improvement",
    });
    expect(evaluation.result).toBe("activated");
    expect(readEvolvedSkill(sqlite, "orc-worker-base", "orc")).toHaveProperty(
      "content",
      expect.stringContaining("Check process-tree ownership"),
    );
    expect(getSkillSnapshot(sqlite, "orc-worker-base", "other").raw).toBe(original);
    expect(readFileSync(baseline.skill.path, "utf8")).toBe(original);
    const activation = sqlite
      .query<{ id: string }, []>("SELECT id FROM skill_activations WHERE active=1")
      .get();
    const revert = revertSkill(
      sqlite,
      activation?.id ?? "",
      "orc",
      "Human found the procedure too broad",
    );
    expect(revert).toBeTruthy();
    expect(getSkillSnapshot(sqlite, "orc-worker-base", "orc").raw).toBe(original);
    expect(() => revertSkill(sqlite, activation?.id ?? "", "orc", "stale action")).toThrow(
      "not current",
    );
    expect(sqlite.query("SELECT count(*) AS count FROM skill_activations").get()).toEqual({
      count: 2,
    });
    expect(readFileSync(baseline.skill.path, "utf8")).toBe(original);
  } finally {
    sqlite.close();
  }
});

test("should retain a passing evaluation but refuse promotion over a stale baseline", async () => {
  const sqlite = new Database(":memory:");
  try {
    const wiki = new WikiStore(sqlite);
    wiki.enqueue({
      kind: "session",
      source_id: "stale-evaluation",
      project_id: null,
      title: "Stale baseline",
      content: "Observed result",
      location: "orc://sessions/stale-evaluation",
    });
    const evidence = (
      await new PassageIndex(sqlite).search({ query: "observed", project_id: null })
    ).passages.map((p) => p.id);
    const baseline = getSkillSnapshot(sqlite, "orc-worker-base", null);
    const id = wiki.propose({
      project_id: null,
      skill_name: "orc-worker-base",
      baseline_hash: "0".repeat(64),
      candidate: `${baseline.raw}\nCheck ownership.\n`,
      rationale: "Stale baseline test",
      evidence,
    });
    const result = wiki.evaluate({
      proposal_id: id,
      project_id: null,
      suite: "control",
      cases: Array.from({ length: 10 }, (_, index) => ({
        id: `stale-${index}`,
        baseline: false,
        candidate: true,
      })),
      validation_passed: true,
      notes: "Mechanics test",
    });
    expect(result.result).toBe("activation_blocked");
    expect(getSkillSnapshot(sqlite, "orc-worker-base", null).raw).toBe(baseline.raw);
    expect(sqlite.query("SELECT count(*) AS count FROM skill_evaluations").get()).toEqual({
      count: 1,
    });
  } finally {
    sqlite.close();
  }
});
