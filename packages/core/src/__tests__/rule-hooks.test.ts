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
      ruleHookOutput(backend, event, { decision: "abstain", reasons: [], context: [], jobs: [] }),
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
