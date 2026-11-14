import { ruleHookGate } from "./gate.js";
import { runRuleHook } from "./hook.js";
import { planRules, rulesForCwd } from "./plan.js";
import type {
  HookDecision,
  HookRun,
  OrcRule,
  OrcRuleRevision,
  RuleGateInput,
  RulePlan,
} from "./types.js";

export type RuleClientSpec<Native extends string> = {
  backend: string;
  /** Native agent event name → canonical ORC phase. */
  phases: Readonly<Record<Native, string>>;
  /** Native events that fail closed when the hook cannot produce a decision. */
  blocking: readonly Native[];
};

export type RuleClient<Native extends string> = {
  readonly backend: string;
  readonly phases: Readonly<Record<Native, string>>;
  readonly blocking: ReadonlySet<Native>;
  rulesForCwd(history: readonly OrcRuleRevision[], cwd: string): OrcRule[];
  planRules(history: readonly OrcRuleRevision[], cwd: string): RulePlan<Native>;
  gate(input: RuleGateInput<Native>): { run: boolean; timeoutMs: number };
  runHook(run: HookRun<Native>): Promise<HookDecision>;
};

/**
 * Build the agent-side rule adapter from a native event map. All evaluation
 * stays in `orc rules hook <backend>`; the client only plans, gates and
 * transports, so every agent shares the same fail-closed behavior.
 */
export function createRuleClient<Native extends string>(
  spec: RuleClientSpec<Native>,
): RuleClient<Native> {
  const blocking = new Set<Native>(spec.blocking);
  return {
    backend: spec.backend,
    phases: spec.phases,
    blocking,
    rulesForCwd: (history, cwd) => rulesForCwd(spec.backend, history, cwd),
    planRules: (history, cwd) => planRules(spec.phases, spec.backend, history, cwd),
    gate: (input) => ruleHookGate(blocking, input),
    runHook: (run) => runRuleHook(spec.backend, blocking.has(run.native), run),
  };
}
