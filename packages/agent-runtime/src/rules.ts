import { loadConfig } from "@orc/core/config";
import type { RuleDecision, RuleEvent } from "@orc/core/rules";
import type { SessionOpts } from "./types.js";

export type SessionRuleGuard = { evaluate: (event: RuleEvent) => RuleDecision; context: string };

export async function sessionRules(backend: string, opts: SessionOpts): Promise<SessionOpts> {
  if (!loadConfig().rules.enabled) return opts;
  const [{ getSqlite }, { RuleStore }] = await Promise.all([
    import("@orc/db/client"),
    import("@orc/db/rules"),
  ]);
  const store = new RuleStore(getSqlite());
  const policies = store.active(opts.cwd);
  if (backend !== "claude" && !policies.length) return opts;
  if (backend !== "claude")
    throw new Error(
      `Backend ${backend} has no verified ORC rule interception; use claude or a separately validated native hook`,
    );
  return {
    ...opts,
    ruleGuard: {
      context: `ORC rules active: ${policies.map((p) => p.id).join(", ")}. Pre-tool rules apply regardless of automatic permissions.`,
      evaluate: (event) => store.evaluate({ ...event, cwd: opts.cwd }),
    },
  };
}
