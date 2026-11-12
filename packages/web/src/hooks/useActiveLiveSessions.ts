import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useResourceFallback } from "@/hooks/useResourceFallback";

export const activeLiveSessionsQuery = {
  queryKey: ["sessions", "live", true] as const,
  queryFn: () => api.sessions.live({ active: true, limit: 5000 }),
};

/** The always-mounted bell only needs enough rows to recognize the session in view. */
export const activeLiveSessionsSummaryQuery = {
  queryKey: ["sessions", "live", "summary"] as const,
  queryFn: () => api.sessions.live({ active: true, limit: 50 }),
};

export function useActiveLiveSessions() {
  return useQuery({
    ...activeLiveSessionsQuery,
    refetchInterval: useResourceFallback(),
    select: (data) => data.sessions,
  });
}

export function useActiveLiveSessionsSummary() {
  return useQuery({
    ...activeLiveSessionsSummaryQuery,
    refetchInterval: useResourceFallback(),
  });
}
