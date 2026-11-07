import { useSyncExternalStore } from "react";
import { getSeen, type SeenRecord, subscribeSeen } from "@/lib/session-seen";

export function useSessionSeen(): SeenRecord {
  return useSyncExternalStore(subscribeSeen, getSeen);
}
