import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  type ChartKind,
  type ChartSeries,
  chartRows,
  chartSummary,
  compactNumber,
  fullNumber,
  hasChartData,
  SERIES_COLORS,
  seriesKey,
  sparklineDirection,
  sparklineRows,
  sparklineSummary,
} from "@/lib/chat-ui-chart";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const AXIS_TICK = { fill: "var(--color-muted-foreground)", fontSize: 10 } as const;
const AXIS_LINE = { stroke: "var(--color-border)" } as const;
const MARGIN = { top: 8, right: 8, bottom: 0, left: 0 } as const;

type TooltipEntry = { name?: string | number; value?: number | string; color?: string };

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="max-w-64 rounded-md border border-border bg-surface px-2 py-1.5 text-xs tabular-nums shadow-sm">
      {label !== undefined && <p className="font-medium text-on-surface">{String(label)}</p>}
      {payload.map((entry) => (
        <p key={String(entry.name)} className="flex items-center gap-1.5 text-on-surface-variant">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-sm"
            style={{ backgroundColor: entry.color }}
          />
          <span className="min-w-0 truncate">{entry.name}</span>
          <span className="ml-auto pl-2 text-on-surface">{fullNumber(Number(entry.value))}</span>
        </p>
      ))}
    </div>
  );
}

function axes() {
  return [
    <CartesianGrid key="grid" vertical={false} stroke="var(--color-border)" />,
    <XAxis
      key="x"
      dataKey="label"
      tick={AXIS_TICK}
      tickLine={false}
      axisLine={AXIS_LINE}
      minTickGap={16}
      interval="preserveStartEnd"
    />,
    <YAxis
      key="y"
      width={44}
      tick={AXIS_TICK}
      tickLine={false}
      axisLine={false}
      tickFormatter={compactNumber}
    />,
    <Tooltip
      key="tooltip"
      cursor={{ stroke: "var(--color-muted-foreground)" }}
      content={<ChartTooltip />}
    />,
  ];
}

/** Line, bar or area; the legend names every series so identity is never colour alone. */
export default function Chart({
  kind = "line",
  labels,
  series,
  title,
}: {
  kind?: ChartKind;
  labels: string[];
  series: ChartSeries[];
  title?: string;
}) {
  const reduced = useMediaQuery(REDUCED_MOTION);
  const data = chartRows(labels, series);
  if (!hasChartData(labels, series))
    return (
      <div data-testid="chat-ui-chart-empty" className="min-w-0">
        {title && <p className="mb-1 truncate text-sm font-medium text-on-surface">{title}</p>}
        <p className="rounded-md border border-outline-variant px-3 py-6 text-center text-xs text-on-surface-variant">
          No data recorded for this chart yet.
        </p>
      </div>
    );
  const summary = chartSummary({ title, kind, labels, series });
  return (
    <figure data-testid="chat-ui-chart" data-kind={kind} className="min-w-0">
      {title && (
        <figcaption className="mb-1 truncate text-sm font-medium text-on-surface">
          {title}
        </figcaption>
      )}
      <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-on-surface-variant">
        {series.map((item, index) => (
          <li key={item.name} className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-sm"
              style={{ backgroundColor: SERIES_COLORS[index] }}
            />
            <span className="truncate">{item.name}</span>
          </li>
        ))}
      </ul>
      <div className="h-56 w-full" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          {kind === "bar" ? (
            <BarChart data={data} margin={MARGIN}>
              {axes()}
              {series.map((item, index) => (
                <Bar
                  key={item.name}
                  dataKey={seriesKey(index)}
                  name={item.name}
                  fill={SERIES_COLORS[index]}
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={!reduced}
                  animationDuration={300}
                />
              ))}
            </BarChart>
          ) : kind === "area" ? (
            <AreaChart data={data} margin={MARGIN}>
              {axes()}
              {series.map((item, index) => (
                <Area
                  key={item.name}
                  type="monotone"
                  dataKey={seriesKey(index)}
                  name={item.name}
                  stroke={SERIES_COLORS[index]}
                  fill={SERIES_COLORS[index]}
                  fillOpacity={0.15}
                  strokeWidth={2}
                  isAnimationActive={!reduced}
                  animationDuration={300}
                />
              ))}
            </AreaChart>
          ) : (
            <LineChart data={data} margin={MARGIN}>
              {axes()}
              {series.map((item, index) => (
                <Line
                  key={item.name}
                  type="monotone"
                  dataKey={seriesKey(index)}
                  name={item.name}
                  stroke={SERIES_COLORS[index]}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={!reduced}
                  animationDuration={300}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/** Shape-only trend: no axes; the latest value stays in text and the range is in the label. */
export function Sparkline({ values, label }: { values: number[]; label?: string }) {
  const reduced = useMediaQuery(REDUCED_MOTION);
  const summary = sparklineSummary(values);
  const name = label ?? "Series";
  return (
    <figure data-testid="chat-ui-sparkline" className="min-w-0">
      <figcaption className="flex min-w-0 items-baseline gap-2 text-xs text-on-surface-variant">
        {label && <span className="truncate">{label}</span>}
        <span className="shrink-0 tabular-nums text-on-surface">{fullNumber(summary.last)}</span>
      </figcaption>
      <div
        className="h-8 w-40 max-w-full"
        role="img"
        aria-label={`${name}: ${sparklineDirection(summary)}, low ${fullNumber(summary.min)}, high ${fullNumber(summary.max)}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={sparklineRows(values)} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
            <XAxis dataKey="index" hide />
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip
              cursor={{ stroke: "var(--color-muted-foreground)" }}
              content={<SparklineTooltip name={name} />}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--color-series-1)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={!reduced}
              animationDuration={300}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function SparklineTooltip({
  name,
  active,
  payload,
}: {
  name: string;
  active?: boolean;
  payload?: { value?: number | string }[];
}) {
  const point = active ? payload?.[0] : undefined;
  if (!point) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-2 py-1 text-xs tabular-nums shadow-sm">
      <span className="text-on-surface-variant">{name} </span>
      <span className="text-on-surface">{fullNumber(Number(point.value))}</span>
    </div>
  );
}
