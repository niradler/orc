import type { Database } from "bun:sqlite";
import { type ChatThread, ChatThreadSchema } from "@orc/core/chat";

type ChatSummary = Pick<ChatThread, "id" | "title" | "updatedAt"> & {
  agent: string | null;
  runtimeId: string | null;
  sourceId: string | null;
  host: string | null;
  projectId: string | null;
  cwd: string | null;
};

export function installChat(sqlite: Database): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  sqlite.exec("CREATE INDEX IF NOT EXISTS chat_threads_updated_idx ON chat_threads(updated_at)");
}
export class ChatStore {
  constructor(private readonly db: Database) {}
  get(id: string): ChatThread | null {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM chat_threads WHERE id = ?")
      .get(id);
    return row ? ChatThreadSchema.parse(JSON.parse(row.data)) : null;
  }
  list(): ChatSummary[] {
    return this.db
      .query<ChatSummary, []>(
        `SELECT id, title, updated_at AS updatedAt,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.config.agent') = 'text'
              THEN json_extract(data, '$.config.agent') END
          END AS agent,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.runtimeId') = 'text'
              THEN json_extract(data, '$.runtimeId') END
          END AS runtimeId,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.sourceId') = 'text'
              THEN json_extract(data, '$.sourceId') END
          END AS sourceId,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.host') = 'text'
              THEN json_extract(data, '$.host') END
          END AS host,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.projectId') = 'text'
              THEN json_extract(data, '$.projectId') END
          END AS projectId,
          CASE WHEN json_valid(data) THEN
            CASE WHEN json_type(data, '$.cwd') = 'text'
              THEN json_extract(data, '$.cwd') END
          END AS cwd
        FROM chat_threads ORDER BY updated_at DESC LIMIT 100`,
      )
      .all();
  }
  byRuntime(backend: string, host: string | null, runtimeId: string): ChatThread[] {
    return this.db
      .query<{ id: string }, [string, string, string]>(
        `SELECT id FROM chat_threads WHERE json_valid(data)
          AND json_extract(data, '$.runtimeId')=? AND json_extract(data, '$.backend')=?
          AND coalesce(json_extract(data, '$.host'), '')=?`,
      )
      .all(runtimeId, backend, host ?? "")
      .flatMap((row) => this.get(row.id) ?? []);
  }
  byMessage(messageId: string): ChatThread | null {
    const row = this.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM chat_threads WHERE json_valid(data) AND EXISTS (SELECT 1 FROM
          json_each(data,'$.messages') WHERE json_extract(value,'$.id')=? AND
          json_extract(value,'$.role')='user') ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(messageId);
    return row ? this.get(row.id) : null;
  }
  save(thread: ChatThread): void {
    this.db
      .query(
        "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, data=excluded.data",
      )
      .run(thread.id, thread.title, thread.updatedAt, JSON.stringify(thread));
  }
}
