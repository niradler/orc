import type { SessionCacheUsage } from "@orc/core/usage";

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
