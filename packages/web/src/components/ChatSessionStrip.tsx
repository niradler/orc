import type { SessionCacheUsage } from "@orc/core/usage";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

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

/**
 * Context is the input an agent re-sends with each request. The only share the
 * usage API can express is how much of it came from the provider's cache; a
 * session with no recorded request has no figure at all, so it is omitted.
 */
export function contextFigure(
  latest: SessionCacheUsage["latest"] | null | undefined,
): { tokens: number; percent: number } | null {
  if (!latest || latest.input_tokens <= 0) return null;
  const percent = Math.round((latest.cached_input_tokens / latest.input_tokens) * 100);
  return { tokens: latest.input_tokens, percent: Math.min(100, Math.max(0, percent)) };
}
