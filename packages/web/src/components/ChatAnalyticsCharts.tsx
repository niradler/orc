import type { ChatContextAnalytics, ChatToolStat, ChatTurnStat } from "@orc/core/chat-analytics";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDuration } from "@/lib/chat-activity";
import { formatTokenCount } from "@/lib/live-sessions";

const count = new Intl.NumberFormat();

const CACHED = "var(--color-series-1)";
const FRESH = "var(--color-series-3)";
const TOOL = "var(--color-series-1)";
const FAILURE = "var(--color-error)";
const TOKEN_SERIES = {
  input: "var(--color-series-1)",
  output: "var(--color-series-2)",
  cacheRead: "var(--color-series-3)",
  cacheWrite: "var(--color-series-4)",
} as const;
const OUTCOME = {
  completed: "var(--color-series-1)",
  stopped: "var(--color-series-4)",
  interrupted: "var(--color-warning)",
  failed: "var(--color-error)",
  running: "var(--color-series-3)",
} as const;

function formatUsd(value: number | null): string {
  if (value === null) return "-";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

type ContextPoint = NonNullable<ChatContextAnalytics["usage"]["timeline"]>[number] & {
  fresh: number;
};

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="w-4"
        style={
          dashed
            ? { borderTop: `1.5px dashed ${color}` }
            : { height: 2, borderRadius: 1, background: color }
        }
      />
      {label}
    </span>
  );
}

export function ChatContextChart({ context }: { context: ChatContextAnalytics }) {
  const timeline = context.usage.timeline ?? [];
  if (timeline.length < 2) return null;
  const points = timeline.map((point) => ({
    ...point,
    fresh: Math.max(0, point.context_tokens - point.cached_input_tokens),
  }));
  const compactions = context.usage.compactions ?? [];
  // Several compactions can land on one request; the chart needs one marker.
  const markers: { request: number; drop: string | null }[] = [];
  for (const compaction of compactions) {
    const at = compaction.recorded_at;
    const after = at && timeline.find((point) => point.recorded_at && point.recorded_at >= at);
    if (!after || markers.some((marker) => marker.request === after.request)) continue;
    const drop =
      compaction.pre_tokens !== null && compaction.post_tokens !== null
        ? `${formatTokenCount(compaction.pre_tokens, false)} → ${formatTokenCount(compaction.post_tokens, false)}`
        : null;
    markers.push({ request: after.request, drop });
  }
  return (
    <figure data-testid="chat-context-chart" className="w-full">
      <figcaption className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendItem color={CACHED} label="Reused from cache" />
        <LegendItem color={FRESH} label="New input" />
        {markers.length > 0 && (
          <LegendItem color="var(--color-series-2)" label="Compacted" dashed />
        )}
      </figcaption>
      <div className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis
              dataKey="request"
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
              minTickGap={24}
            />
            <YAxis
              width={40}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatTokenCount(value, false)}
            />
            <Tooltip
              cursor={{ stroke: "var(--color-muted-foreground)" }}
              content={({ active, payload }) => {
                const point = active
                  ? (payload?.[0]?.payload as ContextPoint | undefined)
                  : undefined;
                if (!point) return null;
                const compacted = markers.find((marker) => marker.request === point.request);
                return (
                  <div className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs tabular-nums shadow-sm">
                    <p className="font-medium text-on-surface">
                      Request {count.format(point.request)}
                      {point.recorded_at && (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · {new Date(point.recorded_at).toLocaleString()}
                        </span>
                      )}
                    </p>
                    <p>Context {count.format(point.context_tokens)}</p>
                    <p className="text-muted-foreground">
                      Reused {count.format(point.cached_input_tokens)} · new{" "}
                      {count.format(point.fresh)}
                    </p>
                    {point.output_tokens !== null && (
                      <p className="text-muted-foreground">
                        Output {count.format(point.output_tokens)}
                      </p>
                    )}
                    {compacted && (
                      <p className="text-on-surface">
                        Compacted{compacted.drop && ` ${compacted.drop}`}
                      </p>
                    )}
                  </div>
                );
              }}
            />
            {markers.map((marker) => (
              <ReferenceLine
                key={marker.request}
                x={marker.request}
                label={
                  marker.drop
                    ? {
                        value: marker.drop,
                        position: "insideTopLeft",
                        fill: "var(--color-muted-foreground)",
                        fontSize: 10,
                      }
                    : undefined
                }
                stroke="var(--color-series-2)"
                strokeDasharray="4 3"
                strokeWidth={1.5}
              />
            ))}
            <Area
              type="linear"
              dataKey="cached_input_tokens"
              stackId="context"
              stroke={CACHED}
              strokeWidth={2}
              fill={CACHED}
              fillOpacity={0.18}
              isAnimationActive={false}
            />
            <Area
              type="linear"
              dataKey="fresh"
              stackId="context"
              stroke={FRESH}
              strokeWidth={2}
              fill={FRESH}
              fillOpacity={0.18}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function ChatToolChart({ tools }: { tools: ChatToolStat[] }) {
  const data = tools.slice(0, 8).map((tool) => ({ ...tool, label: tool.name }));
  if (!data.length) return null;
  return (
    <figure data-testid="chat-tool-chart" className="w-full">
      <figcaption className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendItem color={TOOL} label="Calls" />
        <LegendItem color={FAILURE} label="Failures" />
      </figcaption>
      <div className="w-full" style={{ height: Math.max(120, data.length * 34) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 12, bottom: 0, left: 0 }}
            barGap={2}
          >
            <CartesianGrid horizontal={false} stroke="var(--color-border)" />
            <XAxis
              type="number"
              allowDecimals={false}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={96}
              tick={{ fill: "var(--color-on-surface-variant)", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ fill: "var(--color-surface-high)" }}
              content={({ active, payload }) => {
                const tool = active
                  ? (payload?.[0]?.payload as ChatToolStat | undefined)
                  : undefined;
                if (!tool) return null;
                return (
                  <div className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs tabular-nums shadow-sm">
                    <p className="font-medium text-on-surface">{tool.name}</p>
                    <p>{count.format(tool.calls)} calls</p>
                    <p className="text-muted-foreground">
                      {tool.failures ? `${count.format(tool.failures)} failed` : "No failures"}
                    </p>
                  </div>
                );
              }}
            />
            <Bar dataKey="calls" fill={TOOL} radius={[0, 2, 2, 0]} isAnimationActive={false} />
            <Bar dataKey="failures" fill={FAILURE} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function ChatTurnChart({ turns }: { turns: ChatTurnStat[] }) {
  const timed = turns.filter((turn) => turn.durationMs !== null);
  if (timed.length < 2) return null;
  const average = Math.round(
    timed.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0) / timed.length,
  );
  return (
    <figure data-testid="chat-turn-chart" className="w-full">
      <figcaption className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendItem color={OUTCOME.completed} label="Completed" />
        <LegendItem color={OUTCOME.stopped} label="Stopped" />
        <LegendItem color={OUTCOME.failed} label="Failed" />
        <LegendItem color={OUTCOME.running} label="Running" />
      </figcaption>
      <div className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={timed} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis
              dataKey="index"
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
              minTickGap={24}
            />
            <YAxis
              width={40}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatDuration(value)}
            />
            <Tooltip
              cursor={{ fill: "var(--color-surface-high)" }}
              content={({ active, payload }) => {
                const turn = active
                  ? (payload?.[0]?.payload as ChatTurnStat | undefined)
                  : undefined;
                if (!turn) return null;
                return (
                  <div className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs tabular-nums shadow-sm">
                    <p className="font-medium text-on-surface">
                      Turn {count.format(turn.index)} · {turn.outcome}
                    </p>
                    <p>
                      {turn.durationMs !== null ? formatDuration(turn.durationMs) : "No timing"}
                    </p>
                    <p className="text-muted-foreground">
                      {count.format(turn.toolCalls)} tool
                      {turn.toolCalls === 1 ? "" : "s"}
                      {turn.toolFailures ? ` · ${count.format(turn.toolFailures)} failed` : ""}
                    </p>
                  </div>
                );
              }}
            />
            <ReferenceLine
              y={average}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="4 3"
              label={{
                value: `avg ${formatDuration(average)}`,
                position: "insideTopRight",
                fill: "var(--color-muted-foreground)",
                fontSize: 10,
              }}
            />
            <Bar dataKey="durationMs" isAnimationActive={false} radius={[2, 2, 0, 0]}>
              {timed.map((turn) => (
                <Cell key={turn.index} fill={OUTCOME[turn.outcome]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

type TurnTokenPoint = {
  index: number;
  model: string | null;
  usageSource: ChatTurnStat["usageSource"];
  costUsd: number | null;
  hasUsage: boolean;
  input: number;
  output: number;
  outputDirect: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export function ChatTurnTokensChart({ turns }: { turns: ChatTurnStat[] }) {
  const hasAnyUsage = turns.some((turn) => turn.usage !== null);
  if (!hasAnyUsage) return null;
  const points: TurnTokenPoint[] = turns.map((turn) => ({
    index: turn.index,
    model: turn.model,
    usageSource: turn.usageSource,
    costUsd: turn.costUsd,
    hasUsage: turn.usage !== null,
    input: turn.usage?.input ?? 0,
    output: (turn.usage?.output ?? 0) + (turn.usage?.reasoning ?? 0),
    outputDirect: turn.usage?.output ?? 0,
    reasoning: turn.usage?.reasoning ?? 0,
    cacheRead: turn.usage?.cacheRead ?? 0,
    cacheWrite: turn.usage?.cacheWrite ?? 0,
    total: turn.usage?.total ?? 0,
  }));
  return (
    <figure data-testid="chat-turn-tokens-chart" className="w-full min-w-0">
      <figcaption className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendItem color={TOKEN_SERIES.input} label="Input" />
        <LegendItem color={TOKEN_SERIES.output} label="Output" />
        <LegendItem color={TOKEN_SERIES.cacheRead} label="Cache read" />
        <LegendItem color={TOKEN_SERIES.cacheWrite} label="Cache write" />
      </figcaption>
      <div className="h-44 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis
              dataKey="index"
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
              minTickGap={20}
            />
            <YAxis
              width={40}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatTokenCount(value, false)}
            />
            <Tooltip
              cursor={{ fill: "var(--color-surface-high)" }}
              content={({ active, payload }) => {
                const point = active
                  ? (payload?.[0]?.payload as TurnTokenPoint | undefined)
                  : undefined;
                if (!point) return null;
                return (
                  <div className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs tabular-nums shadow-sm">
                    <p className="font-medium text-on-surface">
                      Turn {count.format(point.index)}
                      {point.model && (
                        <span className="font-mono font-normal text-muted-foreground">
                          {" "}
                          · {point.model}
                        </span>
                      )}
                    </p>
                    {!point.hasUsage ? (
                      <p className="text-muted-foreground">Usage unreadable for this turn</p>
                    ) : (
                      <>
                        <p>
                          Total {count.format(point.total)}
                          {point.usageSource === "estimated" ? " (estimated)" : ""}
                        </p>
                        <p className="text-muted-foreground">
                          Input {count.format(point.input)} · Output{" "}
                          {count.format(point.outputDirect)}
                          {point.reasoning > 0
                            ? ` · Reasoning ${count.format(point.reasoning)}`
                            : ""}
                        </p>
                        <p className="text-muted-foreground">
                          Cache read {count.format(point.cacheRead)} · Cache write{" "}
                          {count.format(point.cacheWrite)}
                        </p>
                        <p className="text-muted-foreground">Cost {formatUsd(point.costUsd)}</p>
                      </>
                    )}
                  </div>
                );
              }}
            />
            <Bar
              dataKey="input"
              stackId="tokens"
              fill={TOKEN_SERIES.input}
              isAnimationActive={false}
            />
            <Bar
              dataKey="output"
              stackId="tokens"
              fill={TOKEN_SERIES.output}
              isAnimationActive={false}
            />
            <Bar
              dataKey="cacheRead"
              stackId="tokens"
              fill={TOKEN_SERIES.cacheRead}
              isAnimationActive={false}
            />
            <Bar
              dataKey="cacheWrite"
              stackId="tokens"
              fill={TOKEN_SERIES.cacheWrite}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
