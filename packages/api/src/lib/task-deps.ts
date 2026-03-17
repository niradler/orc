import type { Database } from "bun:sqlite";

type BlockerInfo = { id: string; title: string; status: string };

export function checkBlockers(sqlite: Database, taskId: string): BlockerInfo[] {
  const rows = sqlite
    .query<{ id: string; title: string; status: string }, [string, string]>(
      `SELECT t.id, t.title, t.status
       FROM task_links tl
       JOIN tasks t ON t.id = tl.from_task_id
       WHERE tl.to_task_id = ? AND tl.link_type = 'blocks'
         AND t.status NOT IN ('done', 'cancelled')
       UNION
       SELECT t.id, t.title, t.status
       FROM task_links tl
       JOIN tasks t ON t.id = tl.to_task_id
       WHERE tl.from_task_id = ? AND tl.link_type = 'blocked_by'
         AND t.status NOT IN ('done', 'cancelled')`,
    )
    .all(taskId, taskId);
  return rows;
}

export function unblockDependents(sqlite: Database, completedTaskId: string): string[] {
  const dependents = sqlite
    .query<{ id: string }, [string, string]>(
      `SELECT DISTINCT dependent_id AS id FROM (
         SELECT tl.to_task_id AS dependent_id
         FROM task_links tl
         WHERE tl.from_task_id = ? AND tl.link_type = 'blocks'
         UNION
         SELECT tl.from_task_id AS dependent_id
         FROM task_links tl
         WHERE tl.to_task_id = ? AND tl.link_type = 'blocked_by'
       )`,
    )
    .all(completedTaskId, completedTaskId);

  const unblocked: string[] = [];
  for (const { id } of dependents) {
    const remainingBlockers = checkBlockers(sqlite, id);
    if (remainingBlockers.length === 0) {
      const task = sqlite
        .query<{ status: string }, string>("SELECT status FROM tasks WHERE id = ?")
        .get(id);
      if (task?.status === "blocked") {
        sqlite
          .query("UPDATE tasks SET status = 'todo', updated_at = unixepoch() WHERE id = ?")
          .run(id);
        unblocked.push(id);
      }
    }
  }
  return unblocked;
}

export function rollupParentProgress(sqlite: Database, taskId: string): string | null {
  const parentLink = sqlite
    .query<{ to_task_id: string }, string>(
      `SELECT tl.to_task_id FROM task_links tl
       WHERE tl.from_task_id = ? AND tl.link_type = 'subtask_of'
       LIMIT 1`,
    )
    .get(taskId);

  if (!parentLink) return null;
  const parentId = parentLink.to_task_id;

  const stats = sqlite
    .query<{ total: number; done: number }, string>(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN t.status IN ('done', 'cancelled') THEN 1 ELSE 0 END) as done
       FROM task_links tl
       JOIN tasks t ON t.id = tl.from_task_id
       WHERE tl.to_task_id = ? AND tl.link_type = 'subtask_of'`,
    )
    .get(parentId);

  if (!stats || stats.total === 0) return null;

  const progress = Math.round((stats.done / stats.total) * 100);
  sqlite
    .query("UPDATE tasks SET progress = ?, updated_at = unixepoch() WHERE id = ?")
    .run(progress, parentId);

  if (stats.done === stats.total) {
    const parent = sqlite
      .query<{ status: string }, string>("SELECT status FROM tasks WHERE id = ?")
      .get(parentId);
    if (parent && !["done", "cancelled", "review"].includes(parent.status)) {
      sqlite
        .query("UPDATE tasks SET status = 'review', updated_at = unixepoch() WHERE id = ?")
        .run(parentId);
    }
  }

  return parentId;
}
