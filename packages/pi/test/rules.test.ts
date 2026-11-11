import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  type OrcRule,
  type OrcRuleRevision,
  parseHookOutput,
  planRules,
  removeRule,
  rulesForCwd,
  runRuleHook,
  upsertRule,
} from "../src/rules.js";

const root = resolve("/work/app");

function rule(overrides: Partial<OrcRule> = {}): OrcRule {
  return {
    id: "no-ssh",
    reason: "No ssh from agents",
    kind: "event",
    enabled: true,
    scope: { agents: "all", events: ["pre_tool"] },
    filter: { match: "all", conditions: [] },
    target: { type: "block" },
    ...overrides,
  };
}

function revision(rules: OrcRule[], overrides: Partial<OrcRuleRevision> = {}): OrcRuleRevision {
  return {
    id: "rev1",
    workspace: root,
    project_id: null,
    policy: { workspace: root, project_id: null, rules },
    current: true,
    ...overrides,
  };
}

describe("rulesForCwd", () => {
  test("keeps enabled current rules for Pi inside the workspace", () => {
    const history = [
      revision([
        rule(),
        rule({ id: "off", enabled: false }),
        rule({ id: "claude-only", scope: { agents: ["claude"], events: ["pre_tool"] } }),
        rule({ id: "pi-only", scope: { agents: ["pi"], events: ["pre_tool"] } }),
      ]),
      revision([rule({ id: "old" })], { id: "rev0", current: false }),
      revision([rule({ id: "elsewhere" })], { id: "rev2", workspace: resolve("/other") }),
    ];
    const ids = rulesForCwd(history, join(root, "src")).map((item) => item.id);
    expect(ids).toEqual(["no-ssh", "pi-only"]);
  });

  test("does not match a sibling folder that shares a prefix", () => {
    expect(rulesForCwd([revision([rule()])], `${root}-two`)).toEqual([]);
  });
});

describe("planRules", () => {
  test("maps ORC phases and native names to Pi events", () => {
    const plan = planRules(
      [
        revision([
          rule(),
          rule({
            id: "ctx",
            scope: { agents: "all", events: ["prompt_submit", "native:tool_result"] },
          }),
          rule({ id: "codex", scope: { agents: "all", events: ["native:PreToolUse"] } }),
        ]),
      ],
      root,
    );
    expect([...plan.events].sort()).toEqual(["input", "tool_call", "tool_result"]);
    expect(plan.count).toBe(3);
    expect(plan.timeoutMs.get("tool_call")).toBe(30_000);
  });

  test("waits for a human on ask_user targets", () => {
    const plan = planRules(
      [
        revision([
          rule({ target: { type: "ask_user", kind: "approval", expires_in_seconds: 60 } }),
        ]),
      ],
      root,
    );
    expect(plan.timeoutMs.get("tool_call")).toBe(90_000);
  });
});

describe("parseHookOutput", () => {
  test("reads a pre-tool deny", () => {
    const out = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no ssh" },
    });
    expect(parseHookOutput(out, 0)).toEqual({ block: true, reason: "no ssh" });
  });

  test("reads a block decision", () => {
    expect(parseHookOutput(JSON.stringify({ decision: "block", reason: "stop" }), 2)).toEqual({
      block: true,
      reason: "stop",
    });
  });

  test("reads context and rewritten input", () => {
    const out = JSON.stringify({
      hookSpecificOutput: { additionalContext: "be careful", updatedInput: { command: "ls" } },
    });
    expect(parseHookOutput(out, 0)).toEqual({
      block: false,
      context: "be careful",
      updatedInput: { command: "ls" },
    });
  });

  test("treats empty success as allow and failures as block", () => {
    expect(parseHookOutput("", 0)).toEqual({ block: false });
    expect(parseHookOutput("", 1).block).toBe(true);
    expect(parseHookOutput("boom", 1)).toEqual({
      block: true,
      reason: "ORC rule hook failed: boom",
    });
  });
});

describe("policy edits", () => {
  test("upsertRule replaces a rule with the same id and keeps the rest", () => {
    const current = revision([rule(), rule({ id: "other" })]).policy;
    const next = upsertRule(current, rule({ reason: "updated" }), "/ignored", "p1");
    expect(next.workspace).toBe(root);
    expect(next.rules.map((item) => [item.id, item.reason])).toEqual([
      ["other", "No ssh from agents"],
      ["no-ssh", "updated"],
    ]);
  });

  test("upsertRule starts a policy for a new workspace", () => {
    expect(upsertRule(null, rule(), root, "p1")).toEqual({
      workspace: root,
      project_id: "p1",
      rules: [rule()],
    });
  });

  test("removeRule reports a missing id", () => {
    const current = revision([rule(), rule({ id: "other" })]).policy;
    if (!current) throw new Error("policy expected");
    expect(removeRule(current, "missing")).toBeUndefined();
    expect(removeRule(current, "no-ssh")?.rules.map((item) => item.id)).toEqual(["other"]);
  });
});

describe("runRuleHook", () => {
  const base = { native: "tool_call" as const, payload: {}, cwd: process.cwd(), env: {} };

  test("fails closed when the ORC command cannot run", async () => {
    const decision = await runRuleHook({
      ...base,
      command: "porc-missing-command-xyz",
      timeoutMs: 10_000,
    });
    expect(decision.block).toBe(true);
  });

  test("fails open for non-blocking events", async () => {
    const decision = await runRuleHook({
      ...base,
      native: "tool_result",
      command: "porc-missing-command-xyz",
      timeoutMs: 10_000,
    });
    expect(decision).toEqual({ block: false });
  });
});
