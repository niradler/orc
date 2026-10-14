import { expect, test } from "bun:test";
import { processRuleCommand, runCommandProcessor } from "../rule-command.js";
import { ruleHookOutput } from "../rule-hooks.js";
import { RuleCommandProcessorSchema, type RuleEvent, RulePolicySchema } from "../rule-types.js";

const event: RuleEvent = {
  id: "tool-1",
  session_id: "session",
  backend: "claude",
  phase: "pre_tool",
  native_event: "PreToolUse",
  cwd: process.cwd(),
  tool: "Bash",
  input: { command: "git status", timeout: 7000 },
  failed: false,
};
const processor = (code: string) =>
  RuleCommandProcessorSchema.parse({
    type: "rewrite_command",
    argv: [process.execPath, "-e", code || "void 0", "{command}"],
    timeout_ms: 1000,
  });
const decision = (target = processor("console.log('rtk git status')")) => ({
  decision: "abstain" as const,
  reasons: [],
  jobs: [],
  context: [],
  command_processors: [{ rule_id: "route", target }],
});

test("should pass command as one literal argument and stdin JSON to any processor without executing it", () => {
  const input = `printf 'literal'; echo $(never-run) & "quoted"`;
  const target = processor(
    "const e=JSON.parse(await Bun.stdin.text());if(e.input.command!==process.argv.at(-1))process.exit(2); console.log(e.input.command)",
  );
  expect(runCommandProcessor(target, { ...event, input: { command: input } })).toBe(input);
});

test("should deliver checked replacement input without auto-allowing or changing other tool fields", () => {
  let received: RuleEvent | undefined;
  const routed = processRuleCommand(event, decision(), (replacement) => {
    received = replacement;
    return { decision: "abstain", reasons: [], context: [], jobs: [] };
  });
  expect(received?.input).toEqual({ command: "rtk git status", timeout: 7000 });
  const output = ruleHookOutput("claude", event, routed);
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: "rtk git status", timeout: 7000 },
    },
  });
  expect(JSON.stringify(output)).not.toContain("permissionDecision");
});

test("should skip processors on original deny and reject ambiguous routing or replacement deny", () => {
  const denied = { ...decision(), decision: "deny" as const };
  expect(
    processRuleCommand(event, denied, () => {
      throw new Error("must not run");
    }),
  ).toBe(denied);
  expect(
    processRuleCommand(
      event,
      {
        ...decision(),
        command_processors: [...decision().command_processors, ...decision().command_processors],
      },
      () => {
        throw new Error("must not run");
      },
    ).decision,
  ).toBe("deny");
  const blocked = processRuleCommand(event, decision(), () => ({
    decision: "deny",
    reasons: [{ rule_id: "guard", reason: "Replacement blocked" }],
    context: [],
    jobs: [],
  }));
  expect(blocked.decision).toBe("deny");
  expect(blocked.updated_input).toBeUndefined();
  expect(JSON.stringify(ruleHookOutput("claude", event, blocked))).not.toContain("updatedInput");
});

test("should honor explicit rewrite and empty-output passthrough exit mappings", () => {
  const target = {
    ...processor("console.log('rtk git status');process.exit(3)"),
    rewrite_exit_codes: [0, 3],
    passthrough_exit_codes: [1],
  };
  expect(runCommandProcessor(target, event)).toBe("rtk git status");
  expect(
    runCommandProcessor({ ...target, argv: [process.execPath, "-e", "process.exit(1)"] }, event),
  ).toBeNull();
  expect(() =>
    runCommandProcessor(
      { ...target, argv: [process.execPath, "-e", "console.log('bad');process.exit(1)"] },
      event,
    ),
  ).toThrow("Passthrough");
  expect(() =>
    runCommandProcessor({ ...target, argv: [process.execPath, "-e", "process.exit(2)"] }, event),
  ).toThrow("unsupported");
});

test("should fail closed on missing executable, timeout, blank or oversized output, and unsupported tools", () => {
  for (const code of [
    "await Bun.sleep(10000)",
    "",
    "console.log('x'.repeat(100000))",
    "console.log('a\\0b')",
  ]) {
    expect(
      processRuleCommand(event, decision({ ...processor(code), timeout_ms: 100 }), () => ({
        decision: "abstain",
        reasons: [],
        context: [],
        jobs: [],
      })).decision,
    ).toBe("deny");
  }
  expect(() =>
    runCommandProcessor({ ...processor(""), argv: ["orc-absent-command-processor"] }, event),
  ).toThrow();
  expect(() =>
    runCommandProcessor(processor("console.log('valid')"), { ...event, tool: "Write" }),
  ).toThrow("Bash");
});

test("should validate processor configuration and refuse hosts without qualified rewrite support", () => {
  expect(
    RuleCommandProcessorSchema.safeParse({ ...processor(""), argv: ["rtk", "prefix {command}"] })
      .success,
  ).toBe(false);
  expect(
    RuleCommandProcessorSchema.safeParse({ ...processor(""), passthrough_exit_codes: [0] }).success,
  ).toBe(false);
  for (const agents of ["all", ["codex"], ["cursor"], ["gemini"]]) {
    expect(
      RulePolicySchema.safeParse({
        workspace: process.cwd(),
        project_id: null,
        rules: [
          {
            id: "route",
            reason: "route",
            kind: "event",
            enabled: true,
            scope: { agents, events: ["pre_tool"] },
            filter: { match: "all", conditions: [] },
            target: processor(""),
          },
        ],
      }).success,
    ).toBe(false);
  }
});

test("should support many mutually exclusive processors without summing all their timeouts", () => {
  expect(
    RulePolicySchema.safeParse({
      workspace: process.cwd(),
      project_id: null,
      rules: Array.from({ length: 20 }, (_, index) => ({
        id: `route-${index}`,
        reason: "route",
        kind: "event",
        enabled: true,
        scope: { agents: ["claude"], events: ["pre_tool"] },
        filter: {
          match: "all",
          conditions: [
            {
              predicate: { field: "input.command", operator: "equals", value: `command-${index}` },
            },
          ],
        },
        target: processor("console.log('replacement')"),
      })),
    }).success,
  ).toBe(true);
});

test("should preserve normal execution for explicit passthrough and reject failed replacement validation", () => {
  const passthrough = { ...processor("process.exit(4)"), passthrough_exit_codes: [4] };
  const result = decision(passthrough);
  expect(
    processRuleCommand(event, result, () => {
      throw new Error("must not validate passthrough");
    }),
  ).toBe(result);
  const failed = processRuleCommand(event, decision(), () => {
    throw new Error("unavailable");
  });
  expect(failed.decision).toBe("deny");
  expect(failed.updated_input).toBeUndefined();
});
