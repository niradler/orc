import type {
  UsageBucket,
  UsageModelBreakdown,
  UsageReport,
  UsageTokenTotals,
} from "@orc/core/usage";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { formatTokenCount } from "@/lib/live-sessions";
import { cn } from "@/lib/utils";

const count = new Intl.NumberFormat();
const agentNames: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  alibaba: "Alibaba Cloud",
  opencode: "OpenCode",
  gemini: "Gemini",
  cursor: "Cursor",
  pi: "Pi",
};
const quotaNames: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  alibaba: "Alibaba Cloud",
};
const AGENT_COLORS = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
  "var(--color-series-5)",
  "var(--color-series-6)",
];
const TOKEN_TYPES = [
  { key: "input_tokens", label: "Input", color: "var(--color-series-1)" },
  { key: "output_tokens", label: "Output", color: "var(--color-series-2)" },
  { key: "cache_read_tokens", label: "Cache read", color: "var(--color-series-3)" },
  { key: "cache_write_tokens", label: "Cache write", color: "var(--color-series-4)" },
  { key: "reasoning_tokens", label: "Reasoning", color: "var(--color-series-5)" },
  { key: "other_tokens", label: "Other", color: "var(--color-series-6)" },
] as const;
const PERIODS = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "0", label: "All time" },
] as const;
const UNKNOWN_MODEL = "__unknown__";

type TokenKey = (typeof TOKEN_TYPES)[number]["key"];
type Breakdown = "models" | "agents";
type Granularity = "day" | "hour";
type ChartPoint = UsageBucket & { label: string };

function agentName(agent: string): string {
  return agentNames[agent] ?? agent;
}

function agentColor(agent: string, agents: readonly string[]): string {
  const index = Math.max(0, agents.indexOf(agent));
  return AGENT_COLORS[index % AGENT_COLORS.length] as string;
}

function share(part: number, total: number): number {
  return total > 0 ? Math.min(100, (part / total) * 100) : 0;
}

function tokenTotal(row: Pick<UsageTokenTotals, TokenKey>): number {
  return TOKEN_TYPES.reduce((sum, type) => sum + row[type.key], 0);
}

function modelLabel(model: string | null): string {
  return model ?? "Unknown model";
}

function modelKey(model: string | null): string {
  return model ?? UNKNOWN_MODEL;
}

function bucketLabel(bucket: string, granularity: Granularity): string {
  // Buckets are UTC. Parsing a date-only string as UTC and then rendering it
  // locally would shift the label by a day west of Greenwich.
  const date = new Date(granularity === "day" ? `${bucket}T00:00:00Z` : bucket);
  if (Number.isNaN(date.getTime())) return bucket;
  return granularity === "hour"
    ? date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        timeZone: "UTC",
      })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function chartPoints(report: UsageReport | undefined): ChartPoint[] {
  if (!report?.buckets.length) return [];
  const byBucket = new Map(report.buckets.map((bucket) => [bucket.bucket, bucket]));
  const step = report.granularity === "hour" ? 3_600_000 : 86_400_000;
  const first = new Date(report.buckets[0]?.bucket ?? Date.now()).getTime();
  const last = Math.min(
    Date.now(),
    new Date(report.buckets[report.buckets.length - 1]?.bucket ?? Date.now()).getTime(),
  );
  const points: ChartPoint[] = [];
  for (let at = first; at <= last && points.length < 2_000; at += step) {
    const key =
      report.granularity === "hour"
        ? `${new Date(at).toISOString().slice(0, 13)}:00Z`
        : new Date(at).toISOString().slice(0, 10);
    const bucket = byBucket.get(key);
    points.push({
      ...(bucket ?? {
        bucket: key,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        other_tokens: 0,
        total_tokens: 0,
        requests: 0,
        sessions: 0,
        estimated_requests: 0,
      }),
      label: bucketLabel(key, report.granularity),
    });
  }
  return points;
}

function Stat({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: string;
  detail?: string;
  testId: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="mt-1 text-lg tabular-nums sm:text-xl">
        {value}
      </dd>
      {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function ShareBar({ value, color, label }: { value: number; color: string; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      className="h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
    </div>
  );
}

function UsageChart({ points, granularity }: { points: ChartPoint[]; granularity: Granularity }) {
  // A zero series still draws its stroke at the top of the stack, which reads as
  // real data. Only plot and label token types this period actually used.
  const active = TOKEN_TYPES.filter((type) => points.some((point) => point[type.key] > 0));
  const types = active.length ? active : TOKEN_TYPES;
  return (
    <figure data-testid="usage-chart" className="min-w-0">
      <figcaption className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {types.map((type) => (
          <span key={type.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 rounded-full"
              style={{ background: type.color }}
            />
            {type.label}
          </span>
        ))}
      </figcaption>
      <div className="h-48 w-full min-w-0 sm:h-60">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis
              dataKey="label"
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "var(--color-border)" }}
              minTickGap={28}
            />
            <YAxis
              width={42}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatTokenCount(value, false)}
            />
            <Tooltip
              cursor={{ stroke: "var(--color-muted-foreground)" }}
              content={({ active, payload }) => {
                const point = active
                  ? (payload?.[0]?.payload as ChartPoint | undefined)
                  : undefined;
                if (!point) return null;
                return (
                  <div className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs tabular-nums shadow-sm">
                    <p className="font-medium text-on-surface">
                      {granularity === "hour"
                        ? `${bucketLabel(point.bucket, "hour")} UTC`
                        : new Date(`${point.bucket}T00:00:00Z`).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            timeZone: "UTC",
                          })}
                    </p>
                    <p className="mt-0.5">{count.format(point.total_tokens)} tokens</p>
                    <p className="text-muted-foreground">
                      {count.format(point.requests)} requests · {count.format(point.sessions)}{" "}
                      sessions
                    </p>
                    {TOKEN_TYPES.filter((type) => point[type.key] > 0).map((type) => (
                      <p key={type.key} className="text-muted-foreground">
                        {type.label} {count.format(point[type.key])}
                      </p>
                    ))}
                  </div>
                );
              }}
            />
            {types.map((type) => (
              <Area
                key={type.key}
                type="linear"
                dataKey={type.key}
                stackId="tokens"
                stroke={type.color}
                strokeWidth={1.5}
                fill={type.color}
                fillOpacity={0.18}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function ModelRow({
  row,
  total,
  color,
  expanded,
  onToggle,
}: {
  row: UsageModelBreakdown;
  total: number;
  color: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const value = tokenTotal(row);
  return (
    <div className="border-b border-border">
      <button
        type="button"
        data-testid="usage-model-row"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-h-11 w-full flex-col justify-center gap-1.5 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring sm:min-h-0"
      >
        <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="min-w-0 break-words text-sm">
            {modelLabel(row.model)}
            <span className="ml-2 text-xs text-muted-foreground">{agentName(row.agent)}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {count.format(value)} · {share(value, total).toFixed(1)}%
          </span>
        </span>
        <ShareBar
          value={share(value, total)}
          color={color}
          label={`${modelLabel(row.model)} share`}
        />
      </button>
      {expanded && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/60 px-1 py-3 text-xs sm:grid-cols-4">
          {TOKEN_TYPES.map((type) => (
            <div key={type.key}>
              <p className="text-muted-foreground">{type.label}</p>
              <p className="tabular-nums">{count.format(row[type.key])}</p>
            </div>
          ))}
          <div>
            <p className="text-muted-foreground">Requests</p>
            <p className="tabular-nums">{count.format(row.requests)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Sessions</p>
            <p className="tabular-nums">{count.format(row.sessions)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Estimated</p>
            <p className="tabular-nums">{count.format(row.estimated_requests)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function UsageSettings() {
  const [days, setDays] = useState("30");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [breakdown, setBreakdown] = useState<Breakdown>("models");
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);

  const report = useQuery({
    queryKey: ["usage-report", days, granularity, agent, model],
    queryFn: () =>
      api.settings.usageReport({
        days,
        granularity,
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
      }),
    staleTime: 30_000,
  });
  const quotas = useQuery({
    queryKey: ["usage-quotas"],
    queryFn: api.settings.usageQuotas,
    staleTime: 60_000,
  });
  const busy = report.isFetching || quotas.isFetching;
  const data = report.data;
  const totals = data?.totals;
  const agents = data?.agents ?? [];
  const agentIds = agents.map((row) => row.agent);
  const models = data?.models ?? [];
  const modelOptions = useMemo(
    () => [...new Map(models.map((row) => [modelKey(row.model), row])).values()],
    [models],
  );
  const points = useMemo(() => chartPoints(data), [data]);
  const tokenTypes = TOKEN_TYPES.map((type) => ({
    ...type,
    value: totals?.[type.key] ?? 0,
  }));
  const cacheInput =
    (totals?.input_tokens ?? 0) +
    (totals?.cache_read_tokens ?? 0) +
    (totals?.cache_write_tokens ?? 0);
  const cacheHit = cacheInput > 0 ? ((totals?.cache_read_tokens ?? 0) / cacheInput) * 100 : null;
  const visibleModels = showAllModels ? models : models.slice(0, 6);
  const selectedModel = model ? models.find((row) => modelKey(row.model) === model) : undefined;
  const filtered = Boolean(agent || model);

  function chooseDays(value: string) {
    setDays(value);
    if (value === "90" || value === "0") setGranularity("day");
  }

  function chooseAgent(value: string) {
    setAgent(value);
    setModel("");
    setExpandedModel(null);
    setShowAllModels(false);
  }

  function chooseModel(value: string) {
    setModel(value);
    setExpandedModel(null);
    setShowAllModels(false);
  }

  return (
    <section aria-labelledby="usage-title" data-testid="settings-usage" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h2 id="usage-title" className="text-base font-medium">
            Usage
          </h2>
          <HelpPopover label="Token usage" testId="usage-help">
            <p>
              Tokens are indexed per request from local Claude, Codex, Pi, OpenCode, Gemini and
              Cursor sessions. Filtering, model distribution and time buckets use the request time,
              not the session start date.
            </p>
            <p className="mt-2">
              Gemini exposes only message totals, and Cursor exposes a context estimate, so those
              requests are marked estimated. Sessions that have not been indexed yet are reported
              separately and are not included in the distribution.
            </p>
            <p className="mt-2">
              Raw requests are kept for 95 days. Older usage is rolled up per session, day and
              model, so All time keeps totals and shares without storing every request.
            </p>
            <p className="mt-2">
              No billed cost is shown: ORC has no reliable price source for every provider and plan.
              Token counts are exact where the CLI records them.
            </p>
          </HelpPopover>
        </div>
        <Button
          variant="outline"
          data-testid="usage-refresh"
          disabled={busy}
          onClick={() => {
            void report.refetch();
            void quotas.refetch();
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <section aria-label="Filters" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Period
          <select
            data-testid="usage-period"
            className="form-control form-control-single min-h-11 w-full"
            value={days}
            onChange={(event) => chooseDays(event.target.value)}
          >
            {PERIODS.map((period) => (
              <option key={period.value} value={period.value}>
                {period.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          <legend className="mb-1">Bucket</legend>
          <div className="grid grid-cols-2 gap-1">
            {(["day", "hour"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={granularity === value ? "secondary" : "outline"}
                data-testid={`usage-granularity-${value}`}
                aria-pressed={granularity === value}
                disabled={value === "hour" && (days === "90" || days === "0")}
                onClick={() => setGranularity(value)}
                className="min-h-11"
              >
                {value === "day" ? "Day" : "Hour"}
              </Button>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Agent
          <select
            data-testid="usage-agent"
            aria-label="Agent filter"
            className="form-control form-control-single min-h-11 w-full"
            value={agent}
            onChange={(event) => chooseAgent(event.target.value)}
          >
            <option value="">All agents</option>
            {agents.map((row) => (
              <option key={row.agent} value={row.agent}>
                {agentName(row.agent)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Model
          <select
            data-testid="usage-model"
            aria-label="Model filter"
            className="form-control form-control-single min-h-11 w-full"
            value={model}
            onChange={(event) => chooseModel(event.target.value)}
          >
            <option value="">All models</option>
            {modelOptions.map((row) => (
              <option key={modelKey(row.model)} value={modelKey(row.model)}>
                {modelLabel(row.model)}
              </option>
            ))}
          </select>
        </label>
      </section>

      {filtered && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Filtered to {agent ? agentName(agent) : "all agents"}
            {model ? ` · ${modelLabel(selectedModel?.model ?? model)}` : ""}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11 sm:min-h-8"
            onClick={() => {
              chooseAgent("");
              chooseModel("");
            }}
          >
            Clear filters
          </Button>
        </div>
      )}

      {report.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading usage…
        </p>
      )}
      {report.isError && (
        <p role="alert" className="text-sm text-error">
          Usage could not be loaded. Use Refresh to retry.
        </p>
      )}

      {data && totals && (
        <>
          <dl className="grid grid-cols-2 gap-4 border-y border-border py-3 sm:grid-cols-4">
            <Stat
              label="Tokens"
              value={formatTokenCount(totals.total_tokens, totals.estimated_requests > 0)}
              detail={`${count.format(totals.total_tokens)} counted`}
              testId="usage-total-tokens"
            />
            <Stat
              label="Requests"
              value={count.format(totals.requests)}
              testId="usage-total-requests"
            />
            <Stat
              label="Sessions"
              value={count.format(totals.sessions)}
              testId="usage-total-sessions"
            />
            <Stat
              label="Cache hit"
              testId="usage-cache-hit"
              value={cacheHit === null ? "—" : `${cacheHit.toFixed(0)}%`}
              detail={
                totals.cache_read_tokens > 0
                  ? `${formatTokenCount(totals.cache_read_tokens, false)} cached`
                  : undefined
              }
            />
          </dl>

          {totals.requests === 0 ? (
            <div className="space-y-2 border-b border-border pb-4">
              <p className="text-sm text-muted-foreground">
                No request-level usage in this period yet. New sessions are indexed on the next
                sync.
              </p>
              {data.coverage.unindexed_sessions > 0 && (
                <p className="text-xs text-muted-foreground">
                  {count.format(data.coverage.unindexed_sessions)} sessions started in this period
                  still have only lifetime totals.
                </p>
              )}
            </div>
          ) : (
            <>
              <UsageChart points={points} granularity={granularity} />

              <section aria-labelledby="token-types-title">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 id="token-types-title" className="text-sm font-medium">
                    Token types
                  </h3>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {count.format(totals.total_tokens)} total
                  </span>
                </div>
                <div
                  data-testid="usage-token-types"
                  role="img"
                  aria-label="Token type distribution"
                  className="mt-2 flex h-2 overflow-hidden rounded-full bg-muted"
                >
                  {tokenTypes
                    .filter((type) => type.value > 0)
                    .map((type) => (
                      <span
                        key={type.key}
                        style={{
                          width: `${share(type.value, totals.total_tokens)}%`,
                          background: type.color,
                        }}
                      />
                    ))}
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                  {tokenTypes.map((type) => (
                    <div key={type.key} className="flex items-baseline justify-between gap-2">
                      <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-full"
                          style={{ background: type.color }}
                        />
                        {type.label}
                      </dt>
                      <dd className="tabular-nums">
                        {share(type.value, totals.total_tokens).toFixed(0)}%
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            </>
          )}

          <section aria-labelledby="breakdown-title">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="breakdown-title" className="text-sm font-medium">
                Distribution
              </h3>
              <div className="flex gap-1">
                {(["models", "agents"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={breakdown === value ? "secondary" : "ghost"}
                    data-testid={`usage-breakdown-${value}`}
                    aria-pressed={breakdown === value}
                    onClick={() => setBreakdown(value)}
                    className="min-h-11 sm:min-h-8"
                  >
                    {value === "models" ? "Models" : "Agents"}
                  </Button>
                ))}
              </div>
            </div>

            {breakdown === "models" && (
              <div data-testid="usage-models" className="mt-1">
                {!models.length && (
                  <p className="py-3 text-sm text-muted-foreground">
                    No model records for this filter.
                  </p>
                )}
                {visibleModels.map((row) => {
                  const key = modelKey(row.model);
                  return (
                    <ModelRow
                      key={`${row.agent}:${key}`}
                      row={row}
                      total={totals.total_tokens}
                      color={agentColor(row.agent, agentIds)}
                      expanded={expandedModel === `${row.agent}:${key}`}
                      onToggle={() =>
                        setExpandedModel((current) =>
                          current === `${row.agent}:${key}` ? null : `${row.agent}:${key}`,
                        )
                      }
                    />
                  );
                })}
                {models.length > 6 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-1 min-h-11"
                    onClick={() => setShowAllModels((value) => !value)}
                  >
                    {showAllModels
                      ? "Show fewer models"
                      : `Show all ${count.format(models.length)} models`}
                  </Button>
                )}
              </div>
            )}

            {breakdown === "agents" && (
              <div data-testid="usage-agents" className="mt-1">
                {!agents.length && (
                  <p className="py-3 text-sm text-muted-foreground">
                    No agent records for this filter.
                  </p>
                )}
                {agents.map((row) => {
                  const value = tokenTotal(row);
                  return (
                    <button
                      key={row.agent}
                      type="button"
                      aria-pressed={agent === row.agent}
                      onClick={() => chooseAgent(agent === row.agent ? "" : row.agent)}
                      className="flex min-h-11 w-full flex-col justify-center gap-1.5 border-b border-border py-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring sm:min-h-0"
                    >
                      <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <span className="text-sm">{agentName(row.agent)}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {count.format(value)} · {share(value, totals.total_tokens).toFixed(1)}%
                        </span>
                      </span>
                      <ShareBar
                        value={share(value, totals.total_tokens)}
                        color={agentColor(row.agent, agentIds)}
                        label={`${agentName(row.agent)} share`}
                      />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {count.format(row.requests)} requests · {count.format(row.sessions)}{" "}
                        sessions
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section
            aria-labelledby="coverage-title"
            className="space-y-1.5 border-t border-border pt-4"
          >
            <h3 id="coverage-title" className="text-sm font-medium">
              Coverage
            </h3>
            <p className="text-xs text-muted-foreground">
              {count.format(data.coverage.indexed_sessions)} sessions with request-level usage.
              {data.coverage.unindexed_sessions > 0 && (
                <>
                  {" "}
                  {count.format(data.coverage.unindexed_sessions)} sessions started in this period
                  have not been indexed yet
                  {data.coverage.unindexed_tokens > 0
                    ? `; their ${count.format(data.coverage.unindexed_tokens)} lifetime tokens are excluded from the distribution`
                    : ""}
                  .
                </>
              )}
              {data.coverage.unknown_sessions > 0 &&
                ` ${count.format(data.coverage.unknown_sessions)} have no recorded token count.`}
            </p>
            {data.coverage.estimated_sessions > 0 && (
              <p className="text-xs text-muted-foreground">
                Cursor sessions with estimated counts:{" "}
                {count.format(data.coverage.estimated_sessions)}. Gemini messages are also estimated
                because only a total is available.
              </p>
            )}
          </section>
        </>
      )}

      <details className="border-t border-border pt-4" data-testid="usage-quotas">
        <summary className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          <span>Account quotas</span>
          <span className="text-xs font-normal text-muted-foreground">
            {quotas.isPending
              ? "Loading…"
              : quotas.isError
                ? "Unavailable"
                : `${count.format(quotas.data?.accounts.length ?? 0)} accounts · refresh to update`}
          </span>
        </summary>
        <p className="mt-1 text-xs text-muted-foreground">
          Local CLI accounts on the API host. SSH accounts are excluded. Credentials stay on the
          server.
        </p>
        {quotas.isPending && (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            Loading account quotas…
          </p>
        )}
        {quotas.isError && (
          <p role="alert" className="mt-3 text-sm text-error">
            Account quotas could not be loaded. Use Refresh to retry.
          </p>
        )}
        {quotas.data?.accounts.map((account) => (
          <div
            key={account.provider_id ?? account.provider}
            data-testid={`usage-quota-${account.provider_id ?? account.provider}`}
            className="border-b border-border py-3 last:border-b-0"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h4 className="text-sm font-medium">
                {quotaNames[account.provider] ?? account.provider}
                {account.provider_id && account.provider_id !== account.provider && account.name
                  ? ` · ${account.name}`
                  : ""}
              </h4>
              <span className="text-xs text-muted-foreground">
                Checked {new Date(account.checked_at).toLocaleTimeString()}
              </span>
            </div>
            {account.status !== "available" && (
              <p className="mt-2 text-xs text-muted-foreground">
                {account.message ?? "Quota data is unavailable."}
              </p>
            )}
            {account.windows.map((window) => {
              const tone =
                window.used_percent >= 90
                  ? "bg-error"
                  : window.used_percent >= 70
                    ? "bg-warning"
                    : "bg-foreground";
              return (
                <div
                  key={window.label}
                  className="mt-3 grid min-w-0 gap-1.5 sm:grid-cols-[140px_minmax(0,1fr)_80px] sm:items-center sm:gap-x-4"
                >
                  <span className="text-xs">{window.label}</span>
                  <div
                    role="progressbar"
                    aria-label={`${quotaNames[account.provider] ?? account.provider} ${window.label} used`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={window.used_percent}
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className={cn("h-full", tone)}
                      style={{ width: `${window.used_percent}%` }}
                    />
                  </div>
                  <span className="text-xs tabular-nums sm:text-right">
                    {window.used_percent}% used
                  </span>
                  <span className="text-xs text-muted-foreground sm:col-span-3">
                    {window.resets_at
                      ? `Resets ${new Date(window.resets_at).toLocaleString()}`
                      : "Reset time unavailable"}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {!quotas.isPending && !quotas.isError && !quotas.data?.accounts.length && (
          <p className="mt-3 text-sm text-muted-foreground">
            No supported local account logins were found.
          </p>
        )}
      </details>
    </section>
  );
}
