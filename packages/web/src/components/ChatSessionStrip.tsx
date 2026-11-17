import type { CacheTokenUsage } from "@orc/core/usage";
import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { api } from "@/api/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { contextUsageHelp } from "@/lib/session-cache";
import { formatTokenCount } from "@/lib/token-count";

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

export function ChatContextMeter({
  usage,
  compactions,
}: {
  usage: ContextUsage | null | undefined;
  compactions: number;
}) {
  const figure = contextFigure(usage);
  if (!figure) return null;
  const help = contextUsageHelp(figure.tokens, figure.percent, compactions);
  return (
    <Popover>
      <PopoverTrigger
        data-testid="chat-context-meter"
        aria-label={`Context: ${formatTokenCount(figure.tokens, false)} tokens`}
        className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-xs tabular-nums text-on-surface-variant hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11"
      >
        <Gauge aria-hidden="true" size={14} />
        {formatTokenCount(figure.tokens, false)}
      </PopoverTrigger>
      <PopoverContent
        data-testid="chat-context-meter-popover"
        side="top"
        align="end"
        className="w-72 space-y-2 text-xs leading-relaxed"
      >
        <p className="font-medium tabular-nums">
          {count.format(figure.tokens)} context tokens
          <span className="font-normal text-on-surface-variant"> · {figure.percent}% cached</span>
        </p>
        <p className="text-on-surface-variant">
          The agent does not report its model's context window, so the share used is not shown.
        </p>
        <p className="text-on-surface-variant">{help.explanation}</p>
        <p className="text-on-surface-variant">{help.note}</p>
      </PopoverContent>
    </Popover>
  );
}
