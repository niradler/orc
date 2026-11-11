import { expect, test } from "bun:test";
import { normalizeRuleHook, ruleHookOutput } from "../rule-hooks.js";

test("normalizes native events without claiming a post-tool event can block execution", () => {
  for (const backend of ["claude", "cursor", "gemini"] as const) {
    const event = normalizeRuleHook(
      backend,
      backend === "gemini" ? "BeforeTool" : backend === "cursor" ? "preToolUse" : "PreToolUse",
      {
        session_id: "s",
        tool_use_id: "tool",
        cwd: process.cwd(),
        tool_name: "Bash",
        tool_input: { command: "danger" },
      },
    );
    expect(event.phase).toBe("pre_tool");
    const output = ruleHookOutput(backend, event, {
      decision: "deny",
      reasons: [{ rule_id: "guard", reason: "Denied" }],
      context: [],
      jobs: [],
    });
    expect(JSON.stringify(output)).toContain("deny");
    expect(
      ruleHookOutput(backend, event, {
        decision: "abstain",
        reasons: [],
        context: [],
        jobs: [],
      }),
    ).toEqual({});
    expect(
      ruleHookOutput(
        backend,
        { ...event, phase: "post_tool" },
        { decision: "abstain", reasons: [], context: [], jobs: [] },
      ),
    ).toEqual({});
  }
  expect(() =>
    normalizeRuleHook("cursor", "preToolUse", {
      conversation_id: "s",
      cwd: process.cwd(),
      tool_name: "Shell",
    }),
  ).toThrow("stable");
  expect(() => normalizeRuleHook("claude", "unknown", {})).toThrow("Unsupported");
});

test("normalizes Pi extension events and returns a blocking decision for tool calls", () => {
  const event = normalizeRuleHook("pi", "tool_call", {
    session_id: "s",
    tool_call_id: "call-1",
    cwd: process.cwd(),
    tool_name: "bash",
    tool_input: { command: "ssh prod" },
  });
  expect(event.phase).toBe("pre_tool");
  expect(event.input.command).toBe("ssh prod");
  const output = ruleHookOutput("pi", event, {
    decision: "deny",
    reasons: [{ rule_id: "no-ssh", reason: "No SSH from agents" }],
    context: [],
    jobs: [],
  });
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: "tool_call",
      permissionDecision: "deny",
      permissionDecisionReason: "no-ssh: No SSH from agents",
    },
  });
  const prompt = normalizeRuleHook("pi", "input", {
    session_id: "s",
    cwd: process.cwd(),
    prompt: "hello",
  });
  expect(prompt.phase).toBe("prompt_submit");
  expect(
    ruleHookOutput("pi", prompt, {
      decision: "deny",
      reasons: [{ rule_id: "r", reason: "No" }],
      context: [],
      jobs: [],
    }),
  ).toEqual({ decision: "block", reason: "r: No" });
});
