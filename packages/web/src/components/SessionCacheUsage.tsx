import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "@/api/client";
import { formatTokenCount } from "@/lib/live-sessions";
import { sessionCacheIndicator } from "@/lib/session-cache";

const count = new Intl.NumberFormat();
const SessionContextChart = lazy(() => import("@/components/SessionContextChart"));

export function SessionCacheUsage({ sessionId, live }: { sessionId: string; live: boolean }) {
  const { data, isError, refetch } = useQuery({
    queryKey: ["session-cache", sessionId, live],
    queryFn: () => api.sessions.cacheUsage(sessionId),
    staleTime: 15_000,
    refetchInterval: live ? 15_000 : false,
    retry: 1,
  });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!data?.latest?.may_be_cold_after) return;
    setNow(Date.now());
    const delay = Date.parse(data.latest.may_be_cold_after) - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [data?.latest?.may_be_cold_after]);
  if (isError)
    return (
      <button
        type="button"
        className="min-h-11 text-xs text-muted-foreground underline"
        onClick={() => void refetch()}
      >
        Retry cache usage
      </button>
    );
  const indicator = sessionCacheIndicator(data?.latest ?? null, now);
  const latest = data?.latest;
  if (!indicator || !latest) return null;
  const totals = data.totals;
  const compactions = data.compactions ?? [];
  const summary = [
    `${formatTokenCount(latest.input_tokens, false)} context`,
    ...(compactions.length
      ? [`${compactions.length} ${compactions.length === 1 ? "compact" : "compacts"}`]
      : []),
    indicator.label,
  ].join(" · ");
  const slices = totals
    ? [
        { label: "Read from cache", value: totals.cached_input_tokens },
        ...(totals.cache_write_tokens !== null
          ? [
              {
                label: "Written to cache",
                value: totals.cache_write_tokens,
              },
            ]
          : []),
        ...(data.output_tokens !== null ? [{ label: "Output", value: data.output_tokens }] : []),
        {
          label: "Uncached input",
          value:
            totals.input_tokens - totals.cached_input_tokens - (totals.cache_write_tokens ?? 0),
        },
      ]
    : [];
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  return (
    <details data-testid="session-cache" className="group mt-2 text-xs">
      <summary
        data-testid="session-cache-indicator"
        title="Context size and cache reuse of the last request. Every request re-sends the whole context, so the session total counts it once per request."
        className={`flex min-h-8 max-md:min-h-11 cursor-pointer items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-ring ${indicator.cold ? "text-warning" : "text-muted-foreground"}`}
      >
        <ChevronDown size={12} aria-hidden="true" className="group-open:rotate-180" />
        {summary}
      </summary>
      {data.timeline && data.timeline.length > 1 && (
        <Suspense fallback={<div className="h-36" />}>
          <SessionContextChart timeline={data.timeline} compactions={compactions} />
        </Suspense>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pb-2 pt-2 tabular-nums">
        <div className="min-w-0 max-w-xl flex-1 space-y-2">
          {totals && (
            <div>
              <p className="font-medium text-on-surface">
                Session total {formatTokenCount(total, false)}
                {data.requests !== null && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    over {count.format(data.requests)} requests
                  </span>
                )}
              </p>
              <ul className="mt-1 space-y-0.5">
                {slices.map((slice) => (
                  <li key={slice.label} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {slice.label}
                    </span>
                    <span>{count.format(slice.value)}</span>
                    <span className="w-11 text-right text-muted-foreground">
                      {share(slice.value, total)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      {indicator.cold && (
        <p className="mb-2 max-w-prose text-muted-foreground">
          The recorded cache lifetime has elapsed since this activity. The next request may rebuild
          some cached input; reuse also depends on the prompt and other requests.
        </p>
      )}
    </details>
  );
}

const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function share(value: number, total: number): string {
  if (!total) return "0%";
  const ratio = (value / total) * 100;
  return value > 0 && ratio < 0.1 ? "<0.1%" : `${percent.format(ratio)}%`;
}
