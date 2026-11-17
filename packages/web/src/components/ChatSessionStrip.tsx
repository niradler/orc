import type { CacheTokenUsage } from "@orc/core/usage";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { lazy, Suspense } from "react";
import { api } from "@/api/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatTokenCount } from "@/lib/token-count";
import { cn } from "@/lib/utils";

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

export function contextFigure(
  latest: ContextUsage | null | undefined,
): { tokens: number; percent: number } | null {
  if (!latest || latest.input_tokens <= 0) return null;
  const percent = Math.round((latest.cached_input_tokens / latest.input_tokens) * 100);
  return { tokens: latest.input_tokens, percent: Math.min(100, Math.max(0, percent)) };
}

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
        className="w-auto space-y-1 text-xs tabular-nums"
      >
        <p className="font-medium">
          {window
            ? `${formatTokenCount(used, false)} / ${formatTokenCount(window, false)} · ${percent}%`
            : `${formatTokenCount(used, false)} tokens`}
        </p>
        {percent !== null && percent >= 80 && (
          <p data-testid="chat-context-meter-warning">Compact or start a new chat</p>
        )}
        {compactions > 0 && (
          <p className="text-on-surface-variant">
            {compactions} {compactions === 1 ? "compaction" : "compactions"}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
