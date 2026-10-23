import { loadConfig } from "@orc/core/config";
import { execHostFor, hostRuntime } from "@orc/core/exec-host";
import { getSqlite } from "@orc/db/client";
import { getSessionArchive } from "./archive.js";
import { LIVE_CHAT_ID } from "./common.js";

type ScanResult = { indexed: number; failed: number; skipped: number };
let running = Promise.resolve();
const pending = new Map<string | undefined, Promise<ScanResult>>();
const stamps = new Map<string, string>();

export function indexDiscoveredSessions(projectId?: string) {
  const existing = pending.get(projectId);
  if (existing) return existing;
  const result = running
    .then(() => scan(projectId))
    .finally(() => {
      pending.delete(projectId);
    });
  pending.set(projectId, result);
  running = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function scan(projectId?: string) {
  const db = getSqlite();
  const svc = await getSessionArchive();
  const result = { indexed: 0, failed: 0, skipped: 0 };
  for (let offset = 0; ; offset += 100) {
    const rows = db
      .query<
        {
          id: string;
          name: string;
          backend: "claude" | "codex";
          runtime_session_id: string;
          transcript_path: string;
          title: string | null;
          cwd: string | null;
          execution_host: string | null;
        },
        (string | number)[]
      >(
        `SELECT g.*, p.name FROM gateway_sessions g JOIN projects p ON p.id = g.project_id WHERE g.chat_id = ? AND g.backend IN ('claude','codex') AND g.transcript_path IS NOT NULL ${projectId ? "AND g.project_id = ?" : ""} ORDER BY g.id LIMIT 100 OFFSET ?`,
      )
      .all(LIVE_CHAT_ID, ...(projectId ? [projectId] : []), offset);
    if (!rows.length) break;
    for (const row of rows) {
      if (!/^[a-f0-9-]{36}$/i.test(row.runtime_session_id)) {
        result.skipped++;
        continue;
      }
      try {
        const runtime = hostRuntime(execHostFor(row.execution_host));
        const before = await runtime.stat(row.transcript_path);
        if (!before) {
          result.skipped++;
          continue;
        }
        const key = `${row.execution_host ?? "local"}:${row.transcript_path}`;
        const stamp = `${before.size}:${before.mtimeMs}`;
        if (stamps.get(key) === stamp) {
          result.skipped++;
          continue;
        }
        const bytes = await runtime.readFile(row.transcript_path, 60 * 1024 * 1024);
        const after = await runtime.stat(row.transcript_path);
        if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          result.skipped++;
          continue;
        }
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const status = await svc.ingest({
          project: row.name,
          source_id: `orc-host:${row.execution_host ?? "local"}`,
          agent: row.backend,
          session_id: row.runtime_session_id,
          title: row.title || row.runtime_session_id,
          metadata: { ...(row.cwd ? { cwd: row.cwd } : {}), subdirectory: "" },
          bundle: { version: 1, files: [{ path: "session.jsonl", content }] },
        });
        if (status.outcome === "conflict") result.failed++;
        else {
          result.indexed++;
          stamps.set(key, stamp);
        }
      } catch {
        result.failed++;
      }
    }
  }
  return result;
}

export function indexSessionsWhenEnabled() {
  if (loadConfig().knowledge.session_embeddings) void indexDiscoveredSessions().catch(() => {});
}
