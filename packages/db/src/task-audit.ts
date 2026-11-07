import type { Database } from "bun:sqlite";
import { type AuditActor, AuditLog } from "./audit.js";

type TaskState = { status: string; project_id: string | null };
type Sync<T> = T extends PromiseLike<unknown> ? never : T;

/** Audit only durable lifecycle changes, atomically with the explicit writer. */
export function withTaskAudit<T>(
  sqlite: Database,
  taskIds: readonly string[],
  mutate: () => Sync<T>,
  attribution: AuditActor = {},
): T {
  return sqlite
    .transaction(() => {
      const ids = [...new Set(taskIds)];
      const read = sqlite.query<TaskState, [string]>(
        "SELECT status,project_id FROM tasks WHERE id=?",
      );
      const before = ids.map((id) => read.get(id));
      const result = mutate();
      const audit = new AuditLog(sqlite);
      for (const [index, id] of ids.entries()) {
        const previous = before[index];
        const current = read.get(id);
        if (!current || previous?.status === current.status) continue;
        audit.record({
          action: previous ? "task.status_changed" : "task.created",
          subject_ids: [id],
          project_id: current.project_id,
          ...attribution,
          snapshot: previous
            ? { from: previous.status, status: current.status }
            : { status: current.status },
        });
      }
      return result;
    })
    .immediate() as T;
}
