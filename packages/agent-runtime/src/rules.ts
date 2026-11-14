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

/**
 * A protected workspace the selected backend cannot enforce. The session still
 * starts, but ORC reports that rules are advisory for it instead of failing closed.
 */
export type RuleGap = {
  backend: string;
  agent: string;
  /** Active policies that apply to the session folder. */
  policies: string[];
  reason: "no_blocking_pre_tool_hook" | "evaluation_unavailable";
  message: string;
};

function gapMessage(agent: string): string {
  return `${agent} has no blocking pre-tool hook in ORC, so active workspace rules cannot be enforced in this session. ORC still shows the agent's tool activity, but it cannot block or rewrite it. Use Claude when a session must be enforced.`;
}

export async function sessionRules(backend: string, opts: SessionOpts): Promise<SessionOpts> {
  if (!loadConfig().rules.enabled) return opts;
  const [{ getSqlite }, { RuleStore }] = await Promise.all([
    import("@orc/db/client"),
    import("@orc/db/rules"),
  ]);
  const store = new RuleStore(getSqlite());
  const agent =
    backend === "acp"
      ? (opts.acpAgent ?? opts.acpxAgent ?? backend)
      : backend === "claude-cli"
        ? "claude"
        : backend === "codex-cli"
          ? "codex"
          : backend;
  const matching = () =>
    store
      .active(opts.cwd)
      .filter((policy) =>
        policy.policy?.rules.some(
          (rule) =>
            rule.enabled &&
            (rule.scope.agents === "all" ||
              rule.scope.agents.includes(agent as "claude" | "cursor" | "gemini" | "codex")),
        ),
      );
  if (backend !== "claude") {
    let policies: ReturnType<typeof matching>;
    try {
      policies = matching();
    } catch (error) {
      return {
        ...opts,
        ruleGap: {
          backend,
          agent,
          policies: [],
          reason: "evaluation_unavailable",
          message: `ORC could not read the workspace rules (${error instanceof Error ? error.message : "storage unavailable"}), so this session runs without rule enforcement.`,
        },
      };
    }
    if (!policies.length) return opts;
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
    return {
      ...opts,
      ruleGap: {
        backend,
        agent,
        policies: policies.map((policy) => policy.id),
        reason: "no_blocking_pre_tool_hook",
        message: `Workspace rules are active here, but ${gapMessage(agent)}`,
      },
    };
  }
  const policies = matching();
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
