import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export const activeLiveSessionsQuery = {
  queryKey: ["sessions", "live", true] as const,
  queryFn: () => api.sessions.live({ active: true, limit: 5000 }),
  refetchInterval: 15000,
};

export function useActiveLiveSessions() {
  return useQuery({ ...activeLiveSessionsQuery, select: (data) => data.sessions });
}
