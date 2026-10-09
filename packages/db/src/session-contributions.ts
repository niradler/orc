import type { Database } from "bun:sqlite";
import { WikiStore } from "./wiki.js";

export function contributeStoppedSession(sqlite: Database, id: string): string | null {
  const row = sqlite
    .query<
      {
        id: string;
        project_id: string | null;
        status: string;
        summary: string | null;
        title: string | null;
        task_id: string | null;
        last_error: string | null;
        last_activity_at: number | null;
      },
      [string]
    >(
      "SELECT id,project_id,status,summary,title,task_id,last_error,last_activity_at FROM gateway_sessions WHERE id=? AND status IN ('stopped','error')",
    )
    .get(id);
  if (!row) return null;
  if (row.task_id) {
    const task = sqlite
      .query<{ skill_name: string | null }, [string]>("SELECT skill_name FROM tasks WHERE id=?")
      .get(row.task_id);
    if (task?.skill_name === "orc-wiki") return null;
  }
  const content = `# ${row.title ?? "Completed agent session"}\n\nStatus: ${row.status}\nLast activity: ${row.last_activity_at ?? "unknown"}\n\n${row.summary ?? "No session summary was captured. Inspect original transcript before deriving lessons."}${row.last_error ? `\n\nRecorded failure: ${row.last_error}` : ""}`;
  return new WikiStore(sqlite).enqueue({
    kind: "session",
    source_id: `gateway:${id}`,
    project_id: row.project_id,
    title: row.title ?? "Completed agent session",
    content,
    location: `orc://sessions/live/${id}`,
    tags: ["session-evidence"],
    metadata: { capture: "lifecycle-summary", status: row.status, task_id: row.task_id ?? "" },
  });
}
