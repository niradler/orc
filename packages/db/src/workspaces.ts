import type { Database } from "bun:sqlite";
import type {
  WorkspaceEnvironmentStore,
  WorkspaceRecord,
  WorkspaceSetupStatus,
} from "@orc/core/workspace-settings";

export type WorkspaceEnvironmentRow = WorkspaceRecord;

type Row = WorkspaceRecord;

export function installWorkspaceEnvironments(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_environments (
    worktree_path TEXT PRIMARY KEY,
    project_id TEXT,
    repo_root TEXT,
    git_branch TEXT,
    host TEXT,
    setup_status TEXT NOT NULL DEFAULT 'pending',
    setup_output TEXT,
    setup_started_at INTEGER,
    setup_ended_at INTEGER,
    port_base INTEGER,
    port_count INTEGER NOT NULL DEFAULT 0,
    preview_url TEXT,
    dev_terminal_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS workspace_environments_project_idx ON workspace_environments(project_id)",
  );
  // Concurrent prepares must not hand the same block to two workspaces.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS workspace_environments_port_idx ON workspace_environments(port_base) WHERE port_base IS NOT NULL",
  );
}

export function workspaceEnvironmentByPath(
  db: Database,
  path: string,
): WorkspaceEnvironmentRow | null {
  return (
    db
      .query<Row, [string]>("SELECT * FROM workspace_environments WHERE worktree_path = ?")
      .get(path) ?? null
  );
}

export function listWorkspaceEnvironments(
  db: Database,
  projectId?: string | null,
): WorkspaceEnvironmentRow[] {
  if (projectId) {
    return db
      .query<Row, [string]>(
        "SELECT * FROM workspace_environments WHERE project_id = ? ORDER BY created_at DESC",
      )
      .all(projectId);
  }
  return db.query<Row, []>("SELECT * FROM workspace_environments ORDER BY created_at DESC").all();
}

export function createWorkspaceEnvironment(
  db: Database,
  input: {
    worktree_path: string;
    project_id: string | null;
    repo_root: string | null;
    git_branch: string | null;
    host: string | null;
    port_base: number;
    port_count: number;
  },
): WorkspaceEnvironmentRow {
  const now = Math.floor(Date.now() / 1000);
  db.query(
    `INSERT INTO workspace_environments
       (worktree_path, project_id, repo_root, git_branch, host, port_base, port_count, setup_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    input.worktree_path,
    input.project_id,
    input.repo_root,
    input.git_branch,
    input.host,
    input.port_base,
    input.port_count,
    now,
    now,
  );
  return workspaceEnvironmentByPath(db, input.worktree_path) as WorkspaceEnvironmentRow;
}

export function setWorkspaceSetup(
  db: Database,
  input: {
    path: string;
    status: WorkspaceSetupStatus;
    output?: string | null;
    started?: number | null;
    ended?: number | null;
  },
): void {
  db.query(
    `UPDATE workspace_environments
        SET setup_status = ?,
            setup_output = COALESCE(?, setup_output),
            setup_started_at = COALESCE(?, setup_started_at),
            setup_ended_at = COALESCE(?, setup_ended_at),
            updated_at = unixepoch()
      WHERE worktree_path = ?`,
  ).run(input.status, input.output ?? null, input.started ?? null, input.ended ?? null, input.path);
}

export function setWorkspacePreview(
  db: Database,
  input: { path: string; url: string | null; terminalId?: string | null },
): void {
  db.query(
    `UPDATE workspace_environments
        SET preview_url = ?, dev_terminal_id = COALESCE(?, dev_terminal_id), updated_at = unixepoch()
      WHERE worktree_path = ?`,
  ).run(input.url, input.terminalId ?? null, input.path);
}

/** Clears the preview only when the terminal that produced it goes away. */
export function clearWorkspacePreview(
  db: Database,
  input: { path: string; terminalId: string },
): void {
  db.query(
    `UPDATE workspace_environments
        SET preview_url = NULL, dev_terminal_id = NULL, updated_at = unixepoch()
      WHERE worktree_path = ? AND dev_terminal_id = ?`,
  ).run(input.path, input.terminalId);
}

export function usedWorkspacePorts(db: Database): number[] {
  const rows = db
    .query<{ port_base: number | null; port_count: number | null }, []>(
      "SELECT port_base, port_count FROM workspace_environments WHERE port_base IS NOT NULL",
    )
    .all();
  return rows.flatMap((row) => {
    const count = row.port_count ?? 0;
    return Array.from({ length: count }, (_, index) => (row.port_base ?? 0) + index);
  });
}

export function deleteWorkspaceEnvironment(db: Database, path: string): void {
  db.query("DELETE FROM workspace_environments WHERE worktree_path = ?").run(path);
}

export function deleteProjectWorkspaceEnvironments(db: Database, projectId: string): void {
  db.query("DELETE FROM workspace_environments WHERE project_id = ?").run(projectId);
}

export function workspaceEnvironmentStore(db: Database): WorkspaceEnvironmentStore {
  return {
    byPath: (path) => workspaceEnvironmentByPath(db, path),
    create: (input) => createWorkspaceEnvironment(db, input),
    setSetup: (input) => setWorkspaceSetup(db, input),
    usedPorts: () => usedWorkspacePorts(db),
  };
}
