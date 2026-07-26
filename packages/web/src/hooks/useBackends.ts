import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

/**
 * Agent backends and whether each one can actually run. Availability is probed
 * server-side (a binary on PATH, a service reachable, credentials present), so
 * it can change without a deploy - refetch on the same cadence as the rest.
 */
export function useBackends() {
  return useQuery({
    queryKey: ["backends"],
    queryFn: () => api.backends.list(),
    refetchInterval: 60_000,
  });
}
