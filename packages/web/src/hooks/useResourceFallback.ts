import { useSyncExternalStore } from "react";
import { getResourceConnection, subscribeResourceConnection } from "@/lib/resource-events";

/**
 * Polling is a last resort for proxies that block the event stream. While the stream is
 * connected, changes arrive as `change` events, and `ready` already refreshes the
 * snapshots after every (re)connect, so "connecting" needs no timer either.
 */
export function useResourceFallback(intervalMs = 30_000): number | false {
  const status = useSyncExternalStore(
    subscribeResourceConnection,
    getResourceConnection,
    () => "connected" as const,
  );
  return status === "disconnected" ? intervalMs : false;
}
