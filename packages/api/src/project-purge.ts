import type { Database } from "bun:sqlite";
import { ConflictError } from "@orc/core/errors";
import { getSqlite } from "@orc/db/client";
import { detachLegacyKnowledgeCollections, projectKbCount } from "@orc/db/kb";
import { MemoryStore } from "@orc/db/memories";
import { deleteProjectSecrets } from "@orc/db/project-secrets";
import { withSqliteTx } from "@orc/db/tx";
import { deleteProjectWorkspaceEnvironments } from "@orc/db/workspaces";
import { invalidateProjectFolderCache } from "./sessions/common.js";

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
 * ttl_days=0. The TTL sweep calls it once delete_after passes.
 */
export function purgeProject(id: string, sqlite: Database = getSqlite()): void {
  if (!sqlite.query("SELECT 1 FROM projects WHERE id=?").get(id)) return;
  const assignedSkills = projectSkillCount(sqlite, id);
  if (assignedSkills > 0)
    throw new ConflictError(`Project has ${assignedSkills} assigned skills; reassign them first`);
  const kbs = projectKbCount(sqlite, id);
  if (kbs > 0)
    throw new ConflictError(
      `Project has ${kbs} knowledge base${kbs === 1 ? "" : "s"}; delete them first`,
    );
  withSqliteTx(() => {
    sqlite.query("UPDATE tasks SET project_id=NULL WHERE project_id=?").run(id);
    // Memories belong to one project, so they go with it (with their history and reads).
    new MemoryStore(sqlite).removeProject(id);
    // Scratchpads go with it too, through their ON DELETE CASCADE foreign key.
    sqlite.query("UPDATE jobs SET project_id=NULL WHERE project_id=?").run(id);
    sqlite.query("UPDATE sessions SET project_id=NULL WHERE project_id=?").run(id);
    sqlite.query("UPDATE gateway_sessions SET project_id=NULL WHERE project_id=?").run(id);
    sqlite
      .query(
        "UPDATE chat_threads SET data=json_remove(data, '$.projectId') WHERE json_valid(data) AND json_extract(data, '$.projectId')=?",
      )
      .run(id);
    sqlite.query("UPDATE notifications SET project_id=NULL WHERE project_id=?").run(id);
    sqlite.query("UPDATE bridge_chats SET project_id=NULL WHERE project_id=?").run(id);
    detachLegacyKnowledgeCollections(sqlite, id);
    deleteProjectWorkspaceEnvironments(sqlite, id);
    deleteProjectSecrets(sqlite, id);
    sqlite.query("DELETE FROM comments WHERE resource_type='project' AND resource_id=?").run(id);
    sqlite.query("DELETE FROM projects WHERE id=?").run(id);
  }, sqlite);
  invalidateProjectFolderCache();
}
