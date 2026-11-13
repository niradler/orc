import { ulid } from "@orc/core/ids";
import { USAGE_EVENT_VERSION, USAGE_RAW_RETENTION_DAYS } from "@orc/core/usage";
import { getSqlite } from "@orc/db/client";
import type { ParsedUsage, UsageEventInput } from "./usage-parsers.js";

/**
 * Raw rows older than the retention window are rolled up per session, UTC day and
 * model. Recent requests stay per-request so hour buckets and model details remain
 * exact. 5k rows per session bounds a very chatty session inside the window by
 * compacting its oldest rows per model.
 */
const MAX_EVENTS_PER_SESSION = 5_000;
const DAY_MS = 86_400_000;
const RETENTION_SWEEP_LIMIT = 100;

type Resolution = "request" | "rollup";

type LedgerEvent = UsageEventInput & {
  requests: number;
  estimatedRequests: number;
  resolution: Resolution;
};

type StoredRow = {
  event_key: string;
  model: string | null;
  ts: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  other_tokens: number;
  requests: number;
  estimated_requests: number;
  resolution: Resolution;
  estimated: number;
};

function total(event: LedgerEvent): number {
  return (
    event.inputTokens +
    event.outputTokens +
    event.cacheReadTokens +
    event.cacheWriteTokens +
    event.reasoningTokens +
    event.otherTokens
  );
}

function asLedger(event: UsageEventInput): LedgerEvent {
  return {
    ...event,
    requests: 1,
    estimatedRequests: event.estimated ? 1 : 0,
    resolution: "request",
  };
}

function emptyGroup(key: string, ts: number, model: string | null): LedgerEvent {
  return {
    key,
    ts,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    otherTokens: 0,
    estimated: false,
    requests: 0,
    estimatedRequests: 0,
    resolution: "request",
  };
}

function accumulate(target: LedgerEvent, source: LedgerEvent): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.otherTokens += source.otherTokens;
  target.requests += source.requests;
  target.estimatedRequests += source.estimatedRequests;
  target.estimated ||= source.estimated;
}

function utcDay(ts: number): string {
  const date = new Date(Number.isFinite(ts) ? ts : 0);
  return date.toISOString().slice(0, 10);
}

/** Groups a sorted slice into one row per key while keeping the model and day. */
function group(
  events: readonly LedgerEvent[],
  keyOf: (event: LedgerEvent) => string,
  tsOf: (event: LedgerEvent) => number,
): LedgerEvent[] {
  const groups = new Map<string, LedgerEvent>();
  for (const event of events) {
    const groupKey = keyOf(event);
    let row = groups.get(groupKey);
    if (!row) {
      row = emptyGroup(`rollup:${groupKey}`.slice(0, 300), tsOf(event), event.model);
      row.resolution = "rollup";
      groups.set(groupKey, row);
    }
    accumulate(row, event);
  }
  return [...groups.values()].sort((a, b) => a.ts - b.ts);
}

/** Old requests keep their UTC day and model for the selected-period reports. */
function rollupByDay(events: readonly LedgerEvent[]): LedgerEvent[] {
  return group(
    events,
    (event) => `day:${utcDay(event.ts)}|${event.model ?? ""}`,
    (event) => Date.parse(`${utcDay(event.ts)}T00:00:00Z`),
  );
}

/** Last-resort compaction for an unusually chatty session: keep the model, drop the day. */
function rollupByModel(events: readonly LedgerEvent[]): LedgerEvent[] {
  return group(
    events,
    (event) => `model:${event.model ?? ""}`,
    (event) => event.ts,
  );
}

function compact(events: LedgerEvent[]): LedgerEvent[] {
  if (events.length <= MAX_EVENTS_PER_SESSION) return events;
  const split = events.length - MAX_EVENTS_PER_SESSION + 1;
  return [...rollupByModel(events.slice(0, split)), ...events.slice(split)];
}

function rebalance(events: readonly LedgerEvent[], now: number): LedgerEvent[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const cutoff = now - USAGE_RAW_RETENTION_DAYS * DAY_MS;
  const old = sorted.filter((event) => event.ts < cutoff);
  if (!old.length) return compact(sorted);
  const recent = sorted.filter((event) => event.ts >= cutoff);
  return compact([...rollupByDay(old), ...recent]);
}

function replaceSessionRows(
  sqlite: ReturnType<typeof getSqlite>,
  sessionId: string,
  agent: string,
  events: readonly LedgerEvent[],
): void {
  sqlite.query("DELETE FROM usage_events WHERE session_id = ?").run(sessionId);
  const insert = sqlite.query(
    `INSERT INTO usage_events
       (id, session_id, event_key, agent, model, ts, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
        total_tokens, requests, estimated_requests, resolution, estimated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    insert.run(
      ulid(),
      sessionId,
      event.key.slice(0, 300),
      agent,
      event.model,
      Math.max(0, Math.round(event.ts)),
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.reasoningTokens,
      event.otherTokens,
      total(event),
      event.requests,
      event.estimatedRequests,
      event.resolution,
      event.estimated ? 1 : 0,
    );
  }
}

function readSessionEvents(sessionId: string): LedgerEvent[] {
  return getSqlite()
    .query<StoredRow, [string]>(
      `SELECT event_key, model, ts, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, reasoning_tokens, other_tokens, requests,
              estimated_requests, resolution, estimated
       FROM usage_events WHERE session_id = ? ORDER BY ts`,
    )
    .all(sessionId)
    .map((row) => ({
      key: row.event_key,
      ts: row.ts,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      reasoningTokens: row.reasoning_tokens,
      otherTokens: row.other_tokens,
      estimated: row.estimated === 1,
      requests: row.requests,
      estimatedRequests: row.estimated_requests,
      resolution: row.resolution,
    }));
}

export function writeSessionUsage(
  sessionId: string,
  agent: string,
  usage: ParsedUsage,
  version = USAGE_EVENT_VERSION,
  now = Date.now(),
): number {
  const events = rebalance(usage.events.map(asLedger), now);
  const sqlite = getSqlite();
  sqlite
    .transaction(() => {
      replaceSessionRows(sqlite, sessionId, agent, events);
      sqlite
        .query(
          "UPDATE gateway_sessions SET model = ?, usage_version = ?, usage_synced_at = ? WHERE id = ?",
        )
        .run(usage.model, version, Math.floor(Date.now() / 1000), sessionId);
    })
    .immediate();
  return events.length;
}

/**
 * Moves raw requests that aged past the retention window without a session re-index.
 * The ledger totals do not change, so no usage change event is published.
 */
export function maintainUsageRetention(now = Date.now()): number {
  const sqlite = getSqlite();
  const cutoff = now - USAGE_RAW_RETENTION_DAYS * DAY_MS;
  const sessions = sqlite
    .query<{ session_id: string; agent: string }, [number]>(
      `SELECT session_id, max(agent) AS agent
       FROM usage_events
       WHERE resolution = 'request' AND ts < ?
       GROUP BY session_id
       LIMIT ${RETENTION_SWEEP_LIMIT}`,
    )
    .all(cutoff);
  let migrated = 0;
  for (const { session_id, agent } of sessions) {
    const events = readSessionEvents(session_id);
    if (!events.some((event) => event.resolution === "request" && event.ts < cutoff)) continue;
    const next = rebalance(events, now);
    sqlite.transaction(() => replaceSessionRows(sqlite, session_id, agent, next)).immediate();
    migrated += 1;
  }
  return migrated;
}
