import {
  type ChatModelUsageStat,
  type ChatSkillStat,
  type ChatToolStat,
  type ChatTurnStat,
  EMPTY_CHAT_USAGE_SUMMARY,
} from "@orc/core/chat-analytics";
import type { SessionCacheUsage } from "@orc/core/usage";
import { useQuery } from "@tanstack/react-query";
import { lazy, type ReactNode, Suspense, useEffect, useRef } from "react";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { formatDuration } from "@/lib/chat-activity";
import { formatTokenCount } from "@/lib/live-sessions";
import { cn } from "@/lib/utils";

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
const TurnTokensChart = lazy(() =>
  import("@/components/ChatAnalyticsCharts").then((module) => ({
    default: module.ChatTurnTokensChart,
  })),
);

const count = new Intl.NumberFormat();
const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function formatUsd(value: number | null): string {
  if (value === null) return "-";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTurnStart(startedAt: number): string {
  return new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function UnpricedHelp({ testId }: { testId: string }) {
  return (
    <span className="-my-2 inline-flex items-center">
      <HelpPopover label="Unpriced model" testId={testId}>
        No price configured for this model. Add one in Settings -&gt; Usage.
      </HelpPopover>
    </span>
  );
}

export function ChatSessionAnalytics({
  threadId,
  sessionId,
  streaming,
  hideOnError = false,
  focusModel = null,
}: {
  threadId?: string | null;
  sessionId?: string | null;
  streaming: boolean;
  hideOnError?: boolean;
  focusModel?: string | null;
}) {
  const id = threadId ?? sessionId ?? null;
  const modelSplitRef = useRef<HTMLElement>(null);
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: ["chat-analytics", threadId ? "thread" : "session", id],
    queryFn: () => (threadId ? api.chat.analytics(threadId) : api.sessions.analytics(id as string)),
    enabled: !!id,
    staleTime: 15_000,
    retry: 1,
  });

  useEffect(() => {
    if (!focusModel || !data) return;
    modelSplitRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusModel, data]);

  if (!id)
    return (
      <p className="text-sm text-muted-foreground">
        Analytics appear after you send the first message.
      </p>
    );
  if (isError) {
    if (hideOnError) return null;
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
  }
  if (!data) return <AnalyticsSkeleton />;

  const usage = data.usage ?? EMPTY_CHAT_USAGE_SUMMARY;
  const latest = data.context?.usage.latest ?? null;
  const timeline = data.context?.usage.timeline ?? [];
  const compactionList = data.context?.usage.compactions ?? [];
  const compactions = compactionList.length;
  const peak = timeline.reduce((highest, point) => Math.max(highest, point.context_tokens), 0);
  const estimated = usage.usageSource === "estimated";
  const hasTurnUsage = data.turnTimeline.some((turn) => turn.usage !== null);

  return (
    <div className="min-w-0 space-y-5">
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

      <div className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4">
        <AnalyticsStat
          testId="chat-analytics-total-tokens"
          label={estimated ? "Total tokens (est.)" : "Total tokens"}
          value={usage.totals ? formatTokenCount(usage.totals.total, estimated) : "—"}
        />
        <AnalyticsStat
          testId="chat-analytics-cache-hit-rate"
          label="Cache hit rate"
          value={usage.cacheHitRate !== null ? `${percent.format(usage.cacheHitRate * 100)}%` : "—"}
        />
        <AnalyticsStat
          testId="chat-analytics-cache-savings"
          label="Cache savings"
          value={usage.cacheSavingsUsd !== null ? formatUsd(usage.cacheSavingsUsd) : "—"}
        />
        <AnalyticsStat
          testId="chat-analytics-total-cost"
          label={estimated ? "Estimated cost" : "Total cost"}
          value={
            usage.totalCostUsd !== null
              ? `${formatUsd(usage.totalCostUsd)}${usage.costComplete ? "" : "+"}`
              : usage.totals !== null
                ? "-"
                : "—"
          }
          help={
            usage.totals !== null && usage.totalCostUsd === null ? (
              <UnpricedHelp testId="chat-analytics-cost-unpriced-help" />
            ) : usage.totalCostUsd !== null && !usage.costComplete ? (
              <span className="-my-2 inline-flex items-center">
                <HelpPopover label="Partial cost" testId="chat-analytics-cost-partial-help">
                  Partial cost. One or more models have no configured price. Add one in Settings
                  -&gt; Usage.
                </HelpPopover>
              </span>
            ) : undefined
          }
        />
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border pt-4 sm:grid-cols-3">
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

      {(usage.byModel.length > 0 || focusModel) && (
        <section
          ref={modelSplitRef}
          id="chat-analytics-model-split"
          data-testid="chat-analytics-model-split"
          aria-labelledby="chat-analytics-models-heading"
          className="space-y-2 border-t border-border pt-4"
        >
          <div className="flex items-center gap-1">
            <h3 id="chat-analytics-models-heading" className="text-sm font-medium">
              Models
            </h3>
            <HelpPopover label="Model split" testId="chat-analytics-models-help">
              Tokens, cache hit rate, cache savings and cost split by model across the entire
              session.
            </HelpPopover>
          </div>
          {estimated && (
            <p
              data-testid="chat-analytics-estimated-note"
              className="text-xs text-muted-foreground"
            >
              Token figures are estimated by the provider.
              {usage.totalCostUsd === null
                ? " Configure a model price in Settings -> Usage to estimate cost."
                : ""}
            </p>
          )}
          {usage.byModel.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No per-model usage recorded for this session yet.
            </p>
          ) : (
            <ModelSplitTable rows={usage.byModel} focusModel={focusModel} />
          )}
          {usage.unattributed && usage.unattributed.total > 0 && (
            <p data-testid="chat-analytics-unattributed" className="text-xs text-muted-foreground">
              Unattributed: {formatTokenCount(usage.unattributed.total, estimated)} across{" "}
              {count.format(usage.unattributedRequests)}{" "}
              {usage.unattributedRequests === 1 ? "request" : "requests"} outside timed chat turns.
            </p>
          )}
        </section>
      )}

      <section
        aria-labelledby="chat-analytics-context-heading"
        className="space-y-2 border-t border-border pt-4"
      >
        <div className="flex items-center gap-1">
          <h3 id="chat-analytics-context-heading" className="text-sm font-medium">
            Context and cache
          </h3>
          <HelpPopover label="Context and cache" testId="chat-analytics-context-help">
            Every request re-sends the conversation, so context totals count reused text once per
            request. Cache reuse is the share read from the provider's cache; compaction lowers the
            next request.
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

      {data.context?.supported && (
        <section
          aria-labelledby="chat-analytics-compactions-heading"
          data-testid="chat-analytics-compaction-section"
          className="space-y-2 border-t border-border pt-4"
        >
          <div className="flex items-center gap-1">
            <h3 id="chat-analytics-compactions-heading" className="text-sm font-medium">
              Compactions
            </h3>
            <HelpPopover label="Compaction analytics" testId="chat-analytics-compactions-help">
              Each compaction replaces the conversation with a summary. Context shows the size of
              the request before it and of the first request after it, as the agent recorded them.
            </HelpPopover>
          </div>
          {compactions === 0 ? (
            <p className="text-xs text-muted-foreground">
              This session has not been compacted yet.
            </p>
          ) : (
            <CompactionTable compactions={compactionList} />
          )}
        </section>
      )}

      <section
        aria-labelledby="chat-analytics-skills-heading"
        className="space-y-2 border-t border-border pt-4"
      >
        <div className="flex items-center gap-1">
          <h3 id="chat-analytics-skills-heading" className="text-sm font-medium">
            Skills
          </h3>
          <HelpPopover label="Skill analytics" testId="chat-analytics-skills-help">
            Counted from the tool calls that load a skill: Claude's Skill tool, ORC skill_read, and
            reads of a skill's SKILL.md file.
          </HelpPopover>
        </div>
        {data.skills.length === 0 ? (
          <p className="text-xs text-muted-foreground">No skills loaded in this chat yet.</p>
        ) : (
          <SkillTable skills={data.skills} />
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
        className="space-y-3 border-t border-border pt-4"
      >
        <div className="flex items-center gap-1">
          <h3 id="chat-analytics-turns-heading" className="text-sm font-medium">
            Turns
          </h3>
          <HelpPopover label="Turn analytics" testId="chat-analytics-turns-help">
            Turn timings and per-turn tokens cover messages sent from this chat. Unmatched turns
            stay unreadable instead of zero. Showing the latest {data.turnTimeline.length} turns.
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
              {data.outcomes.interrupted > 0 && (
                <Outcome label="Interrupted" value={data.outcomes.interrupted} />
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
            {hasTurnUsage && (
              <Suspense fallback={<div className="h-44" />}>
                <TurnTokensChart turns={data.turnTimeline} />
              </Suspense>
            )}
            <Suspense fallback={<div className="h-40" />}>
              <TurnChart turns={data.turnTimeline} />
            </Suspense>
            <TurnTable turns={data.turnTimeline} />
            {data.turnTimelineTruncated && (
              <p className="text-xs text-muted-foreground">
                Showing the latest {data.turnTimeline.length} of {count.format(data.turns)} turns;
                session totals above include all turns.
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <div key={index} className="space-y-1">
            <div className="h-5 w-14 animate-pulse rounded bg-surface-highest" />
            <div className="h-3 w-20 animate-pulse rounded bg-surface-high" />
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
  help,
}: {
  testId: string;
  label: string;
  value: number | string;
  help?: ReactNode;
}) {
  return (
    <div data-testid={testId} className="min-w-0">
      <div className="flex items-center gap-1">
        <p className="truncate text-lg font-medium tabular-nums">
          {typeof value === "number" ? count.format(value) : value}
        </p>
        {help}
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
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

function ModelSplitTable({
  rows,
  focusModel,
}: {
  rows: ChatModelUsageStat[];
  focusModel: string | null;
}) {
  const totalTokens = rows.reduce((sum, row) => sum + row.usage.total, 0);
  return (
    <>
      <table
        data-testid="chat-model-split-table"
        className="hidden w-full text-xs tabular-nums sm:table"
      >
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="pb-1 font-normal">Model</th>
            <th className="pb-1 text-right font-normal">Turns</th>
            <th className="pb-1 text-right font-normal">Tokens</th>
            <th className="pb-1 text-right font-normal">Cache hit</th>
            <th className="pb-1 text-right font-normal">Savings</th>
            <th className="pb-1 text-right font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const name = row.model ?? "Unknown model";
            const share = totalTokens > 0 ? (row.usage.total / totalTokens) * 100 : 0;
            const highlighted = Boolean(focusModel && row.model === focusModel);
            return (
              <tr
                key={row.model ?? "__unknown__"}
                data-testid="chat-model-split-row"
                className={cn("border-t border-border/60", highlighted && "bg-selected")}
              >
                <td className="max-w-52 truncate py-1.5 font-mono text-[11px]" title={name}>
                  {name}
                </td>
                <td className="py-1.5 text-right">{count.format(row.turns)}</td>
                <td className="py-1.5 text-right">
                  {formatTokenCount(row.usage.total, row.usageSource === "estimated")}
                  <span className="ml-1 text-muted-foreground">({percent.format(share)}%)</span>
                </td>
                <td className="py-1.5 text-right text-muted-foreground">
                  {row.cacheHitRate !== null ? `${percent.format(row.cacheHitRate * 100)}%` : "—"}
                </td>
                <td className="py-1.5 text-right text-muted-foreground">
                  {row.cacheSavingsUsd !== null ? formatUsd(row.cacheSavingsUsd) : "—"}
                </td>
                <td className="py-1.5 text-right">
                  {row.costUsd !== null ? (
                    formatUsd(row.costUsd)
                  ) : (
                    <span className="inline-flex items-center justify-end gap-0.5">
                      <span>-</span>
                      <UnpricedHelp testId={`chat-model-unpriced-${row.model ?? "unknown"}`} />
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div data-testid="chat-model-split-mobile" className="divide-y divide-border/60 sm:hidden">
        {rows.map((row) => {
          const name = row.model ?? "Unknown model";
          const share = totalTokens > 0 ? (row.usage.total / totalTokens) * 100 : 0;
          const highlighted = Boolean(focusModel && row.model === focusModel);
          return (
            <div
              key={row.model ?? "__unknown__"}
              data-testid="chat-model-split-row-mobile"
              className={cn("py-2 text-xs tabular-nums", highlighted && "rounded bg-selected px-2")}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-[11px]" title={name}>
                  {name}
                </span>
                <span className="inline-flex shrink-0 items-center gap-0.5 font-medium">
                  {row.costUsd !== null ? (
                    formatUsd(row.costUsd)
                  ) : (
                    <>
                      <span>-</span>
                      <UnpricedHelp
                        testId={`chat-model-unpriced-mobile-${row.model ?? "unknown"}`}
                      />
                    </>
                  )}
                </span>
              </div>
              <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-muted-foreground">
                <span className="truncate">
                  {count.format(row.turns)} {row.turns === 1 ? "turn" : "turns"} ·{" "}
                  {formatTokenCount(row.usage.total, row.usageSource === "estimated")} (
                  {percent.format(share)}%)
                </span>
                <span className="shrink-0">
                  {row.cacheHitRate !== null
                    ? `${percent.format(row.cacheHitRate * 100)}% cache`
                    : "No cache"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function TurnTable({ turns }: { turns: ChatTurnStat[] }) {
  if (!turns.length) return null;
  return (
    <div className="min-w-0">
      <div className="hidden overflow-x-auto sm:block">
        <table data-testid="chat-turn-table" className="w-full text-xs tabular-nums">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-1 pr-2 font-normal">#</th>
              <th className="pb-1 pr-2 font-normal">Start</th>
              <th className="pb-1 pr-2 text-right font-normal">Duration</th>
              <th className="pb-1 pr-2 font-normal">Outcome</th>
              <th className="pb-1 pr-2 font-normal">Model</th>
              <th className="pb-1 pr-2 text-right font-normal">Input</th>
              <th className="pb-1 pr-2 text-right font-normal">Output</th>
              <th className="pb-1 pr-2 text-right font-normal">Cache R/W</th>
              <th className="pb-1 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((turn) => {
              const est = turn.usageSource === "estimated";
              const outTotal = turn.usage ? turn.usage.output + turn.usage.reasoning : null;
              return (
                <tr
                  key={turn.index}
                  data-testid="chat-turn-row"
                  className="border-t border-border/60"
                >
                  <td className="py-1.5 pr-2 text-muted-foreground">{turn.index}</td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-muted-foreground">
                    {formatTurnStart(turn.startedAt)}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-right">
                    {turn.durationMs !== null ? formatDuration(turn.durationMs) : "—"}
                  </td>
                  <td
                    className={cn(
                      "whitespace-nowrap py-1.5 pr-2",
                      turn.outcome === "failed" ? "text-error" : "text-muted-foreground",
                    )}
                  >
                    {turn.outcome}
                  </td>
                  <td
                    className="max-w-36 truncate py-1.5 pr-2 font-mono text-[11px]"
                    title={turn.model ?? undefined}
                  >
                    {turn.model ?? "—"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-right">
                    {turn.usage ? formatTokenCount(turn.usage.input, est) : "—"}
                  </td>
                  <td
                    className="whitespace-nowrap py-1.5 pr-2 text-right"
                    title={
                      turn.usage && turn.usage.reasoning > 0
                        ? `Output ${count.format(turn.usage.output)} · Reasoning ${count.format(turn.usage.reasoning)}`
                        : undefined
                    }
                  >
                    {outTotal !== null ? formatTokenCount(outTotal, est) : "—"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-2 text-right text-muted-foreground">
                    {turn.usage
                      ? `${formatTokenCount(turn.usage.cacheRead, false)} / ${formatTokenCount(turn.usage.cacheWrite, false)}`
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 text-right">
                    {turn.costUsd !== null ? (
                      formatUsd(turn.costUsd)
                    ) : turn.usage !== null ? (
                      <span className="inline-flex items-center justify-end gap-0.5">
                        <span>-</span>
                        <UnpricedHelp testId={`chat-turn-unpriced-${turn.index}`} />
                      </span>
                    ) : (
                      <span
                        className="text-muted-foreground"
                        title="Usage could not be read for this turn"
                      >
                        —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div data-testid="chat-turn-list-mobile" className="divide-y divide-border/60 sm:hidden">
        {turns.map((turn) => {
          const est = turn.usageSource === "estimated";
          const outTotal = turn.usage ? turn.usage.output + turn.usage.reasoning : null;
          return (
            <div
              key={turn.index}
              data-testid="chat-turn-row-mobile"
              className="py-2 text-xs tabular-nums"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="text-muted-foreground">#{turn.index}</span> ·{" "}
                  {formatTurnStart(turn.startedAt)} ·{" "}
                  {turn.durationMs !== null ? formatDuration(turn.durationMs) : "—"} ·{" "}
                  <span
                    className={turn.outcome === "failed" ? "text-error" : "text-muted-foreground"}
                  >
                    {turn.outcome}
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-0.5">
                  {turn.costUsd !== null ? (
                    formatUsd(turn.costUsd)
                  ) : turn.usage !== null ? (
                    <>
                      <span>-</span>
                      <UnpricedHelp testId={`chat-turn-unpriced-mobile-${turn.index}`} />
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </div>
              <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-muted-foreground">
                <span
                  className="min-w-0 truncate font-mono text-[11px]"
                  title={turn.model ?? undefined}
                >
                  {turn.model ?? "—"}
                </span>
                <span className="shrink-0">
                  {turn.usage && outTotal !== null
                    ? `${formatTokenCount(turn.usage.input, est)}/${formatTokenCount(outTotal, est)} · C ${formatTokenCount(turn.usage.cacheRead, false)}/${formatTokenCount(turn.usage.cacheWrite, false)}`
                    : "Usage unreadable"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompactionTable({
  compactions,
}: {
  compactions: NonNullable<SessionCacheUsage["compactions"]>;
}) {
  return (
    <table data-testid="chat-compaction-table" className="w-full text-xs tabular-nums">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="pb-1 font-normal">When</th>
          <th className="pb-1 text-right font-normal">Before</th>
          <th className="pb-1 text-right font-normal">After</th>
          <th className="pb-1 text-right font-normal">Freed</th>
        </tr>
      </thead>
      <tbody>
        {compactions.map((compaction, index) => (
          <tr
            // biome-ignore lint/suspicious/noArrayIndexKey: compactions are positional
            key={index}
            data-testid="chat-compaction-row"
            className="border-t border-border/60"
          >
            <td className="py-1">
              {compaction.recorded_at ? new Date(compaction.recorded_at).toLocaleString() : "—"}
            </td>
            <td className="py-1 text-right">
              {compaction.pre_tokens === null
                ? "—"
                : formatTokenCount(compaction.pre_tokens, false)}
            </td>
            <td className="py-1 text-right">
              {compaction.post_tokens === null
                ? "—"
                : formatTokenCount(compaction.post_tokens, false)}
            </td>
            <td className="py-1 text-right text-muted-foreground">
              {compaction.pre_tokens && compaction.post_tokens !== null
                ? `${percent.format((1 - compaction.post_tokens / compaction.pre_tokens) * 100)}%`
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SkillTable({ skills }: { skills: ChatSkillStat[] }) {
  return (
    <table data-testid="chat-skill-table" className="w-full text-xs tabular-nums">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="pb-1 font-normal">Skill</th>
          <th className="pb-1 text-right font-normal">Loads</th>
        </tr>
      </thead>
      <tbody>
        {skills.map((skill) => (
          <tr key={skill.name} data-testid="chat-skill-row" className="border-t border-border/60">
            <td className="max-w-56 truncate py-1 font-mono text-[11px]" title={skill.name}>
              {skill.name}
            </td>
            <td className="py-1 text-right">{count.format(skill.loads)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
