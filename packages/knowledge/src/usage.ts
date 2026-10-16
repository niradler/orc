import type { Database } from "bun:sqlite";
import {
  KB_CALL_SOURCES,
  KB_READ_KINDS,
  type KbCallContext,
  type KbReadKind,
  type KbUsageCounts,
  type KbUsageStats,
} from "@orc/core/kb";

const DAY = 86_400_000;

export type UsageTarget = { document_id: string; kb_id: string; revision: number };

const emptyCounts = (): KbUsageCounts =>
  Object.fromEntries(
    KB_CALL_SOURCES.map((s) => [s, Object.fromEntries(KB_READ_KINDS.map((k) => [k, 0]))]),
  ) as KbUsageCounts;

/**
 * Read accounting. Every served read records one raw event (who, through which transport, which
 * revision) and bumps a lifetime total; raw events are pruned after the retention window while
 * totals are kept, so "read by MCP 3 times, by the API 5 times" survives pruning.
 */
export class Usage {
  constructor(private readonly db: Database) {}

  record(ctx: KbCallContext, kind: KbReadKind, targets: UsageTarget[]) {
    if (!targets.length) return;
    const now = Date.now();
    const event = this.db.query(
      `INSERT INTO kb_usage_events (document_id, kb_id, revision, kind, source, backend, session_id, task_id, project_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const total = this.db.query(
      `INSERT INTO kb_usage_totals (document_id, kb_id, source, kind, count, last_at) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(document_id, source, kind) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
    );
    const seen = new Set<string>();
    this.db.transaction(() => {
      for (const t of targets) {
        // One event per document per call: three passages of one document are one read.
        if (seen.has(t.document_id)) continue;
        seen.add(t.document_id);
        event.run(
          t.document_id,
          t.kb_id,
          t.revision,
          kind,
          ctx.source,
          ctx.actor.backend ?? null,
          ctx.actor.session_id ?? null,
          ctx.actor.task_id ?? null,
          ctx.project_id ?? null,
          now,
        );
        total.run(t.document_id, t.kb_id, ctx.source, kind, now);
      }
    })();
  }

  /** Stats for one document, or aggregated over a KB. */
  stats(where: { document_id: string } | { kb_id: string }): KbUsageStats {
    const [col, id] =
      "document_id" in where ? ["document_id", where.document_id] : ["kb_id", where.kb_id];
    const totals = emptyCounts();
    const last: KbUsageStats["last_read_at"] = {};
    let reads = 0;
    let exposures = 0;
    const rows = this.db
      .query(
        `SELECT source, kind, sum(count) AS n, max(last_at) AS last FROM kb_usage_totals WHERE ${col} = ? GROUP BY source, kind`,
      )
      .all(id) as { source: keyof KbUsageCounts; kind: KbReadKind; n: number; last: number }[];
    for (const r of rows) {
      const bySource = totals[r.source];
      if (!bySource) continue;
      bySource[r.kind] = r.n;
      if (r.kind === "search_hit") exposures += r.n;
      else {
        reads += r.n;
        last[r.source] = Math.max(last[r.source] ?? 0, r.last);
      }
    }
    const now = Date.now();
    const recent = this.db
      .query(
        `SELECT sum(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS d7, count(*) AS d30
         FROM kb_usage_events WHERE ${col} = ? AND kind != 'search_hit' AND created_at >= ?`,
      )
      .get(now - 7 * DAY, id, now - 30 * DAY) as { d7: number | null; d30: number };
    const sessions = this.db
      .query(
        `SELECT count(DISTINCT session_id) AS n FROM kb_usage_events WHERE ${col} = ? AND kind != 'search_hit' AND session_id IS NOT NULL`,
      )
      .get(id) as { n: number };
    return {
      reads,
      exposures,
      totals,
      last_read_at: last,
      distinct_sessions: sessions.n,
      window: { days_7: recent.d7 ?? 0, days_30: recent.d30 },
    };
  }

  /** Per-document headline numbers for list views: reads (fetch + cited) and by-source split. */
  documentReads(kbId: string): Map<string, { reads: number; by_source: Record<string, number> }> {
    const out = new Map<string, { reads: number; by_source: Record<string, number> }>();
    const rows = this.db
      .query(
        `SELECT document_id, source, sum(count) AS n FROM kb_usage_totals
         WHERE kb_id = ? AND kind != 'search_hit' GROUP BY document_id, source`,
      )
      .all(kbId) as { document_id: string; source: string; n: number }[];
    for (const r of rows) {
      const e = out.get(r.document_id) ?? { reads: 0, by_source: {} };
      e.reads += r.n;
      e.by_source[r.source] = r.n;
      out.set(r.document_id, e);
    }
    return out;
  }

  prune(retentionDays: number) {
    if (retentionDays <= 0) return 0;
    return this.db.run("DELETE FROM kb_usage_events WHERE created_at < ?", [
      Date.now() - retentionDays * DAY,
    ]).changes;
  }

  forgetDocument(documentId: string) {
    this.db.run("DELETE FROM kb_usage_events WHERE document_id = ?", [documentId]);
    this.db.run("DELETE FROM kb_usage_totals WHERE document_id = ?", [documentId]);
  }

  forgetKb(kbId: string) {
    this.db.run("DELETE FROM kb_usage_events WHERE kb_id = ?", [kbId]);
    this.db.run("DELETE FROM kb_usage_totals WHERE kb_id = ?", [kbId]);
  }
}
