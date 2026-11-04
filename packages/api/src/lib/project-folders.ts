import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { findSkillDirs } from "@orc/core/skill-bundle";
import { projectSkillFolders } from "@orc/core/skill-local-import";
import { getSqlite } from "@orc/db/client";

export type ProjectFolder = { agent: string; label: string; dir: string; skills: number };
export type ProjectRoot = {
  project_id: string;
  project_name: string;
  root: string;
  folders: ProjectFolder[];
};

const rootByCwd = new Map<string, string | null>();

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** The main checkout of the git repo holding `cwd`, so worktrees and subfolders map to one root. */
function repoRoot(cwd: string): string | null {
  const key = pathKey(cwd);
  const cached = rootByCwd.get(key);
  if (cached !== undefined) return cached;
  let root: string | null = null;
  try {
    const common = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (common && basename(common) === ".git") root = resolve(dirname(common));
  } catch {
    root = null;
  }
  rootByCwd.set(key, root);
  return root;
}

function localDir(path: string | null): string | null {
  if (!path) return null;
  const dir = path.replace(/^\\\\\?\\/, "");
  return isAbsolute(dir) && isDir(dir) ? resolve(dir) : null;
}

/** Folders a project lives in: its scope folder, then repo roots of local agent sessions, most used first. */
export function listProjectRoots(projectId?: string): ProjectRoot[] {
  const sqlite = getSqlite();
  const projects = sqlite
    .query<{ id: string; name: string; scope: string | null }, []>(
      "SELECT id, name, scope FROM projects ORDER BY name",
    )
    .all()
    .filter((project) => !projectId || project.id === projectId);
  const sessions = sqlite
    .query<{ project_id: string; cwd: string; uses: number }, []>(
      "SELECT project_id, cwd, COUNT(*) AS uses FROM gateway_sessions WHERE project_id IS NOT NULL AND cwd IS NOT NULL AND (execution_host IS NULL OR execution_host = '' OR execution_host = 'local') GROUP BY project_id, cwd",
    )
    .all();
  const roots: ProjectRoot[] = [];
  for (const project of projects) {
    const uses = new Map<string, { root: string; uses: number }>();
    const add = (root: string | null, count: number) => {
      if (!root) return;
      const entry = uses.get(pathKey(root)) ?? { root, uses: 0 };
      entry.uses += count;
      uses.set(pathKey(root), entry);
    };
    const scope = localDir(project.scope);
    if (scope) add(repoRoot(scope) ?? scope, Number.MAX_SAFE_INTEGER);
    for (const session of sessions) {
      if (session.project_id !== project.id) continue;
      const cwd = localDir(session.cwd);
      if (cwd) add(repoRoot(cwd), session.uses);
    }
    for (const { root } of [...uses.values()].sort((left, right) => right.uses - left.uses))
      roots.push({
        project_id: project.id,
        project_name: project.name,
        root,
        folders: projectSkillFolders(root).map((folder) => ({
          agent: folder.id,
          label: folder.label,
          dir: folder.dir,
          skills: existsSync(folder.dir) ? findSkillDirs(folder.dir).length : 0,
        })),
      });
  }
  return roots;
}
