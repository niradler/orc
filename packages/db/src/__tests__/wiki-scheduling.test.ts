import { expect, test } from "bun:test";
import { createDb, getSqlite } from "../client.js";
import { PassageIndex } from "../retrieval.js";
import { WikiStore } from "../wiki.js";

for (const older of ["evaluation", "contribution"] as const) {
  test(`should dispatch the older ${older} across both maintenance queues`, async () => {
    const sqlite = getSqlite(createDb(":memory:"));
    try {
      const wiki = new WikiStore(sqlite);
      const index = new PassageIndex(sqlite);
      index.put({
        kind: "session",
        source_id: "support",
        project_id: null,
        title: "Observed result",
        content: "Socket ownership was verified.",
        location: "test://support",
      });
      const evidence = (await index.search({ query: "ownership", project_id: null })).passages.map(
        (p) => p.id,
      );
      const proposal = wiki.propose({
        project_id: null,
        skill_name: "orc-worker-base",
        baseline_hash: "a".repeat(64),
        candidate: "---\nname: orc-worker-base\ndescription: Fixture\n---\nCheck ownership.",
        rationale: "Scheduling fixture",
        evidence,
      });
      const contribution = wiki.enqueue({
        kind: "session",
        source_id: "new-session",
        project_id: null,
        title: "New session",
        content: "A later session recorded another incident.",
        location: "test://new-session",
      });
      sqlite
        .query("UPDATE skill_proposals SET created_at=? WHERE id=?")
        .run(older === "evaluation" ? 1 : 2, proposal);
      sqlite
        .query("UPDATE wiki_contributions SET created_at=? WHERE id=?")
        .run(older === "contribution" ? 1 : 2, contribution);
      expect(wiki.schedule()).toBe(1);
      const task = sqlite
        .query<{ title: string; id: string }, []>("SELECT id,title FROM tasks")
        .get();
      expect(task?.title).toStartWith(
        older === "evaluation" ? "Evaluate skill" : "Consolidate session",
      );
      expect(wiki.schedule()).toBe(0);
      // Complete or exhaust the older item, then the other queue can proceed.
      if (older === "evaluation") {
        wiki.evaluate({
          project_id: null,
          proposal_id: proposal,
          suite: "queue-control",
          cases: [{ id: "held-out", baseline: true, candidate: true }],
          validation_passed: true,
          notes: "No measured improvement",
        });
      } else {
        wiki.apply({
          project_id: null,
          contribution_id: contribution,
          outcome: "no_change",
          summary: "Existing procedure covers this incident",
        });
      }
      expect(wiki.schedule()).toBe(1);
      const remaining = sqlite
        .query<{ title: string }, [string]>("SELECT title FROM tasks WHERE id<>?")
        .get(task?.id ?? "");
      expect(remaining?.title).toStartWith(
        older === "evaluation" ? "Consolidate session" : "Evaluate skill",
      );
      expect(() => wiki.schedule(2)).toThrow("one maintenance task");
    } finally {
      sqlite.close();
    }
  });
}
