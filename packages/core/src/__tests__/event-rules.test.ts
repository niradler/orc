import { expect, test } from "bun:test";
import { matchesRuleFilter, RuleFilterSchema } from "../rule-filters.js";
import { normalizeRuleHook, ruleHookOutput } from "../rule-hooks.js";
import { EventRuleSchema, RulePolicySchema } from "../rule-types.js";
import { evaluateRules } from "../rules.js";

const rule = {
  id: "shell-policy",
  reason: "Destructive command",
  kind: "event",
  enabled: true,
  scope: { agents: "all", events: ["pre_tool"] },
  filter: {
    match: "all",
    conditions: [
      { predicate: { field: "input.command", operator: "regex", value: "\\brm\\s+-rf\\b" } },
    ],
  },
  target: { type: "block" },
};

test("should apply the same regex to every native agent before execution while allowing an ordinary command", () => {
  const policy = RulePolicySchema.parse({
    workspace: process.cwd(),
    project_id: null,
    rules: [rule],
  });
  for (const [backend, native] of [
    ["claude", "PreToolUse"],
    ["cursor", "preToolUse"],
    ["gemini", "BeforeTool"],
    ["codex", "PreToolUse"],
  ] as const) {
    const event = normalizeRuleHook(backend, native, {
      session_id: "session",
      tool_use_id: "tool",
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
    });
    const denied = evaluateRules(policy, event);
    expect(denied.decision).toBe("deny");
    expect(JSON.stringify(ruleHookOutput(backend, event, denied))).toContain("deny");
    const allowed = evaluateRules(policy, { ...event, input: { command: "bun test" } });
    expect(allowed.decision).toBe("abstain");
    expect(ruleHookOutput(backend, event, allowed)).toEqual({});
  }
});

test("should share filters across targets, honor disabled/specific scopes, and preserve prompt payloads", () => {
  const event = normalizeRuleHook("claude", "UserPromptSubmit", {
    session_id: "s",
    cwd: process.cwd(),
    prompt: "Inspect this change",
    event_id: "prompt-1",
  });
  const base = {
    ...rule,
    scope: { agents: ["claude"], events: ["prompt_submit"] },
    filter: {
      match: "all",
      conditions: [
        { predicate: { field: "payload.prompt", operator: "contains", value: "Inspect" } },
      ],
    },
  };
  const evaluate = (target: unknown, enabled = true) =>
    evaluateRules(
      RulePolicySchema.parse({
        workspace: process.cwd(),
        project_id: null,
        rules: [{ ...base, enabled, target }],
      }),
      event,
    );
  expect(evaluate({ type: "inject_context", content: "Check imports" }).context).toEqual([
    "Check imports",
  ]);
  expect(evaluate({ type: "job", job_id: "lint" }).jobs).toEqual([
    { rule_id: rule.id, job_id: "lint" },
  ]);
  expect(
    evaluate({ type: "script", mode: "background", argv: ["bun", "lint.ts"], timeout_ms: 1000 })
      .scripts?.length,
  ).toBe(1);
  expect(evaluate({ type: "block" }, false).decision).toBe("abstain");
  const specific = RulePolicySchema.parse({
    workspace: process.cwd(),
    project_id: null,
    rules: [{ ...rule, scope: { agents: ["claude"], events: ["pre_tool"] } }],
  });
  expect(
    evaluateRules(specific, {
      ...event,
      backend: "codex",
      phase: "pre_tool",
      input: { command: "rm -rf build" },
    }).decision,
  ).toBe("abstain");
  expect(
    EventRuleSchema.safeParse({ ...rule, scope: { agents: "all", events: ["post_tool"] } }).success,
  ).toBe(false);
  expect(
    EventRuleSchema.safeParse({ ...rule, scope: { agents: "all", events: ["native:PreToolUse"] } })
      .success,
  ).toBe(false);
  for (const event of ["notification", "setup"]) {
    expect(
      EventRuleSchema.safeParse({
        ...rule,
        scope: { agents: ["claude"], events: [event] },
        target: { type: "inject_context", content: "Unsupported delivery" },
      }).success,
    ).toBe(false);
  }
});

test("should compose AND/OR/NOT and handle missing and typed fields without prototype traversal", () => {
  const filter = RuleFilterSchema.parse({
    match: "all",
    conditions: [
      {
        predicate: {
          field: "input.path",
          operator: "starts_with",
          value: "SRC/",
          ignore_case: true,
        },
      },
      {
        predicate: { field: "input.path", operator: "ends_with", value: ".test.ts" },
        negate: true,
      },
      { predicate: { field: "failed", operator: "in", value: [false] } },
    ],
  });
  expect(matchesRuleFilter(filter, { input: { path: "src/main.ts" }, failed: false })).toBe(true);
  expect(matchesRuleFilter(filter, { input: { path: "src/main.test.ts" }, failed: false })).toBe(
    false,
  );
  expect(matchesRuleFilter(filter, { input: {}, failed: false })).toBe(false);
  expect(matchesRuleFilter({ ...filter, match: "any" }, { input: {}, failed: false })).toBe(true);
  expect(
    RuleFilterSchema.safeParse({
      match: "all",
      conditions: [{ predicate: { field: "input.__proto__.secret", operator: "exists" } }],
    }).success,
  ).toBe(false);
});

test("should evaluate a pathological backtracking pattern within bounded time and reject unsupported regex syntax", () => {
  const filter = RuleFilterSchema.parse({
    match: "all",
    conditions: [{ predicate: { field: "input.command", operator: "regex", value: "(a+)+$" } }],
  });
  const start = performance.now();
  expect(matchesRuleFilter(filter, { input: { command: `${"a".repeat(100000)}!` } })).toBe(false);
  expect(performance.now() - start).toBeLessThan(1500);
  expect(
    RuleFilterSchema.safeParse({
      match: "all",
      conditions: [{ predicate: { field: "tool", operator: "regex", value: "(?=Bash)" } }],
    }).success,
  ).toBe(false);
});
