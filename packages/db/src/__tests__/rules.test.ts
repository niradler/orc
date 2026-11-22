import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRuleStorage, RuleStore } from "../rules.js";

const root = mkdtempSync(join(tmpdir(), "orc-rules-db-"));
const db = new Database(join(root, "state.sqlite"));
db.exec(
  "CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT,command TEXT,enabled INTEGER); INSERT INTO projects VALUES ('p'); INSERT INTO jobs VALUES ('job','p','echo ok',1),('other',NULL,'echo other',1);",
);
const store = new RuleStore(db);
const policy = {
  workspace: root,
  project_id: "p",
  rules: [
    {
      id: "deny",
      kind: "event",
      enabled: true,
      reason: "No delete",
      scope: { agents: "all", events: ["pre_tool"] },
      filter: {
        match: "all",
        conditions: [{ predicate: { field: "tool", operator: "in", value: ["Bash"] } }],
      },
      target: { type: "block" },
    },
  ],
};
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("rule history and action evidence", () => {
  test("activation uses compare-and-swap and revert retains all revisions", () => {
    const first = store.activate(policy, null, "Initial policy");
    expect(() => store.activate(policy, null, "Stale update")).toThrow("reload");
    const next = store.activate(
      {
        ...policy,
        rules: [
          {
            id: "shell",
            kind: "event",
            enabled: true,
            reason: "No shell",
            scope: { agents: "all", events: ["pre_tool"] },
            filter: {
              match: "all",
              conditions: [{ predicate: { field: "tool", operator: "in", value: ["Bash"] } }],
            },
            target: { type: "block" },
          },
        ],
      },
      first.id,
      "Change",
    );
    const reverted = store.revert(next.id, "Human revert");
    expect(reverted.policy).toEqual(first.policy);
    expect(store.history().length).toBe(3);
    expect(() => store.revert(next.id, "Stale revert")).toThrow("reload");
    expect(store.history().filter((r) => r.current).length).toBe(1);
    const disabled = store.revert(reverted.id, "Restore previous revision");
    expect(disabled.policy?.rules[0]?.kind).toBe("event");
  });
  test("project and job validation rejects missing/cross-project action", () => {
    const current = store.history().find((r) => r.current);
    expect(() =>
      store.activate({ ...policy, project_id: "unknown" }, current?.id ?? null, "Invalid project"),
    ).toThrow("Unknown");
    expect(() =>
      store.activate(
        {
          ...policy,
          rules: [
            {
              id: "job",
              kind: "event",
              enabled: true,
              reason: "validate",
              scope: { agents: "all", events: ["post_tool"] },
              filter: {
                match: "all",
                conditions: [{ predicate: { field: "failed", operator: "equals", value: false } }],
              },
              target: { type: "job", job_id: "other" },
            },
          ],
        },
        current?.id ?? null,
        "Invalid job",
      ),
    ).toThrow("same project");
  });
  describe("bounded rule decision storage", () => {
    const bounded = new Database(":memory:");
    bounded.exec("PRAGMA foreign_keys=ON");
    const boundedStore = new RuleStore(bounded);
    const blockBash = {
      workspace: root,
      project_id: null,
      rules: [
        {
          id: "deny-bash",
          kind: "event" as const,
          enabled: true,
          reason: "No shell",
          scope: { agents: "all" as const, events: ["pre_tool"] },
          filter: {
            match: "all" as const,
            conditions: [
              { predicate: { field: "tool", operator: "in" as const, value: ["Bash"] } },
            ],
          },
          target: { type: "block" as const },
        },
      ],
    };
    boundedStore.activate(blockBash, null, "Bounded storage policy");
    const revision = boundedStore.history().find((row) => row.current)?.id ?? "";
    const event = (id: string, tool: string) => ({
      id,
      session_id: "bounded",
      backend: "claude",
      cwd: root,
      phase: "pre_tool",
      tool,
      input: tool === "Bash" ? { command: "echo hi" } : { file_path: join(root, "a.txt") },
    });

    test("abstains increment one counter without growing rule_decisions", () => {
      for (let index = 0; index < 5; index++) boundedStore.evaluate(event(`read-${index}`, "Read"));
      expect(bounded.query("SELECT id FROM rule_decisions").all()).toHaveLength(0);
      expect(
        bounded
          .query<{ events: number; abstains: number }, [string]>(
            "SELECT events,abstains FROM rule_counters WHERE revision_id=?",
          )
          .get(revision),
      ).toEqual({ events: 5, abstains: 5 });
    });

    test("a deny is a row and a per-rule hit", () => {
      const decision = boundedStore.evaluate(event("bash-1", "Bash"));
      expect(decision.decision).toBe("deny");
      expect(bounded.query("SELECT id FROM rule_decisions").all()).toHaveLength(1);
      expect(
        bounded
          .query<{ count: number }, [string]>(
            "SELECT count FROM rule_hits WHERE revision_id=? AND rule_id='deny-bash' AND outcome='deny'",
          )
          .get(revision)?.count,
      ).toBe(1);
      const metrics = boundedStore.metrics(root);
      expect(metrics.totals.events).toBe(6);
      expect(metrics.totals.abstains).toBe(5);
      expect(metrics.totals.denials).toBe(1);
      expect(metrics.totals.abstain_rate).toBeCloseTo(5 / 6);
    });

    test("retention skips pending actions and prunes by age and cap", () => {
      const old = boundedStore.evaluate(event("bash-old", "Bash"));
      expect(old.decision).toBe("deny");
      const oldRow = bounded.query<{ id: string }, []>("SELECT id FROM rule_decisions").get();
      if (!oldRow) throw new Error("missing decision");
      bounded.query("UPDATE rule_decisions SET created_at=? WHERE id=?").run(0, oldRow.id);
      bounded
        .query(
          "INSERT INTO rule_actions(id,decision_id,rule_id,job_id,status,created_at,updated_at) VALUES ('a',?,'deny-bash','job','pending',0,0)",
        )
        .run(oldRow.id);
      expect(pruneRuleStorage(bounded, { retentionDays: 30, maxRows: 1000, batchSize: 100 })).toBe(
        0,
      );
      expect(bounded.query("SELECT id FROM rule_decisions WHERE id=?").all(oldRow.id)).toHaveLength(
        1,
      );
      bounded.query("UPDATE rule_actions SET status='done' WHERE id='a'").run();
      expect(pruneRuleStorage(bounded, { retentionDays: 30, maxRows: 1000, batchSize: 100 })).toBe(
        1,
      );
      expect(bounded.query("SELECT id FROM rule_decisions WHERE id=?").all(oldRow.id)).toHaveLength(
        0,
      );
    });

    test("the hard cap keeps the newest rows", () => {
      const now = Date.now();
      bounded.transaction(() => {
        for (let index = 0; index < 1005; index++)
          bounded
            .query(
              "INSERT INTO rule_decisions(id,event_key,input_hash,revision_id,session_id,phase,tool,result,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            )
            .run(
              `cap-${index}`,
              `cap-key-${index}`,
              "hash",
              revision,
              "cap",
              "pre_tool",
              "Bash",
              JSON.stringify({ decision: "deny", reasons: [], context: [], jobs: [] }),
              now + index,
            );
      })();
      pruneRuleStorage(bounded, {
        retentionDays: 3650,
        maxRows: 1000,
        batchSize: 5000,
        nowMs: now + 10_000,
      });
      expect(
        bounded.query("SELECT COUNT(*) AS count FROM rule_decisions").get() as { count: number },
      ).toEqual({ count: 1000 });
    });

    test("migration folds legacy abstains once and keeps outcomes", () => {
      const legacy = new Database(":memory:");
      legacy.exec(`
      CREATE TABLE rule_revisions(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,project_id TEXT,payload TEXT,previous_id TEXT,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE rule_decisions(id TEXT PRIMARY KEY,event_key TEXT UNIQUE NOT NULL,input_hash TEXT NOT NULL,revision_id TEXT NOT NULL,phase TEXT NOT NULL,session_id TEXT NOT NULL,tool TEXT,result TEXT NOT NULL,created_at INTEGER NOT NULL);
      INSERT INTO rule_revisions VALUES ('rev','${root.replaceAll("'", "''")}',NULL,NULL,NULL,'seed',0);
      INSERT INTO rule_decisions VALUES ('abstain','k1','h','rev','pre_tool','s','Read','{"decision":"abstain","reasons":[],"context":[],"jobs":[]}',1000);
      INSERT INTO rule_decisions VALUES ('deny','k2','h','rev','pre_tool','s','Bash','{"decision":"deny","reasons":[{"rule_id":"r","reason":"no"}],"context":[],"jobs":[]}',1001);
    `);
      new RuleStore(legacy);
      expect(legacy.query("SELECT id FROM rule_decisions").all()).toHaveLength(1);
      expect(
        legacy
          .query<{ events: number; abstains: number }, []>(
            "SELECT events,abstains FROM rule_counters ORDER BY tool",
          )
          .all(),
      ).toEqual([
        { events: 1, abstains: 0 },
        { events: 1, abstains: 1 },
      ]);
      expect(legacy.query<{ count: number }, []>("SELECT count FROM rule_hits").get()?.count).toBe(
        1,
      );
      new RuleStore(legacy);
      expect(
        legacy
          .query<{ events: number; abstains: number }, []>(
            "SELECT events,abstains FROM rule_counters ORDER BY tool",
          )
          .all(),
      ).toEqual([
        { events: 1, abstains: 0 },
        { events: 1, abstains: 1 },
      ]);
      expect(legacy.query<{ count: number }, []>("SELECT count FROM rule_hits").get()?.count).toBe(
        1,
      );
      legacy.close();
    });
  });

  test("duplicate event creates one queued action, conflicting replay fails, dry-run creates none", () => {
    const current = store.history().find((r) => r.current);
    store.activate(
      {
        ...policy,
        rules: [
          {
            id: "job",
            kind: "event",
            enabled: true,
            reason: "validate",
            scope: { agents: "all", events: ["post_tool"] },
            filter: {
              match: "all",
              conditions: [
                { predicate: { field: "tool", operator: "in", value: ["Write"] } },
                { predicate: { field: "failed", operator: "equals", value: false } },
              ],
            },
            target: { type: "job", job_id: "job" },
          },
        ],
      },
      current?.id ?? null,
      "Validation job",
    );
    const event = {
      id: "tool-1",
      session_id: "s",
      backend: "claude",
      cwd: root,
      phase: "post_tool",
      tool: "Write",
      input: { content: "secret-value" },
    };
    store.evaluate(event, false);
    expect(store.actions().length).toBe(0);
    store.evaluate(event);
    store.evaluate(event);
    expect(store.actions().length).toBe(1);
    expect(store.decisions().length).toBe(1);
    expect(JSON.stringify(store.decisions())).not.toContain("secret-value");
    expect(() => store.evaluate({ ...event, input: { content: "different" } })).toThrow(
      "different input",
    );
    store.evaluate({ ...event, id: "failed", failed: true });
    expect(store.actions().length).toBe(1);
    const second = new RuleStore(db);
    expect(second.actions().length).toBe(1);
    expect(second.active(root).length).toBe(1);
  });
});
