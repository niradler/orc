import { expect, test } from "bun:test";
import { copyRuleTemplate, RULE_CATALOG } from "../rule-catalog.js";
import { EventRuleSchema, RuleEventSchema } from "../rule-types.js";
import { evaluateRules } from "../rules.js";

test("should provide valid independent reusable rule drafts", () => {
  for (const entry of RULE_CATALOG)
    expect(EventRuleSchema.safeParse(entry.rule).success).toBe(true);
  const copy = copyRuleTemplate("rtk-git");
  copy.reason = "My own rule";
  expect(RULE_CATALOG.find((entry) => entry.id === "rtk-git")?.rule.reason).not.toBe(copy.reason);
  expect(() => copyRuleTemplate("unknown")).toThrow("Unknown");
});

test("should route only intended commands and keep Git and test templates disjoint", () => {
  const policy = {
    workspace: process.cwd(),
    project_id: null,
    rules: [copyRuleTemplate("rtk-git"), copyRuleTemplate("rtk-tests")],
  };
  for (const [command, expected] of [
    ["git status", "rtk-git"],
    ["bun test", "rtk-tests"],
    ["git push", undefined],
    ["bun install", undefined],
  ] as const) {
    const result = evaluateRules(
      policy,
      RuleEventSchema.parse({
        id: "event",
        session_id: "s",
        backend: "claude",
        cwd: process.cwd(),
        phase: "pre_tool",
        tool: "Bash",
        input: { command },
      }),
    );
    expect(result.command_processors?.[0]?.rule_id).toBe(expected);
    expect((result.command_processors ?? []).length).toBe(expected ? 1 : 0);
  }
});
