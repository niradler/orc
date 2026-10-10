import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleStore } from "../rules.js";

const root = mkdtempSync(join(tmpdir(), "orc-rules-db-"));
const db = new Database(join(root, "state.sqlite"));
db.exec(
  "CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT,command TEXT,enabled INTEGER); INSERT INTO projects VALUES ('p'); INSERT INTO jobs VALUES ('job','p','echo ok',1),('other',NULL,'echo other',1);",
);
const store = new RuleStore(db);
const policy = {
  workspace: root,
  project_id: "p",
  rules: [{ id: "deny", kind: "deny_delete", reason: "No delete" }],
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
        rules: [{ id: "shell", kind: "deny_tools", tools: ["Bash"], reason: "No shell" }],
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
    expect(disabled.policy?.rules[0]?.kind).toBe("deny_tools");
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
              kind: "enqueue_job",
              event: "post_tool",
              tools: [],
              job_id: "other",
              reason: "validate",
            },
          ],
        },
        current?.id ?? null,
        "Invalid job",
      ),
    ).toThrow("same project");
  });
  test("duplicate event creates one queued action, conflicting replay fails, dry-run creates none", () => {
    const current = store.history().find((r) => r.current);
    store.activate(
      {
        ...policy,
        rules: [
          {
            id: "job",
            kind: "enqueue_job",
            event: "post_tool",
            tools: ["Write"],
            job_id: "job",
            reason: "validate",
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
