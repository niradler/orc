import type { Database } from "bun:sqlite";
import { ConflictError } from "@orc/core/errors";
import { createLogger } from "@orc/core/logger";
import { getDb, getSqlite } from "@orc/db/client";
import { detachLegacyKnowledgeCollections, projectKbCount } from "@orc/db/kb";
import { MemoryStore } from "@orc/db/memories";
import { deleteProjectSecrets } from "@orc/db/project-secrets";
import {
  bridge_chats,
  comments,
  gateway_sessions,
  jobs,
  projects,
  sessions,
  tasks,
} from "@orc/db/schema";
import { withTx } from "@orc/db/tx";
import { deleteProjectWorkspaceEnvironments } from "@orc/db/workspaces";
import { and, eq } from "drizzle-orm";
import { invalidateProjectFolderCache } from "./sessions/common.js";

const logger = createLogger("api:projects");

/** Assigned skills block deletion: they are deliberate, project-scoped choices. */
export function projectSkillCount(sqlite: Database, projectId: string): number {
  return (
    sqlite
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM skill_projects WHERE project_id=?",
      )
      .get(projectId)?.count ?? 0
  );
}

/**
 * Permanently removes a project and everything scoped to it. Tasks, jobs, sessions and
 * bridge chats survive unassigned; memories and scratchpads go with the project.
 * Knowledge bases and assigned skills are deliberately scoped and block the purge.
 *
 * Callers schedule this (project_delete / DELETE ?ttl_days) or run it directly with
 * ttl_days=0. The maintenance sweep calls it once delete_after passes.
 */
export function purgeProject(id: string): void {
  const db = getDb();
  const sqlite = getSqlite();
  if (!sqlite.query("SELECT 1 FROM projects WHERE id=?").get(id)) return;
  const assignedSkills = projectSkillCount(sqlite, id);
  if (assignedSkills > 0)
    throw new ConflictError(`Project has ${assignedSkills} assigned skills; reassign them first`);
  const kbs = projectKbCount(sqlite, id);
  if (kbs > 0)
    throw new ConflictError(
      `Project has ${kbs} knowledge base${kbs === 1 ? "" : "s"}; delete them first`,
    );
  withTx((tx) => {
    tx.update(tasks).set({ project_id: null }).where(eq(tasks.project_id, id)).run();
    // Memories belong to one project, so they go with it (with their history and reads).
    new MemoryStore(sqlite).removeProject(id);
    // Scratchpads go with it too, through their ON DELETE CASCADE foreign key.
    tx.update(jobs).set({ project_id: null }).where(eq(jobs.project_id, id)).run();
    tx.update(sessions).set({ project_id: null }).where(eq(sessions.project_id, id)).run();
    tx.update(gateway_sessions)
      .set({ project_id: null })
      .where(eq(gateway_sessions.project_id, id))
      .run();
    sqlite
      .query(
        "UPDATE chat_threads SET data=json_remove(data, '$.projectId') WHERE json_valid(data) AND json_extract(data, '$.projectId')=?",
      )
      .run(id);
    sqlite.query("UPDATE notifications SET project_id=NULL WHERE project_id=?").run(id);
    tx.update(bridge_chats).set({ project_id: null }).where(eq(bridge_chats.project_id, id)).run();
    detachLegacyKnowledgeCollections(sqlite, id);
    deleteProjectWorkspaceEnvironments(sqlite, id);
    deleteProjectSecrets(sqlite, id);
    tx.delete(comments)
      .where(and(eq(comments.resource_type, "project"), eq(comments.resource_id, id)))
      .run();
    tx.delete(projects).where(eq(projects.id, id)).run();
  }, db);
  invalidateProjectFolderCache();
}

/**
 * Purges projects whose scheduled deletion has come due. A project that gained
 * knowledge bases or assigned skills since it was scheduled stays archived: its
 * schedule is cancelled rather than retried every minute, and the reason is logged.
 */
export function purgeExpiredProjects(sqlite: Database = getSqlite()): string[] {
  const due = sqlite
    .query<{ id: string; name: string }, []>(
      "SELECT id, name FROM projects WHERE delete_after IS NOT NULL AND delete_after <= unixepoch()",
    )
    .all();
  const purged: string[] = [];
  for (const project of due) {
    try {
      purgeProject(project.id);
      purged.push(project.id);
      logger.info(`Purged archived project ${project.name} after its delete-after date`);
    } catch (error) {
      sqlite.query("UPDATE projects SET delete_after=NULL WHERE id=?").run(project.id);
      logger.warn(
        `Scheduled deletion of project ${project.name} was cancelled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return purged;
}
