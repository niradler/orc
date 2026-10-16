import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api } from "@/api/client";
import { getResourceConnection, subscribeResourceConnection } from "@/lib/resource-events";

export function useHealth() {
  const connection = useSyncExternalStore(subscribeResourceConnection, getResourceConnection);
  const query = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health.check(),
    retry: false,
  });
  return { ...query, isError: query.isError || connection === "disconnected" };
}
