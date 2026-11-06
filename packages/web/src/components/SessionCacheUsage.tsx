import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { sessionCacheIndicator } from "@/lib/session-cache";

const count = new Intl.NumberFormat();

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
  return (
    <details data-testid="session-cache" className="group mt-2 text-xs">
      <summary
        data-testid="session-cache-indicator"
        title="Cache reuse reported for the last request with usage data."
        className={`flex min-h-8 max-md:min-h-11 cursor-pointer items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-ring ${indicator.cold ? "text-warning" : "text-muted-foreground"}`}
      >
        <ChevronDown size={12} aria-hidden="true" className="group-open:rotate-180" />
        {indicator.label}
      </summary>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 pb-2 tabular-nums">
        <dt className="text-muted-foreground">Last reported input</dt>
        <dd>{count.format(latest.input_tokens)} tokens</dd>
        <dt className="text-muted-foreground">Read from cache</dt>
        <dd>{count.format(latest.cached_input_tokens)} tokens</dd>
        {latest.cache_write_tokens !== null && (
          <>
            <dt className="text-muted-foreground">Uncached input</dt>
            <dd>
              {count.format(
                latest.input_tokens - latest.cached_input_tokens - latest.cache_write_tokens,
              )}{" "}
              tokens
            </dd>
            <dt className="text-muted-foreground">Written to cache</dt>
            <dd>{count.format(latest.cache_write_tokens)} tokens</dd>
          </>
        )}
        {latest.recorded_at && (
          <>
            <dt className="text-muted-foreground">Recorded</dt>
            <dd>{new Date(latest.recorded_at).toLocaleString()}</dd>
          </>
        )}
        {data?.totals && (
          <>
            <dt className="text-muted-foreground">Reported session cached input</dt>
            <dd>
              {count.format(data.totals.cached_input_tokens)} /{" "}
              {count.format(data.totals.input_tokens)}
            </dd>
          </>
        )}
      </dl>
      {indicator.cold && (
        <p className="mb-2 max-w-prose text-muted-foreground">
          The recorded cache lifetime has elapsed since this activity. The next request may rebuild
          some cached input; reuse also depends on the prompt and other requests.
        </p>
      )}
    </details>
  );
}
