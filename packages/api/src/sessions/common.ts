import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { projectForFolder } from "@orc/core/project-path";
import { getDb, getSqlite } from "@orc/db/client";
import { projects } from "@orc/db/schema";
import type { SessionStatus } from "./types.js";

export const LIVE_CHAT_ID = "__live-sessions__";
export const RECENT_WRITE_MS = 30_000;

type ProjectRow = {
  id: string;
  name: string;
  scope: string | null;
  git_remote_url: string | null;
};
type FolderRow = { id: string; scope: string | null };

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function statusFromMtime(mtimeMs: number): SessionStatus {
  return Date.now() - mtimeMs < RECENT_WRITE_MS ? "running" : "stopped";
}

export function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const projectByCwd = new Map<string, string | null>();
const repoRootByCwd = new Map<string, string | null>();
let cachedProjects: ProjectRow[] | null = null;
let cachedFolders: FolderRow[] | null = null;
let cachedProjectsAt = 0;
const PROJECT_ROWS_TTL_MS = 30_000;

/** Project folders, remotes and worktree roots change together; drop every derived lookup. */
export function invalidateProjectFolderCache(): void {
  projectByCwd.clear();
  repoRootByCwd.clear();
  cachedProjects = null;
  cachedFolders = null;
  cachedProjectsAt = 0;
}

/**
 * Every folder that identifies a project: its explicit scope plus the repository
 * roots of its known sessions. That keeps worktrees and additional checkouts in
 * the same project without a second user-configured folder list.
 */
async function projectFolders(rows: ProjectRow[]): Promise<FolderRow[]> {
  if (cachedFolders) return cachedFolders;
  const folders = new Map<string, FolderRow>();
  const add = (id: string, scope: string | null) => {
    if (!scope?.trim()) return;
    const path = scope.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const key = `${id}:${process.platform === "win32" ? path.toLowerCase() : path}`;
    if (!folders.has(key)) folders.set(key, { id, scope });
  };
  const local = hostRuntime(LOCAL_HOST);
  for (const project of rows) add(project.id, project.scope);
  const sessions = getSqlite()
    .query<{ project_id: string; cwd: string }, []>(
      `SELECT project_id, cwd FROM gateway_sessions
       WHERE project_id IS NOT NULL AND cwd IS NOT NULL
         AND (execution_host IS NULL OR execution_host = '' OR execution_host = 'local')
       GROUP BY project_id, cwd
       ORDER BY MAX(last_activity_at) DESC
       LIMIT 500`,
    )
    .all();
  for (const session of sessions) {
    add(session.project_id, (await repoRootFor(session.cwd, local)) ?? session.cwd);
  }
  cachedFolders = [...folders.values()];
  return cachedFolders;
}

async function projectRows(): Promise<ProjectRow[]> {
  if (cachedProjects && Date.now() - cachedProjectsAt < PROJECT_ROWS_TTL_MS) return cachedProjects;
  const rows = await getDb()
    .select({
      id: projects.id,
      name: projects.name,
      scope: projects.scope,
      git_remote_url: projects.git_remote_url,
    })
    .from(projects);
  // Projects can change outside the API's own project routes (CLI, MCP); drop
  // derived session assignments only when the folder set actually moved.
  if (cachedProjects && JSON.stringify(rows) === JSON.stringify(cachedProjects)) {
    cachedProjectsAt = Date.now();
    return cachedProjects;
  }
  cachedProjects = rows;
  cachedFolders = null;
  cachedProjectsAt = Date.now();
  projectByCwd.clear();
  return cachedProjects;
}

function hostKey(runtime: HostRuntime): string {
  return runtime.host.kind === "ssh" ? runtime.host.alias : "local";
}

/** The main checkout can sit anywhere on disk; a worktree's common git dir names it. */
async function repoRootFor(cwd: string, runtime: HostRuntime): Promise<string | null> {
  const key = `${hostKey(runtime)}:${cwd}`;
  const cached = repoRootByCwd.get(key);
  if (cached !== undefined) return cached;
  let root: string | null = null;
  try {
    const result = await runtime.exec(
      ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeoutMs: 30_000 },
    );
    const common = result.code === 0 ? result.stdout.trim() : "";
    if (common) root = basename(common) === ".git" ? dirname(common) : common;
  } catch {
    root = null;
  }
  repoRootByCwd.set(key, root);
  return root;
}

function remoteName(url: string): string {
  return basename(url.replace(/\/+$/, "").replace(/\.git$/i, "")).toLowerCase();
}

export async function projectIdFor(
  cwd: string | null | undefined,
  runtime: HostRuntime = hostRuntime(LOCAL_HOST),
): Promise<string | null> {
  if (!cwd) return null;
  const key = `${hostKey(runtime)}:${cwd}`;
  const cached = projectByCwd.get(key);
  if (cached !== undefined) return cached;
  const rows = await projectRows();
  const folders = await projectFolders(rows);
  let id = projectForFolder(cwd, folders)?.id ?? null;
  if (!id) {
    // Sessions often run in a worktree outside the project's folder. Resolve the
    // shared checkout first so sibling folders and worktrees agree on one project.
    const root = await repoRootFor(cwd, runtime);
    if (root) id = projectForFolder(root, folders)?.id ?? null;
  }
  if (!id) {
    try {
      const result = await runtime.exec(["git", "-C", cwd, "remote", "get-url", "origin"], {
        timeoutMs: 30_000,
      });
      const url = result.code === 0 ? result.stdout.trim() : "";
      if (url) {
        const name = remoteName(url);
        const row = rows.find(
          (project) =>
            (project.git_remote_url && remoteName(project.git_remote_url) === name) ||
            project.name.toLowerCase() === name,
        );
        id = row?.id ?? null;
      }
    } catch {
      id = null;
    }
  }
  projectByCwd.set(key, id);
  return id;
}
