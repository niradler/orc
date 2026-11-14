import { createRuleClient } from "./factory.js";
import type {
  HookDecision,
  HookRun,
  OrcRule,
  OrcRulePolicy,
  OrcRuleRevision,
  RuleGateInput,
  RulePlan,
} from "./types.js";

/** OpenCode plugin hook names; the session `context` hook only delivers queued
 * rule context and is not a rule event. OpenCode has no session start/end hooks. */
export const OPENCODE_NATIVE_PHASES = {
  "execute.before": "pre_tool",
  "execute.after": "post_tool",
  prompt: "prompt_submit",
  compaction: "pre_compact",
} as const;

export type OpenCodeNativeEvent = keyof typeof OPENCODE_NATIVE_PHASES;

export const OPENCODE_BLOCKING_EVENTS: ReadonlySet<OpenCodeNativeEvent> = new Set([
  "execute.before",
  "prompt",
]);

const client = createRuleClient<OpenCodeNativeEvent>({
  backend: "opencode",
  phases: OPENCODE_NATIVE_PHASES,
  blocking: [...OPENCODE_BLOCKING_EVENTS],
});

export const opencodeRuleClient = client;
export const rulesForCwd = client.rulesForCwd;
export const planRules = client.planRules;
export const ruleHookGate = client.gate;
export const runRuleHook = client.runHook;

export type { HookDecision, OrcRule, OrcRulePolicy, OrcRuleRevision };
export type OpenCodeRulePlan = RulePlan<OpenCodeNativeEvent>;
export type OpenCodeHookRun = HookRun<OpenCodeNativeEvent>;
export type OpenCodeRuleGate = RuleGateInput<OpenCodeNativeEvent>;
