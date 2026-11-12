import type { SessionCacheUsage } from "@orc/core/usage";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatTokenCount } from "@/lib/live-sessions";

const count = new Intl.NumberFormat();

type Point = NonNullable<SessionCacheUsage["timeline"]>[number];

export default function SessionContextChart({
  timeline,
  compactions,
}: {
  timeline: NonNullable<SessionCacheUsage["timeline"]>;
  compactions: NonNullable<SessionCacheUsage["compactions"]>;
}) {
  const markers = compactions.flatMap((compaction) => {
    const at = compaction.recorded_at;
    const after = at && timeline.find((point) => point.recorded_at && point.recorded_at >= at);
    return after ? [after.request] : [];
  });
  return (
    <figure data-testid="session-context-chart" className="w-full">
      <figcaption className="text-muted-foreground">
        Context per request
        {markers.length > 0 && " · dashed line = compacted"}
      </figcaption>
      <div className="h-36 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={timeline} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
                const point = active ? (payload?.[0]?.payload as Point | undefined) : undefined;
                if (!point) return null;
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
                      Cached {count.format(point.cached_input_tokens)}
                    </p>
                    {point.output_tokens !== null && (
                      <p className="text-muted-foreground">
                        Output {count.format(point.output_tokens)}
                      </p>
                    )}
                  </div>
                );
              }}
            />
            {markers.map((request) => (
              <ReferenceLine
                key={request}
                x={request}
                stroke="var(--color-series-2)"
                strokeDasharray="4 3"
                strokeWidth={1.5}
              />
            ))}
            <Area
              type="linear"
              dataKey="context_tokens"
              stroke="var(--color-series-1)"
              strokeWidth={2}
              fill="var(--color-series-1)"
              fillOpacity={0.15}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
