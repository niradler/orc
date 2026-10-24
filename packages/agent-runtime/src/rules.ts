import { loadConfig } from "@orc/core/config";
import type { RuleDecision, RuleEvent } from "@orc/core/rules";
import type { SessionOpts } from "./types.js";

export type SessionRuleGuard = {
  evaluate: (event: RuleEvent, validation?: boolean) => RuleDecision;
  evaluateCommand?: (event: RuleEvent) => RuleDecision;
  context: string;
  builtinActions?: boolean;
  humanWaitSeconds?: number;
};

export async function sessionRules(backend: string, opts: SessionOpts): Promise<SessionOpts> {
  if (!loadConfig().rules.enabled) return opts;
  const [{ getSqlite }, { RuleStore }] = await Promise.all([
    import("@orc/db/client"),
    import("@orc/db/rules"),
  ]);
  const store = new RuleStore(getSqlite());
  const agent = backend === "claude-cli" ? "claude" : backend === "codex-cli" ? "codex" : backend;
  const policies = store
    .active(opts.cwd)
    .filter((policy) =>
      policy.policy?.rules.some(
        (rule) =>
          rule.enabled &&
          (rule.scope.agents === "all" ||
            rule.scope.agents.includes(agent as "claude" | "cursor" | "gemini" | "codex")),
      ),
    );
  if (backend !== "claude" && !policies.length) return opts;
  if (
    backend === "codex-cli" &&
    policies.every((policy) =>
      policy.policy?.rules.every(
        (rule) =>
          !rule.enabled ||
          (rule.scope.agents !== "all" && !rule.scope.agents.includes("codex")) ||
          (rule.scope.events.every((event) => event.startsWith("runtime:")) &&
            rule.target.type === "ask_user"),
      ),
    )
  )
    return { ...opts, interactive: true };
  if (backend !== "claude")
    throw new Error(
      `Backend ${backend} has no verified ORC rule interception; use claude or a separately validated native hook`,
    );
  return {
    ...opts,
    ruleGuard: {
      humanWaitSeconds: Math.max(
        0,
        ...policies.flatMap(
          (policy) =>
            policy.policy?.rules.map((rule) =>
              rule.enabled && rule.target.type === "ask_user" ? rule.target.expires_in_seconds : 0,
            ) ?? [],
        ),
      ),
      builtinActions: opts.ruleBuiltinActions !== false,
      context: `ORC rules active: ${policies.map((p) => p.id).join(", ")}. Pre-tool rules apply regardless of automatic permissions.`,
      evaluate: (event, validation) =>
        store.evaluate({ ...event, cwd: opts.cwd }, true, validation),
      evaluateCommand: (event) => store.evaluateCommand({ ...event, cwd: opts.cwd }),
    },
  };
}
