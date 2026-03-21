import { ulid } from "@orc/core/ids";
import { TASK_STATUS_TRANSITIONS, type TaskStatus } from "@orc/core/types";
import { getDb, getSqlite } from "@orc/db/client";
import { comments, tasks } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { notifyReview } from "./notifications.js";

export type TransitionOpts = {
  taskId: string;
  status: TaskStatus;
  comment?: string | undefined;
  author?: string | undefined;
  claimedBy?: string | undefined;
};

export type TransitionResult = {
  ok: boolean;
  error?: string | undefined;
  task?: typeof tasks.$inferSelect | undefined;
};

export async function addTaskComment(
  taskId: string,
  content: string,
  author = "agent",
): Promise<string> {
  const db = getDb();
  const id = ulid();
  await db.insert(comments).values({
    id,
    resource_type: "task",
    resource_id: taskId,
    content,
    author,
    created_at: new Date(),
  });
  return id;
}

export async function updateTaskStatus(opts: TransitionOpts): Promise<TransitionResult> {
  const db = getDb();
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, opts.taskId) });
  if (!task) return { ok: false, error: `Task not found: ${opts.taskId}` };

  const currentStatus = task.status as TaskStatus;
  const allowed = TASK_STATUS_TRANSITIONS[currentStatus];
  if (!allowed?.includes(opts.status)) {
    return { ok: false, error: `Cannot transition from ${currentStatus} to ${opts.status}` };
  }

  if (opts.status === "doing") {
    const sqlite = getSqlite();
    const blockers = sqlite
      .query(
        `SELECT t.id, t.title FROM task_links tl JOIN tasks t ON t.id = tl.from_task_id
         WHERE tl.to_task_id = ? AND tl.link_type = 'blocks' AND t.status NOT IN ('done', 'cancelled')
         UNION
         SELECT t.id, t.title FROM task_links tl JOIN tasks t ON t.id = tl.to_task_id
         WHERE tl.from_task_id = ? AND tl.link_type = 'blocked_by' AND t.status NOT IN ('done', 'cancelled')`,
      )
      .all(opts.taskId, opts.taskId) as { id: string; title: string }[];
    if (blockers.length > 0) {
      const names = blockers.map((b) => `[${b.id.slice(-6)}] ${b.title}`).join(", ");
      return { ok: false, error: `Cannot start: blocked by ${names}` };
    }
  }

  const now = new Date();
  const updates: Record<string, unknown> = { status: opts.status, updated_at: now };

  if ((opts.status === "doing" || opts.status === "queued") && opts.claimedBy) {
    updates.claimed_by = opts.claimedBy;
  }
  if (opts.status === "todo" && (currentStatus === "doing" || currentStatus === "queued")) {
    updates.claimed_by = null;
  }
  if (opts.status === "paused") {
    updates.claimed_by = null;
  }

  await db.update(tasks).set(updates).where(eq(tasks.id, opts.taskId));

  if (opts.comment) {
    await addTaskComment(opts.taskId, opts.comment, opts.author ?? "agent");
  }

  if (opts.status === "review") {
    const refreshed = await db.query.tasks.findFirst({ where: eq(tasks.id, opts.taskId) });
    if (refreshed?.required_review) {
      notifyReview(opts.taskId, task.title).catch((err) => {
        console.error(`notifyReview failed for task ${opts.taskId}: ${String(err)}`);
      });
    }
  }

  if (["done", "cancelled"].includes(opts.status)) {
    const sqlite = getSqlite();
    const dependents = sqlite
      .query(
        `SELECT DISTINCT dependent_id AS id FROM (
         SELECT tl.to_task_id AS dependent_id FROM task_links tl WHERE tl.from_task_id = ? AND tl.link_type = 'blocks'
         UNION SELECT tl.from_task_id AS dependent_id FROM task_links tl WHERE tl.to_task_id = ? AND tl.link_type = 'blocked_by'
       )`,
      )
      .all(opts.taskId, opts.taskId) as { id: string }[];
    for (const dep of dependents) {
      const remaining = sqlite
        .query(
          `SELECT 1 FROM task_links tl JOIN tasks t ON t.id = tl.from_task_id
         WHERE tl.to_task_id = ? AND tl.link_type = 'blocks' AND t.status NOT IN ('done','cancelled') LIMIT 1`,
        )
        .get(dep.id);
      if (!remaining) {
        const depTask = sqlite.query("SELECT status FROM tasks WHERE id = ?").get(dep.id) as {
          status: string;
        } | null;
        if (depTask?.status === "blocked") {
          sqlite
            .query("UPDATE tasks SET status = 'todo', updated_at = unixepoch() WHERE id = ?")
            .run(dep.id);
        }
      }
    }
    const parentLink = sqlite
      .query(
        "SELECT tl.to_task_id FROM task_links tl WHERE tl.from_task_id = ? AND tl.link_type = 'subtask_of' LIMIT 1",
      )
      .get(opts.taskId) as { to_task_id: string } | null;
    if (parentLink) {
      const stats = sqlite
        .query(
          `SELECT COUNT(*) as total, SUM(CASE WHEN t.status IN ('done','cancelled') THEN 1 ELSE 0 END) as done
         FROM task_links tl JOIN tasks t ON t.id = tl.from_task_id WHERE tl.to_task_id = ? AND tl.link_type = 'subtask_of'`,
        )
        .get(parentLink.to_task_id) as { total: number; done: number } | null;
      if (stats && stats.total > 0) {
        const progress = Math.round((stats.done / stats.total) * 100);
        sqlite
          .query("UPDATE tasks SET progress = ?, updated_at = unixepoch() WHERE id = ?")
          .run(progress, parentLink.to_task_id);
        if (stats.done === stats.total) {
          const parent = sqlite
            .query("SELECT status FROM tasks WHERE id = ?")
            .get(parentLink.to_task_id) as { status: string } | null;
          if (parent && !["done", "cancelled", "review"].includes(parent.status)) {
            sqlite
              .query("UPDATE tasks SET status = 'review', updated_at = unixepoch() WHERE id = ?")
              .run(parentLink.to_task_id);
          }
        }
      }
    }
  }

  if (opts.status === "changes_requested") {
    const sqlite = getSqlite();
    const maxRounds = task.max_review_rounds ?? 3;
    const session = sqlite
      .query(
        "SELECT id, review_rounds FROM gateway_sessions WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(opts.taskId) as { id: string; review_rounds: number } | null;
    if (session && maxRounds > 0) {
      const newRounds = session.review_rounds + 1;
      sqlite
        .query("UPDATE gateway_sessions SET review_rounds = ? WHERE id = ?")
        .run(newRounds, session.id);
      if (newRounds >= maxRounds) {
        await db
          .update(tasks)
          .set({ status: "paused", claimed_by: null, updated_at: now })
          .where(eq(tasks.id, opts.taskId));
        await addTaskComment(
          opts.taskId,
          `Task exceeded max review rounds (${maxRounds}). Paused for manual attention.`,
          "system",
        );
      }
    }
  }

  const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, opts.taskId) });
  return { ok: true, task: updated ?? undefined };
}
