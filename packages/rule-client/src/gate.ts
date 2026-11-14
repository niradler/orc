import { DEFAULT_HOOK_MS } from "./hook.js";
import type { RuleGateInput } from "./types.js";

/** How often a session re-fetches the rules plan so later policy changes apply. */
export const RULES_REFRESH_MS = 30_000;

/**
 * Decide whether a native event must run the rule hook. A loaded plan selects
 * exactly its events. Without a plan (ORC offline or the fetch failed) blocking
 * events still run the hook, which evaluates the local DB and fails closed like
 * the Claude and Codex adapters; only a confirmed global disable skips them.
 */
export function ruleHookGate<Native extends string>(
  blocking: ReadonlySet<Native>,
  gate: RuleGateInput<Native>,
): { run: boolean; timeoutMs: number } {
  if (!gate.enabled) return { run: false, timeoutMs: DEFAULT_HOOK_MS };
  if (gate.plan)
    return {
      run: gate.plan.events.has(gate.native),
      timeoutMs: gate.plan.timeoutMs.get(gate.native) ?? DEFAULT_HOOK_MS,
    };
  if (gate.disabled) return { run: false, timeoutMs: DEFAULT_HOOK_MS };
  return { run: blocking.has(gate.native), timeoutMs: DEFAULT_HOOK_MS };
}
