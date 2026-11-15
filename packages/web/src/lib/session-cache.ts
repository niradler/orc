import type { SessionCacheUsage } from "@orc/core/usage";
import { formatTokenCount } from "./token-count";

const count = new Intl.NumberFormat();

/**
 * One explanation shared by the header strip, the inline usage card and the
 * analytics detail, so the figure always means the same thing.
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
