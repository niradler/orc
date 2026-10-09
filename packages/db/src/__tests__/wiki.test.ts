import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { PassageIndex } from "../retrieval.js";
import { WikiStore } from "../wiki.js";

test("should retain idempotent contributions, source evidence, and page revisions with concurrency checks", async () => {
  const sqlite = new Database(":memory:");
  try {
    const wiki = new WikiStore(sqlite);
    const index = new PassageIndex(sqlite);
    const input = {
      kind: "session" as const,
      source_id: "session-1",
      project_id: "orc",
      title: "Socket incident",
      content:
        "Restart failed because the grandchild held the socket. Whole-tree termination succeeded.",
      location: "orc://sessions/session-1",
    };
    const id = wiki.enqueue(input);
    expect(wiki.enqueue(input)).toBe(id);
    const retrieved = await index.search({ query: "grandchild", project_id: "orc" });
    const evidence = retrieved.passages.map((passage) => passage.id);
    const edit = {
      slug: "socket-recovery",
      expected_revision: 0,
      title: "Socket recovery",
      content: "Inspect and terminate the whole process tree.",
      tags: ["Windows"],
      evidence,
      summary: "Document root cause",
    };
    wiki.apply({
      contribution_id: id,
      project_id: "orc",
      outcome: "applied",
      summary: "Documented socket incident",
      edits: [edit],
    });
    wiki.apply({
      contribution_id: id,
      project_id: "orc",
      outcome: "applied",
      summary: "Documented socket incident",
      edits: [edit],
    });
    expect(wiki.history("orc", edit.slug)).toHaveLength(1);
    const next = wiki.enqueue({
      ...input,
      content: "Second incident corroborates the same root cause.",
    });
    expect(next).not.toBe(id);
    expect(() =>
      wiki.apply({
        contribution_id: next,
        project_id: "orc",
        outcome: "applied",
        summary: "Update",
        edits: [edit],
      }),
    ).toThrow("reload");
    wiki.apply({
      contribution_id: next,
      project_id: "orc",
      outcome: "no_change",
      summary: "Existing procedure covers the evidence",
    });
    expect(wiki.contributions("orc")).toHaveLength(2);
    expect(wiki.list("other")).toEqual([]);
    expect(
      (await index.search({ query: "process tree", project_id: "orc", kinds: ["wiki"] })).passages
        .length,
    ).toBeGreaterThan(0);
  } finally {
    sqlite.close();
  }
});

describe("Skill proposal evidence and evaluation history", () => {
  test("should reject foreign evidence and retain failures, no-gain evaluations, and rejected candidates", async () => {
    const sqlite = new Database(":memory:");
    try {
      const wiki = new WikiStore(sqlite);
      wiki.enqueue({
        kind: "session",
        source_id: "s",
        project_id: "orc",
        title: "Lesson",
        content: "Verification must include process-tree ownership.",
        location: "orc://sessions/s",
      });
      const evidence = (
        await new PassageIndex(sqlite).search({ query: "verification", project_id: "orc" })
      ).passages.map((p) => p.id);
      const input = {
        project_id: "orc",
        skill_name: "orc-worker-base",
        baseline_hash: "a".repeat(64),
        candidate: "Check process-tree ownership.",
        rationale: "Avoid recurrence",
        evidence,
        training_cases: ["incident-1"],
      };
      expect(() => wiki.propose({ ...input, project_id: "other" })).toThrow("another project");
      const proposal = wiki.propose(input);
      expect(() =>
        wiki.evaluate({
          proposal_id: proposal,
          project_id: "orc",
          suite: "held-out",
          cases: [{ id: "incident-1", baseline: false, candidate: true }],
          validation_passed: true,
          notes: "",
        }),
      ).toThrow("held out");
      const noGain = wiki.evaluate({
        proposal_id: proposal,
        project_id: "orc",
        suite: "held-out",
        cases: [{ id: "new-1", baseline: true, candidate: true }],
        validation_passed: true,
        notes: "No improvement",
      });
      expect(noGain.result).toBe("no_proven_gain");
      const regression = wiki.evaluate({
        proposal_id: proposal,
        project_id: "orc",
        suite: "held-out",
        cases: [
          { id: "new-2", baseline: true, candidate: false },
          { id: "new-3", baseline: false, candidate: true },
          { id: "new-4", baseline: false, candidate: true },
        ],
        validation_passed: true,
        notes: "Net gain but regression",
      });
      expect(regression.result).toBe("no_proven_gain");
      wiki.reject(proposal, "orc", "Insufficient representative evidence");
      expect(sqlite.query("SELECT status FROM skill_proposals WHERE id=?").get(proposal)).toEqual({
        status: "rejected",
      });
      expect(
        sqlite
          .query("SELECT count(*) AS count FROM skill_evaluations WHERE proposal_id=?")
          .get(proposal),
      ).toEqual({ count: 2 });
    } finally {
      sqlite.close();
    }
  });
});
