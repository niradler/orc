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
const OUTCOME = {
  completed: "var(--color-series-1)",
  stopped: "var(--color-series-4)",
  failed: "var(--color-error)",
  running: "var(--color-series-3)",
} as const;

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
  const markers = compactions.flatMap((compaction) => {
    const at = compaction.recorded_at;
    const after = at && timeline.find((point) => point.recorded_at && point.recorded_at >= at);
    if (!after) return [];
    const drop =
      compaction.pre_tokens !== null && compaction.post_tokens !== null
        ? `${formatTokenCount(compaction.pre_tokens, false)} → ${formatTokenCount(compaction.post_tokens, false)}`
        : null;
    return [{ request: after.request, drop }];
  });
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
