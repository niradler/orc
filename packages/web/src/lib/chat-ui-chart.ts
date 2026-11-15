/** Series colors come from the design tokens; charts never hardcode a hue. */
export const SERIES_COLORS = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
] as const;

export type ChartSeries = { name: string; values: number[] };
export type ChartRow = Record<string, string | number | null>;

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const count = new Intl.NumberFormat();

export function compactNumber(value: number): string {
  return compact.format(value);
}

export function fullNumber(value: number): string {
  return count.format(value);
}

/** One row per label; a short series leaves a gap instead of inventing a value. */
export function chartRows(labels: string[], series: ChartSeries[]): ChartRow[] {
  return labels.map((label, index) => {
    const row: ChartRow = { label };
    for (const item of series) row[item.name] = item.values[index] ?? null;
    return row;
  });
}

export function hasChartData(labels: string[], series: ChartSeries[]): boolean {
  return labels.length > 0 && series.some((item) => item.values.length > 0);
}

/** A sparkline states its range in text, so the trend is never shape alone. */
export function sparklineSummary(values: number[]): {
  first: number;
  last: number;
  min: number;
  max: number;
  direction: "up" | "down" | "flat";
} {
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  return {
    first,
    last,
    min: Math.min(...values),
    max: Math.max(...values),
    direction: last > first ? "up" : last < first ? "down" : "flat",
  };
}

export function sparklineRows(values: number[]): { index: number; value: number }[] {
  return values.map((value, index) => ({ index, value }));
}
