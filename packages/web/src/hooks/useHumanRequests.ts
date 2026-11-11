import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useResourceFallback } from "@/hooks/useResourceFallback";

export function useHumanRequests() {
  return useQuery({
    queryKey: ["human-requests"],
    queryFn: () => api.humanRequests.list(),
    // Shared SSE invalidates this query immediately; the timer only covers a blocked stream.
    refetchInterval: useResourceFallback(),
    retry: false,
  });
}
