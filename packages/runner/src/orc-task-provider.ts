import type {
  PickedTask,
  TaskProvider,
  TaskStatusUpdateOpts,
  TaskStatusUpdateResult,
} from "@orc/core";
import { getDb, getSqlite } from "@orc/db/client";
import { tasks } from "@orc/db/schema";
import { addTaskComment, updateTaskStatus as _updateTaskStatus } from "@orc/task-service";
import { eq } from "drizzle-orm";

export class OrcTaskProvider implements TaskProvider {
  async pickWorkTasks(): Promise<PickedTask[]> {
    const sqlite = getSqlite();
    return sqlite
      .query(
        `SELECT t.id, t.title, t.body, t.status, t.skill_name, t.agent_backend, t.agent_model, t.tags, t.project_id
         FROM tasks t
         WHERE (t.status = 'todo' OR t.status = 'changes_requested')
           AND t.claimed_by IS NULL
           AND (t.skill_name IS NOT NULL OR t.agent_backend IS NOT NULL
                OR EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = 'agent'))
           AND NOT EXISTS (
             SELECT 1 FROM (
               SELECT tl.from_task_id AS blocker_id FROM task_links tl WHERE tl.to_task_id = t.id AND tl.link_type = 'blocks'
               UNION
               SELECT tl.to_task_id AS blocker_id FROM task_links tl WHERE tl.from_task_id = t.id AND tl.link_type = 'blocked_by'
             ) b JOIN tasks blocker ON blocker.id = b.blocker_id
             WHERE blocker.status NOT IN ('done', 'cancelled')
           )
         ORDER BY
           CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           t.created_at ASC`,
      )
      .all() as PickedTask[];
  }

  async pickReviewTasks(): Promise<PickedTask[]> {
    const sqlite = getSqlite();
    return sqlite
      .query(
        `SELECT t.id, t.title, t.body, t.status, t.skill_name, t.agent_backend, t.agent_model, t.tags, t.project_id
         FROM tasks t
         WHERE t.status = 'review'
           AND t.claimed_by IS NULL
         ORDER BY
           CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           t.updated_at ASC`,
      )
      .all() as PickedTask[];
  }

  async claimTask(taskId: string, sessionId: string): Promise<void> {
    getSqlite()
      .query("UPDATE tasks SET claimed_by = ?, updated_at = unixepoch() WHERE id = ?")
      .run(sessionId, taskId);
  }

  async releaseTask(taskId: string): Promise<void> {
    getSqlite()
      .query("UPDATE tasks SET claimed_by = NULL, updated_at = unixepoch() WHERE id = ?")
      .run(taskId);
  }

  async updateTaskStatus(opts: TaskStatusUpdateOpts): Promise<TaskStatusUpdateResult> {
    const result = await _updateTaskStatus(opts);
    return result.error !== undefined ? { ok: result.ok, error: result.error } : { ok: result.ok };
  }

  async addComment(taskId: string, comment: string, author: string): Promise<void> {
    await addTaskComment(taskId, comment, author);
  }

  async getTask(taskId: string): Promise<PickedTask | null> {
    const db = getDb();
    const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      body: row.body ?? null,
      status: row.status,
      skill_name: row.skill_name ?? null,
      agent_backend: row.agent_backend ?? null,
      agent_model: row.agent_model ?? null,
      tags: row.tags ? JSON.stringify(row.tags) : null,
      project_id: row.project_id ?? null,
    };
  }
}
