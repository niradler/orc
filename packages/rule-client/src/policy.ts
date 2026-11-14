import type { OrcRule, OrcRulePolicy } from "./types.js";

export function upsertRule(
  current: OrcRulePolicy | null,
  rule: OrcRule,
  workspace: string,
  projectId: string | null,
): OrcRulePolicy {
  const rules = (current?.rules ?? []).filter((existing) => existing.id !== rule.id);
  return {
    workspace: current?.workspace ?? workspace,
    project_id: current?.project_id ?? projectId,
    rules: [...rules, rule],
  };
}

export function removeRule(current: OrcRulePolicy, id: string): OrcRulePolicy | undefined {
  const rules = current.rules.filter((rule) => rule.id !== id);
  return rules.length === current.rules.length ? undefined : { ...current, rules };
}
