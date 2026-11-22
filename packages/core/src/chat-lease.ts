import { hostname } from "node:os";
import { CHAT_TURN_LEASE_STALE_MS, type ChatTurnLease } from "./chat.js";
import { isProcessAlive } from "./daemon-runtime.js";

export type ChatLeaseLiveness = {
  /** Injectable clock so tests can place a lease at an exact age. */
  now?: number;
  host?: string;
  pid?: number;
};

/**
 * Whether a recorded `running` lease still has a writer. One predicate for the
 * send path and boot reconcile, so both agree on when a turn is still live and
 * neither takes over a conversation another process is writing.
 *
 * A lease older than the turn hard limit cannot be live: the daemon force-ends
 * any turn at that age, so the only way one is still `running` is that its
 * writer died. That bound also covers a recycled OS pid, which would otherwise
 * keep a dead lease live forever. A pid belonging to this process is a recycled
 * pid from a previous daemon, not a writer.
 *
 * Inside the bound, a pid on this machine is the strongest evidence. A lease
 * with no pid (written by an older build) falls back to its heartbeat: a recent
 * beat proves something was writing, an absent one proves nothing, so only a
 * lease from another host or an expired one is treated as finished.
 */
export function chatTurnLeaseIsLive(
  lease: ChatTurnLease,
  { now = Date.now(), host = hostname(), pid = process.pid }: ChatLeaseLiveness = {},
): boolean {
  if (lease.status !== "running") return false;
  if (now - lease.startedAt > CHAT_TURN_LEASE_STALE_MS) return false;
  if (lease.pid === pid) return false;
  if (lease.host !== undefined && lease.host !== host) return false;
  if (lease.pid !== undefined) return isProcessAlive(lease.pid);
  return (
    lease.lastHeartbeatAt !== undefined && now - lease.lastHeartbeatAt <= CHAT_TURN_LEASE_STALE_MS
  );
}
