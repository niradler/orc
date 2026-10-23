import type { Database } from "bun:sqlite";
import { type ChatThread, ChatThreadSchema } from "@orc/core/chat";

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
  list(): { id: string; title: string; updatedAt: number }[] {
    return this.db
      .query<{ id: string; title: string; updatedAt: number }, []>(
        "SELECT id, title, updated_at AS updatedAt FROM chat_threads ORDER BY updated_at DESC LIMIT 100",
      )
      .all();
  }
  save(thread: ChatThread): void {
    this.db
      .query(
        "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, data=excluded.data",
      )
      .run(thread.id, thread.title, thread.updatedAt, JSON.stringify(thread));
  }
}
