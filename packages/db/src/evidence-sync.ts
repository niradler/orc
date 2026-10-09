import type { Database } from "bun:sqlite";
import { PassageIndex } from "./retrieval.js";

export function captureMemoryEvidence(
  sqlite: Database,
  id: string,
  index = new PassageIndex(sqlite),
): void {
  const memory = sqlite
    .query<
      {
        id: string;
        project_id: string | null;
        title: string | null;
        type: string;
        content: string;
        tags: string | null;
        expires_at: number | null;
        source: string | null;
        scope: string | null;
        importance: string;
        updated_at: number;
      },
      [string]
    >(
      "SELECT id,project_id,title,type,content,tags,expires_at,source,scope,importance,updated_at FROM memories WHERE id=?",
    )
    .get(id);
  if (!memory) return;
  index.put({
    kind: "memory",
    source_id: memory.id,
    project_id: memory.project_id,
    title: memory.title ?? memory.type,
    content: memory.content,
    location: `orc://memories/${memory.id}`,
    tags: memory.tags ? (JSON.parse(memory.tags) as string[]) : [],
    valid_until: memory.expires_at,
    metadata: {
      source: memory.source ?? "unknown",
      type: memory.type,
      scope: memory.scope ?? "",
      importance: memory.importance,
      updated_at: String(memory.updated_at),
    },
  });
}

export function syncProjectEvidence(
  sqlite: Database,
  projectId: string | null,
  index = new PassageIndex(sqlite),
): void {
  const memories = sqlite
    .query<{ id: string }, [string | null]>(
      "SELECT m.id FROM memories m LEFT JOIN evidence_sources s ON s.kind='memory' AND s.source_id=m.id WHERE m.project_id IS ? AND s.source_id IS NULL",
    )
    .all(projectId);
  sqlite.transaction(() => {
    for (const memory of memories) {
      captureMemoryEvidence(sqlite, memory.id, index);
    }
    sqlite
      .query(
        `UPDATE evidence_sources SET active=0 WHERE kind='memory' AND project_id IS ? AND source_id NOT IN (SELECT id FROM memories WHERE project_id IS ?)`,
      )
      .run(projectId, projectId);
  })();
}
