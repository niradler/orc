import { resolve, sep } from "node:path";
import { DEFAULT_HOOK_MS, HUMAN_GRACE_MS } from "./hook.js";
import type { OrcRule, OrcRuleRevision, RulePlan, RulesPlanResponse } from "./types.js";

function inside(target: string, root: string): boolean {
  const t = resolve(target).toLowerCase();
  const r = resolve(root)
    .toLowerCase()
    .replace(/[\\/]+$/, "");
  return t === r || t.startsWith(`${r}${sep}`) || t.startsWith(`${r}/`);
}

/** Map a canonical or `native:` rule event to the agent's native event name. */
export function nativeFor<Native extends string>(
  phases: Readonly<Record<Native, string>>,
  event: string,
): Native | undefined {
  if (event.startsWith("native:")) {
    const name = event.slice("native:".length);
    return name in phases ? (name as Native) : undefined;
  }
  return (Object.keys(phases) as Native[]).find((native) => phases[native] === event);
}

export function rulesForCwd(
  backend: string,
  history: readonly OrcRuleRevision[],
  cwd: string,
): OrcRule[] {
  return history
    .filter((revision) => revision.current && revision.policy && inside(cwd, revision.workspace))
    .flatMap((revision) => revision.policy?.rules ?? [])
    .filter(
      (rule) =>
        rule.enabled && (rule.scope.agents === "all" || rule.scope.agents.includes(backend)),
    );
}

export function planRules<Native extends string>(
  phases: Readonly<Record<Native, string>>,
  backend: string,
  history: readonly OrcRuleRevision[],
  cwd: string,
): RulePlan<Native> {
  const rules = rulesForCwd(backend, history, cwd);
  const events = new Set<Native>();
  const timeoutMs = new Map<Native, number>();
  for (const rule of rules) {
    for (const event of rule.scope.events) {
      const native = nativeFor(phases, event);
      if (!native) continue;
      events.add(native);
      const wait =
        rule.target.type === "ask_user"
          ? (rule.target.expires_in_seconds ?? 86_400) * 1000 + HUMAN_GRACE_MS
          : DEFAULT_HOOK_MS;
      timeoutMs.set(native, Math.max(timeoutMs.get(native) ?? 0, wait));
    }
  }
  return { events, timeoutMs, count: rules.length };
}

/**
 * Interpret a GET /rules response. A confirmed disable skips enforcement.
 * An unrecognized or possibly truncated history is not a plan: blocking
 * events fall back to the local hook (fail closed) instead of silently
 * skipping enforcement.
 */
export function planFromResponse<Native extends string>(
  phases: Readonly<Record<Native, string>>,
  backend: string,
  data: RulesPlanResponse,
  cwd: string,
): { plan: RulePlan<Native> | undefined; disabled: boolean } {
  if (data.enabled === false) return { plan: undefined, disabled: true };
  if (!Array.isArray(data.history) || data.history_truncated === true)
    return { plan: undefined, disabled: false };
  return {
    plan: planRules(phases, backend, data.history as OrcRuleRevision[], cwd),
    disabled: false,
  };
}
