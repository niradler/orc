import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useSessions(params?: { agent?: string; limit?: number }) {
  return useQuery({
    queryKey: ["sessions", params],
    queryFn: () => api.sessions.list({ ...params, limit: params?.limit ?? 50 }),
    refetchInterval: 30_000,
    select: (data) => data.sessions,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => api.sessions.get(id),
    enabled: Boolean(id),
  });
}
