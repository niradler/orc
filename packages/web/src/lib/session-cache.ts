import { agentLabel, compactionPolicy } from "@orc/core/coding-agents";
import type { SessionCacheUsage } from "@orc/core/usage";
import { formatTokenCount } from "./token-count";

const count = new Intl.NumberFormat();

/**
 * Large enough that agents commonly start compacting around here. It is a size,
 * never a share of a window: ORC does not know the model's context window.
 */
export const CONTEXT_HINT_TOKENS = 150_000;

export type ChatContextHint = {
  /** The quiet composer line. */
  text: string;
  /** Full context for the shared help popover. */
  explanation: string;
  note: string;
};

/**
 * Copy for the composer's large-context hint. The agent's own capability map
 * decides the wording, so the hint never claims control ORC does not have.
 */
export function chatContextHint(
  latest: SessionCacheUsage["latest"] | null | undefined,
  agent: string,
): ChatContextHint | null {
  if (!latest || latest.input_tokens < CONTEXT_HINT_TOKENS) return null;
  const policy = compactionPolicy(agent);
  const label = agentLabel(agent);
  const automatic =
    policy.automatic === "configurable" && policy.setting
      ? `${label} compacts automatically (${policy.setting})`
      : policy.automatic === "agent"
        ? `${label} compacts automatically on its own`
        : `ORC does not know when ${label} compacts`;
  return {
    text: [
      `${formatTokenCount(latest.input_tokens, false)} tokens of context`,
      automatic,
      policy.manual ? "Compact summarizes now" : "no manual compaction in ORC",
    ].join(" · "),
    explanation: `The latest request carried ${count.format(latest.input_tokens)} tokens of context: the conversation the agent re-sends with every request. ORC does not know this model's context window, so this is a size rather than a percentage.`,
    note: `${
      policy.automatic === "configurable" && policy.setting
        ? `Automatic compaction is controlled by the ${policy.setting} agent option.`
        : policy.automatic === "agent"
          ? `${label} decides when to compact internally.`
          : `${label} does not expose its compaction policy to ORC.`
    }${
      policy.manual
        ? " Compact in the session actions summarizes the conversation now; it runs when the session is idle."
        : " Manual compaction is not available for this agent."
    }`,
  };
}

/**
 * One explanation shared by the header strip and the inline usage card, so the
 * figure always means the same thing.
 */
export function contextUsageHelp(
  tokens: number,
  percent: number,
  compactions: number,
): { explanation: string; note: string } {
  return {
    explanation: `Context is the conversation the agent re-sends with every request. The latest request carried ${formatTokenCount(tokens, false)} tokens (${count.format(tokens)}), and ${percent}% came from the provider's cache, so only the rest was new input.`,
    note: `${
      compactions > 0
        ? `${compactions} ${compactions === 1 ? "compaction has" : "compactions have"} summarized this session's context; each appears as a divider in the conversation.`
        : "Context compaction summarizes the conversation to free context; a recorded compaction appears as a divider."
    } Figures appear only when the agent records usage for this session.`,
  };
}

export function sessionCacheIndicator(
  latest: SessionCacheUsage["latest"],
  now: number,
): { label: string; cold: boolean } | null {
  if (!latest || latest.input_tokens === 0) return null;
  const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    (latest.cached_input_tokens / latest.input_tokens) * 100,
  );
  const cold = latest.may_be_cold_after !== null && now >= Date.parse(latest.may_be_cold_after);
  return {
    label: cold
      ? `Cache may need rebuilding · ${percent}% last reported`
      : `${percent}% cached input`,
    cold,
  };
}
