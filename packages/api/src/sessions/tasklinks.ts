import { getDb } from "@orc/db/client";
import { tasks } from "@orc/db/schema";
import { like } from "drizzle-orm";

type TaskRow = typeof tasks.$inferSelect;

const SESSION_LINE = /^session:[ \t]*(.+)$/gm;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function sessionIdsIn(body: string | null): string[] {
  const ids = new Set<string>();
  for (const line of (body ?? "").matchAll(SESSION_LINE)) {
    for (const id of line[1]?.match(UUID) ?? []) ids.add(id.toLowerCase());
  }
  return [...ids];
}

async function tasksWithSessionLines(): Promise<TaskRow[]> {
  return getDb().query.tasks.findMany({ where: like(tasks.body, "%session:%") });
}

export async function bodyLinkIndex(): Promise<Map<string, TaskRow>> {
  const index = new Map<string, TaskRow>();
  for (const task of await tasksWithSessionLines()) {
    for (const id of sessionIdsIn(task.body)) {
      const current = index.get(id);
      if (!current || task.updated_at > current.updated_at) index.set(id, task);
    }
  }
  return index;
}

export async function sessionIdsOfTask(taskId: string): Promise<string[]> {
  const task = (await tasksWithSessionLines()).find((t) => t.id === taskId);
  return task ? sessionIdsIn(task.body) : [];
}
