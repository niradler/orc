/** Series colors come from the design tokens; charts never hardcode a hue. */
export const SERIES_COLORS = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
] as const;

export type ChartKind = "line" | "bar" | "area";
export type ChartSeries = { name: string; values: number[] };
export type ChartRow = Record<string, string | number | null>;
export type SparklineSummary = {
  first: number;
  last: number;
  min: number;
  max: number;
  direction: "up" | "down" | "flat";
};

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

/**
 * Positional series keys. A series called "label" or "__proto__" would otherwise
 * collide with the row label or the object prototype.
 */
export function seriesKey(index: number): string {
  return `s${index}`;
}

/** One row per label; a short series leaves a gap instead of inventing a value. */
export function chartRows(labels: string[], series: ChartSeries[]): ChartRow[] {
  return labels.map((label, index) => {
    const row: ChartRow = { label };
    series.forEach((item, seriesIndex) => {
      row[seriesKey(seriesIndex)] = item.values[index] ?? null;
    });
    return row;
  });
}

export function hasChartData(labels: string[], series: ChartSeries[]): boolean {
  return labels.length > 0 && series.some((item) => item.values.length > 0);
}

/** Every series states its first and last value, so the numbers are not tooltip-only. */
export function chartSummary(input: {
  title?: string | undefined;
  kind: ChartKind;
  labels: string[];
  series: ChartSeries[];
}): string {
  const parts = [`${input.title ?? "Chart"}: ${input.kind} chart`];
  for (const item of input.series) {
    const first = item.values[0];
    const last = item.values[item.values.length - 1];
    if (first !== undefined && last !== undefined)
      parts.push(`${item.name} ${fullNumber(first)} to ${fullNumber(last)}`);
  }
  const first = input.labels[0];
  const last = input.labels[input.labels.length - 1];
  if (first !== undefined && last !== undefined) parts.push(`labels ${first} to ${last}`);
  return `${parts.join(". ")}.`;
}

/** A sparkline states its trend in text, so the shape is never the only signal. */
export function sparklineSummary(values: number[]): SparklineSummary {
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

/** "flat from 5 to 5" reads as a bug; a flat series says there was no change. */
export function sparklineDirection(summary: SparklineSummary): string {
  if (summary.direction === "flat") return `no change, ${fullNumber(summary.last)}`;
  return `${summary.direction} from ${fullNumber(summary.first)} to ${fullNumber(summary.last)}`;
}

export function sparklineRows(values: number[]): { index: number; value: number }[] {
  return values.map((value, index) => ({ index, value }));
}
