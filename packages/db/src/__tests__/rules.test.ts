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

    test("retention skips pending and running actions and prunes by age and cap", () => {
      const oldIds: string[] = [];
      for (const [name, status] of [
        ["pending", "pending"],
        ["running", "running"],
      ] as const) {
        boundedStore.evaluate(event(`bash-${name}`, "Bash"));
        const row = bounded
          .query<{ id: string }, []>("SELECT id FROM rule_decisions ORDER BY rowid DESC LIMIT 1")
          .get();
        if (!row) throw new Error("missing decision");
        bounded.query("UPDATE rule_decisions SET created_at=0 WHERE id=?").run(row.id);
        bounded
          .query(
            "INSERT INTO rule_actions(id,decision_id,rule_id,job_id,status,created_at,updated_at) VALUES (?,?,'deny-bash','job',?,0,0)",
          )
          .run(`a-${name}`, row.id, status);
        oldIds.push(row.id);
      }
      expect(pruneRuleStorage(bounded, { retentionDays: 30, maxRows: 1000, batchSize: 100 })).toBe(
        0,
      );
      for (const id of oldIds)
        expect(bounded.query("SELECT id FROM rule_decisions WHERE id=?").all(id)).toHaveLength(1);
      bounded.query("UPDATE rule_actions SET status='done'").run();
      expect(pruneRuleStorage(bounded, { retentionDays: 30, maxRows: 1000, batchSize: 100 })).toBe(
        2,
      );
      for (const id of oldIds)
        expect(bounded.query("SELECT id FROM rule_decisions WHERE id=?").all(id)).toHaveLength(0);
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

    test("migration folds legacy abstains once, keeps applied rows and command routes", () => {
      const legacy = new Database(":memory:");
      legacy.exec("PRAGMA foreign_keys=ON");
      legacy.exec(`
      CREATE TABLE rule_revisions(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,project_id TEXT,payload TEXT,previous_id TEXT,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE rule_decisions(id TEXT PRIMARY KEY,event_key TEXT UNIQUE NOT NULL,input_hash TEXT NOT NULL,revision_id TEXT NOT NULL,phase TEXT NOT NULL,session_id TEXT NOT NULL,tool TEXT,result TEXT NOT NULL,created_at INTEGER NOT NULL);
      INSERT INTO rule_revisions VALUES ('rev','${root.replaceAll("'", "''")}',NULL,NULL,NULL,'seed',0);
      INSERT INTO rule_decisions VALUES ('abstain','k1','h','rev','pre_tool','s','Read','{"decision":"abstain","reasons":[],"context":[],"jobs":[]}',1000);
      INSERT INTO rule_decisions VALUES ('deny','k2','h','rev','pre_tool','s','Bash','{"decision":"deny","reasons":[{"rule_id":"r","reason":"no"}],"context":[],"jobs":[]}',1001);
      INSERT INTO rule_decisions VALUES ('cr-rewrite','k3','h','rev','command_route','s','Bash','{"decision":"abstain","reasons":[],"context":[],"jobs":[],"command_processing":{"rule_ids":["rw"],"status":"rewritten","command_hash":"x"}}',1002);
      INSERT INTO rule_decisions VALUES ('cr-pass','k4','h','rev','command_route','s','Bash','{"decision":"abstain","reasons":[],"context":[],"jobs":[],"command_processing":{"rule_ids":["rw"],"status":"passthrough","command_hash":null}}',1003);
      INSERT INTO rule_decisions VALUES ('cr-deny','k5','h','rev','command_route','s','Bash','{"decision":"deny","reasons":[{"rule_id":"rw","reason":"bad"}],"context":[],"jobs":[],"command_processing":{"rule_ids":["rw"],"status":"denied","command_hash":null}}',1004);
      INSERT INTO rule_decisions VALUES ('malformed','k6','h','rev','command_route','s','Bash','{not json',1005);
    `);
      new RuleStore(legacy);
      expect(
        legacy.query<{ id: string }, []>("SELECT id FROM rule_decisions ORDER BY id").all(),
      ).toEqual([{ id: "cr-deny" }, { id: "cr-rewrite" }, { id: "deny" }, { id: "malformed" }]);
      expect(
        legacy
          .query<{ events: number; abstains: number }, []>(
            "SELECT events,abstains FROM rule_counters ORDER BY phase,tool",
          )
          .all(),
      ).toEqual([
        { events: 3, abstains: 1 },
        { events: 1, abstains: 0 },
        { events: 1, abstains: 1 },
      ]);
      expect(
        legacy
          .query<{ outcome: string; count: number }, []>(
            "SELECT outcome,SUM(count) AS count FROM rule_hits GROUP BY outcome ORDER BY outcome",
          )
          .all(),
      ).toEqual([
        { outcome: "deny", count: 2 },
        { outcome: "rewrite", count: 1 },
      ]);
      new RuleStore(legacy);
      expect(
        legacy
          .query<{ events: number; abstains: number }, []>(
            "SELECT events,abstains FROM rule_counters ORDER BY phase,tool",
          )
          .all(),
      ).toEqual([
        { events: 3, abstains: 1 },
        { events: 1, abstains: 0 },
        { events: 1, abstains: 1 },
      ]);
      expect(
        legacy.query<{ count: number }, []>("SELECT SUM(count) AS count FROM rule_hits").get(),
      ).toEqual({ count: 3 });
      legacy.close();
    });
  });

  describe("command route storage", () => {
    const routeDb = new Database(":memory:");
    routeDb.exec("PRAGMA foreign_keys=ON");
    const routeStore = new RuleStore(routeDb);
    const rewritePolicy = (argv: string[], rewriteExit: number[], passthroughExit: number[]) => ({
      workspace: root,
      project_id: null,
      rules: [
        {
          id: "rw",
          kind: "event" as const,
          enabled: true,
          reason: "Rewrite shell",
          scope: { agents: ["claude"] as const, events: ["pre_tool" as const] },
          filter: {
            match: "all" as const,
            conditions: [
              { predicate: { field: "tool", operator: "in" as const, value: ["Bash"] } },
            ],
          },
          target: {
            type: "rewrite_command" as const,
            argv,
            timeout_ms: 2000,
            rewrite_exit_codes: rewriteExit,
            passthrough_exit_codes: passthroughExit,
          },
        },
      ],
    });
    const applied = routeStore.activate(
      rewritePolicy([process.execPath, "-e", 'process.stdout.write("echo rewritten")'], [0], []),
      null,
      "Rewrite policy",
    );
    const command = (id: string) => ({
      id,
      session_id: "route",
      backend: "claude",
      cwd: root,
      phase: "pre_tool",
      tool: "Bash",
      input: { command: "echo original" },
    });
    const rewriteHits = () =>
      routeDb
        .query<{ count: number }, []>(
          "SELECT COALESCE(SUM(count),0) AS count FROM rule_hits WHERE outcome='rewrite'",
        )
        .get()?.count ?? 0;

    test("an applied rewrite is one command_route row and one hit", () => {
      const decision = routeStore.evaluateCommand(command("cmd-1"));
      expect(decision.updated_input?.command).toBe("echo rewritten");
      expect(
        routeDb.query("SELECT id FROM rule_decisions WHERE phase='command_route'").all(),
      ).toHaveLength(1);
      expect(rewriteHits()).toBe(1);
      routeStore.evaluateCommand(command("cmd-1"));
      expect(
        routeDb.query("SELECT id FROM rule_decisions WHERE phase='command_route'").all(),
      ).toHaveLength(1);
      expect(rewriteHits()).toBe(1);
      expect(
        routeDb
          .query<{ events: number }, []>(
            "SELECT SUM(events) AS events FROM rule_counters WHERE phase='command_route'",
          )
          .get()?.events,
      ).toBe(1);
    });

    test("a passthrough is an abstain and not a rewrite hit", () => {
      routeStore.activate(
        rewritePolicy([process.execPath, "-e", "process.exit(0)"], [2], [0]),
        applied.id,
        "Passthrough policy",
      );
      const decision = routeStore.evaluateCommand(command("cmd-2"));
      expect(decision.updated_input).toBeUndefined();
      expect(
        routeDb.query("SELECT id FROM rule_decisions WHERE phase='command_route'").all(),
      ).toHaveLength(1);
      expect(rewriteHits()).toBe(1);
      expect(
        routeDb
          .query<{ events: number; abstains: number }, []>(
            "SELECT SUM(events) AS events,SUM(abstains) AS abstains FROM rule_counters WHERE phase='command_route'",
          )
          .get(),
      ).toEqual({ events: 2, abstains: 1 });
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
