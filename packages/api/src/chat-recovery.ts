import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { type ChatMessage, type ChatThread, parseChatThread } from "@orc/core/chat";
import { chatTurnLeaseIsLive } from "@orc/core/chat-lease";
import { createLogger } from "@orc/core/logger";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";

const logger = createLogger("api:chat-recovery");

/** Shown in the transcript of a turn the daemon restart cut short. The native
 *  session behind the thread survives; the next send resumes it. */
export const TURN_INTERRUPTED_NOTICE =
  "The daemon restarted mid-turn; continuing resumes the same native session.";
export const TURN_INTERRUPTED_NOTICE_NO_SESSION =
  "The daemon restarted mid-turn, before this chat established a provider session.";

export type ChatLeaseReconcileSummary = {
  scanned: number;
  interrupted: number;
  live: number;
};

export type ChatLeaseReconcileOptions = {
  /** Injectable for tests; production reads the daemon's database. */
  db?: Database;
  now?: number;
};

/**
 * Boot-time reconcile for chat turn leases, modeled on a provider-runtime
 * recovery sweep: a `running` lease whose owning process is gone belongs to a
 * turn the previous daemon could not finish. Mark it `interrupted` (never
 * `failed` — the native session survives), record one transcript note, and
 * keep runtimeId and providerRefs untouched so the next send resumes.
 *
 * Runs before the API port opens, and is safe to run on every boot and under
 * concurrent boots: the write is a transaction guarded on the lease's runId, so
 * a second reconcile sees the settled lease and appends nothing.
 */
export async function reconcileChatTurnLeases(
  options: ChatLeaseReconcileOptions = {},
): Promise<ChatLeaseReconcileSummary> {
  const db = options.db ?? getSqlite();
  const now = options.now ?? Date.now();
  const rows = db
    .query<{ id: string; data: string }, []>(
      `SELECT id, data FROM chat_threads
        WHERE json_valid(data) AND json_extract(data, '$.turn.status') = 'running'
        ORDER BY json_extract(data, '$.turn.startedAt')
        LIMIT 500`,
    )
    .all();
  const summary: ChatLeaseReconcileSummary = { scanned: rows.length, interrupted: 0, live: 0 };
  const me = hostname();
  for (const row of rows) {
    let thread: ChatThread;
    try {
      thread = parseChatThread(JSON.parse(row.data));
    } catch (error) {
      // An unreadable row is left for the reconcile of a build that can read it.
      logger.warn("Skipping an unparsable chat thread during lease reconcile", {
        error,
        threadId: row.id,
      });
      continue;
    }
    const lease = thread.turn;
    if (lease?.status !== "running") continue;
    if (chatTurnLeaseIsLive(lease, { now, host: me })) {
      summary.live++;
      continue;
    }
    if (interruptStaleLease(db, thread.id, lease.runId, now)) {
      summary.interrupted++;
      logger.info("Reconciled a chat turn lease left running by the previous daemon", {
        threadId: thread.id,
        runId: lease.runId,
      });
    }
  }
  return summary;
}

/**
 * Settles one stale lease: `interrupted` status plus a single transcript note
 * explaining it. Guarded on the lease epoch and runId inside the write, so a
 * concurrent boot — or a new turn that claimed the thread meanwhile — makes
 * this a no-op instead of a duplicate record.
 */
function interruptStaleLease(db: Database, threadId: string, runId: string, now: number): boolean {
  const store = new ChatStore(db);
  let applied = false;
  try {
    db.transaction(() => {
      const thread = store.get(threadId);
      if (thread?.turn?.status !== "running" || thread.turn.runId !== runId) return;
      const lease = thread.turn;
      thread.turn = { ...lease, status: "interrupted" };
      // The turn died somewhere between its last heartbeat and this boot; the
      // note is recorded now, below anything the dead turn persisted itself.
      const finishedAt = Math.min(now, Math.max(lease.startedAt, lease.lastHeartbeatAt ?? now));
      const note: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        timestamp: now,
        agent: thread.config.agent,
        activity: [
          {
            type: "status",
            id: crypto.randomUUID(),
            text: thread.runtimeId ? TURN_INTERRUPTED_NOTICE : TURN_INTERRUPTED_NOTICE_NO_SESSION,
          },
        ],
        turn: {
          startedAt: lease.startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - lease.startedAt),
          outcome: "interrupted",
        },
      };
      thread.messages.push(note);
      // Fenced by the epoch read in this same transaction: a newer turn that
      // claimed the thread makes this a no-op, not an overwrite.
      store.saveTurn(thread, lease.epoch ?? 0);
      applied = true;
    })();
  } catch (error) {
    // A newer turn claimed the thread between the scan and this write, or the
    // row is unreadable. Settling it is another turn's business now.
    logger.warn("Chat turn lease reconcile skipped a thread", { error, threadId });
    return false;
  }
  return applied;
}
