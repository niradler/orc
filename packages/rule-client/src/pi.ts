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

export const PI_NATIVE_PHASES = {
  tool_call: "pre_tool",
  tool_result: "post_tool",
  input: "prompt_submit",
  session_start: "session_start",
  session_shutdown: "session_end",
  session_before_compact: "pre_compact",
  session_compact: "post_compact",
  agent_end: "stop",
} as const;

export type PiNativeEvent = keyof typeof PI_NATIVE_PHASES;

const client = createRuleClient<PiNativeEvent>({
  backend: "pi",
  phases: PI_NATIVE_PHASES,
  blocking: ["tool_call", "input"],
});

export const BLOCKING_EVENTS: ReadonlySet<PiNativeEvent> = client.blocking;

export const rulesForCwd = client.rulesForCwd;
export const planRules = client.planRules;
export const ruleHookGate = client.gate;
export const runRuleHook = client.runHook;

export type { HookDecision, OrcRule, OrcRulePolicy, OrcRuleRevision };
export type PiRulePlan = RulePlan<PiNativeEvent>;
export type PiHookRun = HookRun<PiNativeEvent>;
export type PiRuleGate = RuleGateInput<PiNativeEvent>;
