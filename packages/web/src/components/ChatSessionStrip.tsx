import type { CacheTokenUsage } from "@orc/core/usage";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { lazy, Suspense } from "react";
import { api } from "@/api/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { contextUsageHelp } from "@/lib/session-cache";
import { formatTokenCount } from "@/lib/token-count";
import { cn } from "@/lib/utils";

/** The usage API only knows the session's recorded requests; it carries no model window. */
export function useChatContextUsage(sourceId: string | null | undefined, live: boolean) {
  return useQuery({
    // Same key as SessionCacheUsage: one read feeds both surfaces.
    queryKey: ["session-cache", sourceId ?? "", live],
    queryFn: () => api.sessions.cacheUsage(sourceId ?? ""),
    enabled: !!sourceId,
    staleTime: 15_000,
    refetchInterval: live ? 15_000 : false,
    retry: 1,
  });
}

type ContextUsage = Pick<CacheTokenUsage, "input_tokens" | "cached_input_tokens">;

/**
 * Context is the input an agent re-sends with each request. The only share the
 * usage API can express is how much of it came from the provider's cache; a
 * session with no recorded request has no figure at all, so it is omitted.
 */
export function contextFigure(
  latest: ContextUsage | null | undefined,
): { tokens: number; percent: number } | null {
  if (!latest || latest.input_tokens <= 0) return null;
  const percent = Math.round((latest.cached_input_tokens / latest.input_tokens) * 100);
  return { tokens: latest.input_tokens, percent: Math.min(100, Math.max(0, percent)) };
}

const count = new Intl.NumberFormat();
const ContextRing = lazy(() => import("@/components/ContextRing"));

export function ChatContextMeter({
  usage,
  window,
  compactions,
}: {
  usage: (ContextUsage & { context_tokens?: number | null | undefined }) | null | undefined;
  window: number | null | undefined;
  compactions: number;
}) {
  const figure = contextFigure(usage);
  if (!usage || !figure) return null;
  const used = usage.context_tokens ?? figure.tokens;
  const percent = window ? Math.min(100, Math.round((used / window) * 100)) : null;
  const tone =
    percent === null ? null : percent >= 90 ? "error" : percent >= 80 ? "warning" : "series-1";
  const help = contextUsageHelp(figure.tokens, figure.percent, compactions);
  return (
    <Popover>
      <PopoverTrigger
        data-testid="chat-context-meter"
        data-tone={tone ?? "unknown"}
        aria-label={
          percent === null
            ? `Context: ${formatTokenCount(used, false)} tokens`
            : `Context: ${percent}% used`
        }
        className={cn(
          "inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-xs tabular-nums text-on-surface-variant hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11",
          tone === "error" && "text-error",
          tone === "warning" && "text-warning",
        )}
      >
        {percent === null ? (
          <Gauge aria-hidden="true" size={14} />
        ) : (
          <Suspense fallback={<span className="size-4" />}>
            <ContextRing percent={percent} color={`var(--color-${tone})`} />
          </Suspense>
        )}
        {percent === null ? formatTokenCount(used, false) : `${percent}%`}
      </PopoverTrigger>
      <PopoverContent
        data-testid="chat-context-meter-popover"
        side="top"
        align="end"
        className="w-72 space-y-2 text-xs leading-relaxed"
      >
        <p className="font-medium tabular-nums">
          {window
            ? `${count.format(used)} of ${count.format(window)} context tokens · ${percent}%`
            : `${count.format(used)} context tokens`}
        </p>
        {percent !== null && percent >= 80 && (
          <p data-testid="chat-context-meter-warning" className="text-on-surface">
            Context is almost full. When it fills, the agent compacts or stops, and the older
            conversation is summarized. Compact now or start a new chat to choose what to keep.
          </p>
        )}
        {!window && (
          <p className="text-on-surface-variant">
            The agent does not report its model's context window, so the share used is not shown.
          </p>
        )}
        <p className="text-on-surface-variant">
          {figure.percent}% of the latest request came from the provider's cache.
        </p>
        <p className="text-on-surface-variant">{help.note}</p>
      </PopoverContent>
    </Popover>
  );
}
