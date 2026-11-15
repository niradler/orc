import type { ChatAnalytics, ChatToolStat } from "@orc/core/chat-analytics";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { formatDuration } from "@/lib/chat-activity";
import { formatTokenCount } from "@/lib/live-sessions";

const ContextChart = lazy(() =>
  import("@/components/ChatAnalyticsCharts").then((module) => ({
    default: module.ChatContextChart,
  })),
);
const ToolChart = lazy(() =>
  import("@/components/ChatAnalyticsCharts").then((module) => ({
    default: module.ChatToolChart,
  })),
);
const TurnChart = lazy(() =>
  import("@/components/ChatAnalyticsCharts").then((module) => ({
    default: module.ChatTurnChart,
  })),
);
const count = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function ChatSessionAnalytics({
  threadId,
  streaming,
}: {
  threadId: string | null | undefined;
  streaming: boolean;
}) {
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: ["chat-analytics", threadId],
    queryFn: () => api.chat.analytics(threadId as string),
    enabled: !!threadId,
    staleTime: 15_000,
    refetchInterval: streaming ? 15_000 : false,
    retry: 1,
  });

  if (!threadId)
    return (
      <p className="text-sm text-muted-foreground">
        Analytics appear after you send the first message.
      </p>
    );
  if (isError)
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">Session analytics could not be loaded.</p>
        <button
          type="button"
          data-testid="chat-analytics-retry"
          className="min-h-11 text-xs text-muted-foreground underline"
          onClick={() => void refetch()}
        >
          Retry analytics
        </button>
      </div>
    );
  if (!data) return <AnalyticsSkeleton />;

  const latest = data.context?.usage.latest ?? null;
  const timeline = data.context?.usage.timeline ?? [];
  const compactions = data.context?.usage.compactions?.length ?? 0;
  const peak = timeline.reduce((highest, point) => Math.max(highest, point.context_tokens), 0);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3 className="text-sm font-medium">Session analytics</h3>
          <HelpPopover label="Session analytics" testId="chat-analytics-help">
            Counts come from this chat's stored transcript for every coding agent. Context, cache
            and compaction figures come from the agent's own session when it records them.{" "}
            {streaming
              ? "Context figures refresh while the agent works; message and tool counts update when the turn is saved."
              : "Open Analytics again after a turn to refresh."}
          </HelpPopover>
        </div>
        {isFetching && streaming && (
          <span className="text-xs text-muted-foreground" role="status">
            Refreshing…
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3">
        <AnalyticsStat testId="chat-analytics-messages" label="Messages" value={data.messages} />
        <AnalyticsStat testId="chat-analytics-turns" label="Turns" value={data.turns} />
        <AnalyticsStat
          testId="chat-analytics-tool-calls"
          label="Tool calls"
          value={data.toolCalls}
        />
        <AnalyticsStat
          testId="chat-analytics-tool-failures"
          label="Tool failures"
          value={data.toolFailures}
        />
        <AnalyticsStat
          testId="chat-analytics-context"
          label="Context now"
          value={latest ? formatTokenCount(latest.input_tokens, false) : "—"}
        />
        <AnalyticsStat
          testId="chat-analytics-compactions"
          label="Compactions"
          value={compactions}
        />
      </div>

      <section
        aria-labelledby="chat-analytics-context-heading"
        className="space-y-2 border-t border-border pt-4"
      >
        <div className="flex items-center gap-1">
          <h3 id="chat-analytics-context-heading" className="text-sm font-medium">
            Context and cache
          </h3>
          <HelpPopover label="Context and cache" testId="chat-analytics-context-help">
            Every request re-sends the whole conversation, so context totals count reused text once
            per request. Cache reuse is the share of that input the provider read from its prompt
            cache. Compaction lowers the next request and is marked on the chart.
          </HelpPopover>
        </div>
        {!data.context ? (
          <p className="text-xs text-muted-foreground">
            Context analytics start after the agent creates its native session.
          </p>
        ) : !data.context.supported ? (
          <p data-testid="chat-context-unsupported" className="text-xs text-muted-foreground">
            {data.context.reason}
          </p>
        ) : latest ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-4">
              <Metric label="Context now" value={formatTokenCount(latest.input_tokens, false)} />
              <Metric
                label="Peak context"
                value={
                  peak
                    ? formatTokenCount(peak, false)
                    : formatTokenCount(latest.input_tokens, false)
                }
              />
              <Metric
                label="Cache reuse"
                value={
                  data.context.usage.totals && data.context.usage.totals.input_tokens > 0
                    ? `${percent.format(
                        (data.context.usage.totals.cached_input_tokens /
                          data.context.usage.totals.input_tokens) *
                          100,
                      )}%`
                    : "—"
                }
              />
              <Metric
                label="Requests"
                value={
                  data.context.usage.requests === null
                    ? "—"
                    : count.format(data.context.usage.requests)
                }
              />
            </dl>
            <Suspense fallback={<div className="h-40" />}>
              <ContextChart context={data.context} />
            </Suspense>
            <TokenBreakdown analytics={data} />
            {data.context.model && (
              <p className="text-xs text-muted-foreground">
                Recorded by {data.context.backend} ·{" "}
                <span className="font-mono">{data.context.model}</span>
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            The agent has not recorded token usage for a request yet. It appears after the next
            response.
          </p>
        )}
      </section>

      <section
        aria-labelledby="chat-analytics-tools-heading"
        className="space-y-2 border-t border-border pt-4"
      >
        <div className="flex items-center gap-1">
          <h3
            id="chat-analytics-tools-heading"
            data-testid="chat-analytics-tools-heading"
            className="text-sm font-medium"
          >
            Tools
          </h3>
          <HelpPopover label="Tool analytics" testId="chat-analytics-tools-help">
            Calls and failures are counted from the activity ORC recorded for each turn. Imported
            history may not mark every failure.{" "}
            {data.tools.length > 8 ? "The chart shows the eight most used tools." : ""}
          </HelpPopover>
        </div>
        {data.tools.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tool calls recorded in this chat yet.</p>
        ) : (
          <>
            <Suspense fallback={<div className="h-32" />}>
              <ToolChart tools={data.tools} />
            </Suspense>
            <ToolTable tools={data.tools} />
            {data.toolTotal > 8 && (
              <p className="text-xs text-muted-foreground">
                + {count.format(data.toolTotal - 8)} more tools with fewer calls
                {data.toolTotal > data.tools.length
                  ? `; showing the ${count.format(data.tools.length)} most used.`
                  : "."}
              </p>
            )}
          </>
        )}
      </section>

      <section
        aria-labelledby="chat-analytics-turns-heading"
        className="space-y-2 border-t border-border pt-4"
      >
        <div className="flex items-center gap-1">
          <h3 id="chat-analytics-turns-heading" className="text-sm font-medium">
            Turns
          </h3>
          <HelpPopover label="Turn analytics" testId="chat-analytics-turns-help">
            Turn timings cover messages sent from this chat. Imported history keeps its tool calls
            but has no ORC turn timing. The chart shows the latest {data.turnTimeline.length} turns.
          </HelpPopover>
        </div>
        {data.turns === 0 ? (
          <p className="text-xs text-muted-foreground">
            Turn timings appear after a message completes in this chat.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {data.outcomes.completed > 0 && (
                <Outcome label="Completed" value={data.outcomes.completed} />
              )}
              {data.outcomes.stopped > 0 && (
                <Outcome label="Stopped" value={data.outcomes.stopped} />
              )}
              {data.outcomes.failed > 0 && <Outcome label="Failed" value={data.outcomes.failed} />}
              {data.outcomes.running > 0 && (
                <Outcome label="Running" value={data.outcomes.running} />
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-4">
              <Metric
                label="Average"
                value={
                  data.durations.averageMs === null ? "—" : formatDuration(data.durations.averageMs)
                }
              />
              <Metric
                label="Median"
                value={
                  data.durations.medianMs === null ? "—" : formatDuration(data.durations.medianMs)
                }
              />
              <Metric
                label="95th percentile"
                value={data.durations.p95Ms === null ? "—" : formatDuration(data.durations.p95Ms)}
              />
              <Metric
                label="Total time"
                value={
                  data.durations.totalMs === null ? "—" : formatDuration(data.durations.totalMs)
                }
              />
            </dl>
            <Suspense fallback={<div className="h-40" />}>
              <TurnChart turns={data.turnTimeline} />
            </Suspense>
            {data.turnTimelineTruncated && (
              <p className="text-xs text-muted-foreground">
                The chart shows the latest {data.turnTimeline.length} of {count.format(data.turns)}{" "}
                turns.
              </p>
            )}
          </div>
        )}
      </section>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border pt-3 text-xs">
        <Metric
          label="Started"
          value={data.startedAt ? new Date(data.startedAt).toLocaleString() : "—"}
        />
        <Metric
          label="Last message"
          value={data.lastActivityAt ? new Date(data.lastActivityAt).toLocaleString() : "—"}
        />
        {data.attachments > 0 && (
          <Metric label="Attachments" value={count.format(data.attachments)} />
        )}
      </dl>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div data-testid="chat-analytics-loading" className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <div key={index} className="space-y-1">
            <div className="h-5 w-12 animate-pulse rounded bg-surface-highest" />
            <div className="h-3 w-16 animate-pulse rounded bg-surface-high" />
          </div>
        ))}
      </div>
      <div className="h-40 animate-pulse rounded bg-surface-high" />
      <div className="h-32 animate-pulse rounded bg-surface-high" />
    </div>
  );
}

function AnalyticsStat({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: number | string;
}) {
  return (
    <div data-testid={testId}>
      <p className="text-lg font-medium tabular-nums">
        {typeof value === "number" ? count.format(value) : value}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function Outcome({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <span className="tabular-nums">{count.format(value)}</span> {label.toLowerCase()}
    </span>
  );
}

function TokenBreakdown({ analytics }: { analytics: ChatAnalytics }) {
  const totals = analytics.context?.usage.totals;
  if (!totals) return null;
  const rows = [
    {
      label: "Read from cache",
      value: totals.cached_input_tokens,
      color: "var(--color-series-1)",
    },
    ...(totals.cache_write_tokens !== null
      ? [
          {
            label: "Written to cache",
            value: totals.cache_write_tokens,
            color: "var(--color-series-2)",
          },
        ]
      : []),
    {
      label: "Uncached input",
      value: totals.input_tokens - totals.cached_input_tokens - (totals.cache_write_tokens ?? 0),
      color: "var(--color-series-3)",
    },
    ...(analytics.context?.usage.output_tokens !== null &&
    analytics.context?.usage.output_tokens !== undefined
      ? [
          {
            label: "Output",
            value: analytics.context.usage.output_tokens,
            color: "var(--color-series-4)",
          },
        ]
      : []),
  ];
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return (
    <div data-testid="chat-token-breakdown">
      <p className="text-xs font-medium">
        Session total {formatTokenCount(total, false)}
        {analytics.context?.usage.requests !== null &&
          analytics.context?.usage.requests !== undefined && (
            <span className="font-normal text-muted-foreground">
              {" "}
              over {count.format(analytics.context.usage.requests)} requests
            </span>
          )}
      </p>
      <div aria-hidden="true" className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full">
        {rows.map((row) => (
          <span
            key={row.label}
            style={{ width: `${total ? (row.value / total) * 100 : 0}%`, background: row.color }}
          />
        ))}
      </div>
      <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        {rows.map((row) => (
          <li key={row.label} className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ background: row.color }}
            />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</span>
            <span className="tabular-nums">{count.format(row.value)}</span>
            <span className="w-10 text-right tabular-nums text-muted-foreground">
              {total ? `${percent.format((row.value / total) * 100)}%` : "0%"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolTable({ tools }: { tools: ChatToolStat[] }) {
  return (
    <table data-testid="chat-tool-table" className="w-full text-xs tabular-nums">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="pb-1 font-normal">Tool</th>
          <th className="pb-1 text-right font-normal">Calls</th>
          <th className="pb-1 text-right font-normal">Failures</th>
          <th className="pb-1 text-right font-normal">Failed</th>
        </tr>
      </thead>
      <tbody>
        {tools.slice(0, 8).map((tool) => (
          <tr key={tool.name} className="border-t border-border/60">
            <td className="max-w-40 truncate py-1 font-mono text-[11px]" title={tool.name}>
              {tool.name}
            </td>
            <td className="py-1 text-right">{count.format(tool.calls)}</td>
            <td className={`py-1 text-right ${tool.failures ? "text-error" : ""}`}>
              {tool.failures ? count.format(tool.failures) : "—"}
            </td>
            <td className="py-1 text-right text-muted-foreground">
              {tool.calls ? `${percent.format((tool.failures / tool.calls) * 100)}%` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
