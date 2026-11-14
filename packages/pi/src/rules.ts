// Pi's rule client is the shared ORC adapter; this module keeps the historical
// @orc/pi surface stable for the extension and package consumers.

export { RULES_REFRESH_MS } from "@orc/rule-client/gate";
export { parseHookOutput } from "@orc/rule-client/hook";
export {
  BLOCKING_EVENTS,
  type HookDecision,
  type OrcRule,
  type OrcRulePolicy,
  type OrcRuleRevision,
  PI_NATIVE_PHASES,
  type PiHookRun as HookRun,
  type PiNativeEvent,
  type PiRuleGate as RuleGate,
  type PiRulePlan as RulePlan,
  planRules,
  ruleHookGate,
  rulesForCwd,
  runRuleHook,
} from "@orc/rule-client/pi";
export { removeRule, upsertRule } from "@orc/rule-client/policy";
