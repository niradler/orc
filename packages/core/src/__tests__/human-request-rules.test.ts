import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { nativeHookQuestions, normalizeRuleHook, ruleHookOutput } from "../rule-hooks.js";
import { EventRuleSchema, RuleEventSchema, RulePolicySchema } from "../rule-types.js";
import { evaluateRules } from "../rules.js";

const base = {
  id: "ask",
  reason: "Review before execution",
  kind: "event",
  enabled: true,
  scope: { agents: ["claude"], events: ["pre_tool"] },
  filter: {
    match: "all",
    conditions: [{ predicate: { field: "tool", operator: "equals", value: "Bash" } }],
  },
  target: { type: "ask_user", kind: "approval", prompt: "May this command run?" },
};

test("should deliver a human approval using Cursor's native permission envelope", () => {
  const event = normalizeRuleHook("cursor", "preToolUse", {
    conversation_id: "cursor-session",
    tool_use_id: "cursor-call",
    cwd: tmpdir(),
    tool_name: "Shell",
    tool_input: { command: "Write-Output OK" },
  });
  const decision = evaluateRules(
    RulePolicySchema.parse({
      workspace: tmpdir(),
      project_id: null,
      rules: [
        {
          ...base,
          scope: { agents: ["cursor"], events: ["pre_tool"] },
          filter: { match: "all", conditions: [] },
        },
      ],
    }),
    event,
  );
  expect(ruleHookOutput("cursor", event, { ...decision, human_approved: true })).toEqual({
    permission: "allow",
  });
  expect(
    ruleHookOutput("cursor", event, {
      ...decision,
      human_approved: true,
      decision: "deny",
      reasons: [{ rule_id: "ask", reason: "Human denied this action" }],
    }),
  ).toEqual({
    permission: "deny",
    user_message: "ask: Human denied this action",
    agent_message: "ask: Human denied this action",
  });
});
test("should reuse event filtering and return a human action without granting permission", () => {
  const policy = RulePolicySchema.parse({ workspace: tmpdir(), project_id: null, rules: [base] });
  const event = RuleEventSchema.parse({
    id: "call",
    session_id: "session",
    backend: "claude",
    cwd: tmpdir(),
    phase: "pre_tool",
    tool: "Bash",
    input: { command: "pwd" },
  });
  const decision = evaluateRules(policy, event);
  expect(decision.human_requests?.[0]?.target.kind).toBe("approval");
  expect(ruleHookOutput("claude", event, decision)).toEqual({});
  expect(evaluateRules(policy, { ...event, tool: "Read" }).human_requests).toBeUndefined();
  expect(ruleHookOutput("claude", event, { ...decision, human_approved: true })).toEqual({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  });
  expect(
    ruleHookOutput("claude", event, {
      ...decision,
      human_approved: true,
      decision: "deny",
      reasons: [{ rule_id: "deny", reason: "Denied" }],
    }),
  ).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "deny: Denied",
    },
  });
});

test("should use the native permission decision envelope and preserve real structured hook questions", () => {
  const event = normalizeRuleHook("claude", "PermissionRequest", {
    session_id: "session",
    cwd: tmpdir(),
    tool_name: "Bash",
    tool_input: { command: "pwd" },
  });
  const decision = evaluateRules(
    RulePolicySchema.parse({
      workspace: tmpdir(),
      project_id: null,
      rules: [{ ...base, scope: { agents: ["claude"], events: ["permission_request"] } }],
    }),
    event,
  );
  expect(ruleHookOutput("claude", event, { ...decision, human_approved: true })).toEqual({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
  expect(
    ruleHookOutput("claude", event, {
      ...decision,
      decision: "deny",
      reasons: [{ rule_id: "ask", reason: "Denied" }],
    }),
  ).toEqual({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "ask: Denied" },
    },
  });
  const questions = nativeHookQuestions(
    normalizeRuleHook("claude", "PreToolUse", {
      session_id: "session",
      tool_use_id: "q",
      cwd: tmpdir(),
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which color?",
            header: "Color",
            multiSelect: true,
            options: [{ label: "Blue", description: "Color" }],
          },
        ],
      },
    }),
  );
  expect(questions[0]).toMatchObject({ id: "q-0", question: "Which color?", multiSelect: true });
});
test("should refuse Ask user on notifications and distinguish runtime questions from approvals", () => {
  expect(
    EventRuleSchema.safeParse({ ...base, scope: { agents: ["claude"], events: ["notification"] } })
      .success,
  ).toBe(false);
  expect(
    EventRuleSchema.safeParse({
      ...base,
      scope: { agents: ["claude"], events: ["runtime:permission_request"] },
    }).success,
  ).toBe(true);
  expect(
    EventRuleSchema.safeParse({
      ...base,
      scope: { agents: ["claude"], events: ["runtime:question_request"] },
    }).success,
  ).toBe(false);
  expect(
    EventRuleSchema.safeParse({
      ...base,
      scope: { agents: ["codex"], events: ["runtime:question_request"] },
      target: { type: "ask_user", kind: "question", prompt: "Question" },
    }).success,
  ).toBe(true);
  expect(
    EventRuleSchema.safeParse({
      ...base,
      scope: { agents: ["gemini"], events: ["runtime:question_request"] },
      target: { type: "ask_user", kind: "question", prompt: "Question" },
    }).success,
  ).toBe(false);
});
