import { expect, test } from "bun:test";
import { createRuleAdapter } from "../rule-adapter.js";
import { RULE_EVENT_ADAPTERS, type RuleHookBackend } from "../rule-events.js";
import { normalizeRuleHook, ruleHookOutput } from "../rule-hooks.js";
import type { RuleDecision } from "../rule-types.js";

const backends = Object.keys(RULE_EVENT_ADAPTERS) as RuleHookBackend[];

test("the factory builds an adapter for every supported backend", () => {
  for (const backend of backends) {
    const adapter = createRuleAdapter(backend);
    expect(adapter.backend).toBe(backend);
    expect(adapter.events).toEqual(RULE_EVENT_ADAPTERS[backend]);
    expect(adapter.capability("pre_tool")?.event).toBe("pre_tool");
  }
  expect(() => createRuleAdapter("unknown" as RuleHookBackend)).toThrow("Unsupported");
  expect(() => createRuleAdapter("constructor" as RuleHookBackend)).toThrow("Unsupported");
});

test("adapters keep native events addressable alongside canonical phases", () => {
  const claude = createRuleAdapter("claude");
  expect(claude.capability("native:PreToolUse")?.event).toBe("pre_tool");
  expect(claude.capability("native:PermissionRequest")?.block).toBe(true);
  const opencode = createRuleAdapter("opencode");
  expect(opencode.capability("native:execute.before")?.event).toBe("pre_tool");
  expect(opencode.capability("native:execute.before")?.rewrite_command).toBe(true);
  expect(opencode.capability("session_start")).toBeUndefined();
});

test("the shared pipeline matches the legacy normalize/output helpers", () => {
  const raw = {
    session_id: "s",
    tool_use_id: "tool-1",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: "ls" },
  };
  const result: RuleDecision = {
    decision: "deny",
    reasons: [{ rule_id: "guard", reason: "Denied" }],
    context: [],
    jobs: [],
  };
  for (const [backend, native] of [
    ["claude", "PreToolUse"],
    ["cursor", "preToolUse"],
    ["gemini", "BeforeTool"],
    ["codex", "PreToolUse"],
    ["pi", "tool_call"],
    ["opencode", "execute.before"],
  ] as const) {
    const adapter = createRuleAdapter(backend);
    const event = adapter.normalize(native, raw);
    expect(event).toEqual(normalizeRuleHook(backend, native, raw));
    expect(adapter.output(event, result)).toEqual(ruleHookOutput(backend, event, result));
  }
});

test("OpenCode denials use the shared hook protocol and prompts block admission", () => {
  const adapter = createRuleAdapter("opencode");
  const event = adapter.normalize("execute.before", {
    session_id: "s",
    tool_call_id: "call-1",
    cwd: process.cwd(),
    tool_name: "bash",
    tool_input: { command: "ssh prod" },
  });
  expect(event.phase).toBe("pre_tool");
  expect(event.backend).toBe("opencode");
  expect(
    adapter.output(event, {
      decision: "deny",
      reasons: [{ rule_id: "no-ssh", reason: "No SSH from agents" }],
      context: [],
      jobs: [],
    }),
  ).toEqual({
    hookSpecificOutput: {
      hookEventName: "execute.before",
      permissionDecision: "deny",
      permissionDecisionReason: "no-ssh: No SSH from agents",
    },
  });
  const prompt = adapter.normalize("prompt", {
    session_id: "s",
    cwd: process.cwd(),
    prompt: "deploy to prod",
  });
  expect(prompt.phase).toBe("prompt_submit");
  expect(
    adapter.output(prompt, {
      decision: "deny",
      reasons: [{ rule_id: "r", reason: "No" }],
      context: [],
      jobs: [],
    }),
  ).toEqual({ decision: "block", reason: "r: No" });
  expect(
    adapter.output(event, { decision: "abstain", reasons: [], context: [], jobs: [] }),
  ).toEqual({});
});

test("OpenCode tool hooks require a stable call identity", () => {
  expect(() =>
    createRuleAdapter("opencode").normalize("execute.before", {
      session_id: "s",
      cwd: process.cwd(),
      tool_name: "bash",
    }),
  ).toThrow("stable");
});
