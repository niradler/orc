import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

export function useHumanRequests() {
  return useQuery({
    queryKey: ["human-requests"],
    queryFn: () => api.humanRequests.list(),
    // Shared SSE invalidates this query immediately. Periodic snapshots recover
    // lost events and time-based expiration even when the stream is disconnected.
    refetchInterval: 15000,
    retry: false,
  });
}
