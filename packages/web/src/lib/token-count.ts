/** Short token figures for compact rows and help text; keeps 1.2M / 120k / 640 readable. */
export function formatTokenCount(n: number, estimated: boolean): string {
  const text =
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1000
        ? `${Math.round(n / 1000)}k`
        : `${n}`;
  return estimated ? `~${text}` : text;
}
