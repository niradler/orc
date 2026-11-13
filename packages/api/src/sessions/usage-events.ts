import { ulid } from "@orc/core/ids";
import { USAGE_EVENT_VERSION } from "@orc/core/usage";
import { getSqlite } from "@orc/db/client";
import type { ParsedUsage, UsageEventInput } from "./usage-parsers.js";

const MAX_EVENTS_PER_SESSION = 5_000;

/** Keeps the ledger bounded without losing totals: old requests collapse into one row. */
function compact(events: UsageEventInput[]): UsageEventInput[] {
  if (events.length <= MAX_EVENTS_PER_SESSION) return events;
  const split = events.length - MAX_EVENTS_PER_SESSION + 1;
  const old = events.slice(0, split);
  const merged = events[split] ?? events[events.length - 1];
  if (!merged) return events;
  const combined: UsageEventInput = {
    key: "coalesced",
    ts: old[0]?.ts ?? merged.ts,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    otherTokens: 0,
    estimated: old.some((event) => event.estimated),
  };
  for (const event of old) {
    combined.inputTokens += event.inputTokens;
    combined.outputTokens += event.outputTokens;
    combined.cacheReadTokens += event.cacheReadTokens;
    combined.cacheWriteTokens += event.cacheWriteTokens;
    combined.reasoningTokens += event.reasoningTokens;
    combined.otherTokens += event.otherTokens;
  }
  return [combined, ...events.slice(split)];
}

export function writeSessionUsage(
  sessionId: string,
  agent: string,
  usage: ParsedUsage,
  version = USAGE_EVENT_VERSION,
): number {
  const events = compact(usage.events);
  const sqlite = getSqlite();
  sqlite
    .transaction(() => {
      sqlite.query("DELETE FROM usage_events WHERE session_id = ?").run(sessionId);
      const insert = sqlite.query(
        `INSERT INTO usage_events
           (id, session_id, event_key, agent, model, ts, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens, other_tokens,
            total_tokens, estimated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of events) {
        const total =
          event.inputTokens +
          event.outputTokens +
          event.cacheReadTokens +
          event.cacheWriteTokens +
          event.reasoningTokens +
          event.otherTokens;
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
          total,
          event.estimated ? 1 : 0,
        );
      }
      sqlite
        .query(
          "UPDATE gateway_sessions SET model = ?, usage_version = ?, usage_synced_at = ? WHERE id = ?",
        )
        .run(usage.model, version, Math.floor(Date.now() / 1000), sessionId);
    })
    .immediate();
  return events.length;
}
