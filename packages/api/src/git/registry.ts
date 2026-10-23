import { type ExecHost, hostIsDirectory, hostPlatform, resolveExecHost } from "@orc/core/exec-host";
import { getDb } from "@orc/db/client";
import { observeCheckout } from "../realtime/sources.js";
import { getTerminalManager } from "../terminals/service.js";
import { gitRunner } from "../terminals/session-dir.js";
import {
  isInside,
  type RemoveWorktreeDeps,
  samePath,
  trackedWorktrees,
  type WorktreeListing,
} from "./worktrees.js";

const recentFolders = new Map<string, { cwd: string; host: string | null }>();

export function rememberTerminalFolder(cwd: string | null, host: string | null = null): void {
  if (!cwd) return;
  const key = JSON.stringify([host, cwd]);
  recentFolders.delete(key);
  recentFolders.set(key, { cwd, host });
  if (recentFolders.size > 100) {
    const oldest = recentFolders.keys().next().value;
    if (oldest) recentFolders.delete(oldest);
  }
}

export function worktreeDeps(host: ExecHost = resolveExecHost()): RemoveWorktreeDeps {
  const platform = hostPlatform(host);
  const alias = host.kind === "ssh" ? host.alias : null;
  return {
    runGit: gitRunner(host),
    platform,
    terminalUsing: (path) =>
      getTerminalManager()
        .list()
        .find(
          (terminal) =>
            terminal.status === "running" &&
            terminal.host === alias &&
            terminal.cwd &&
            isInside(terminal.cwd, path, platform),
        )?.name ?? null,
  };
}

export async function knownWorktrees(projectId?: string): Promise<{
  repos: WorktreeListing[];
  errors: { cwd: string; error: string }[];
}> {
  const db = getDb();
  const host = resolveExecHost();
  const alias = host.kind === "ssh" ? host.alias : null;
  const projects = await db.query.projects.findMany();
  const live = await db.query.gateway_sessions.findMany({
    limit: 100,
    orderBy: (table, { desc }) => [desc(table.updated_at)],
  });
  const folders = projectId
    ? projects.filter((project) => project.id === projectId).map((project) => project.scope)
    : [
        ...projects.map((project) => project.scope),
        ...live
          .filter((session) => (session.execution_host ?? null) === alias)
          .map((session) => session.cwd),
        ...[...recentFolders.values()]
          .filter((folder) => folder.host === alias)
          .map((folder) => folder.cwd),
        ...getTerminalManager()
          .list()
          .filter((terminal) => terminal.host === alias)
          .map((terminal) => terminal.cwd),
      ];
  const repos: WorktreeListing[] = [];
  const errors: { cwd: string; error: string }[] = [];
  if (projectId && !projects.find((project) => project.id === projectId)?.scope)
    errors.push({
      cwd: "Project repository",
      error: "This project has no folder scope. Set its folder in Projects or use All Projects.",
    });
  const deps = worktreeDeps(host);
  for (const cwd of new Set(folders.filter((folder): folder is string => Boolean(folder)))) {
    if (!(await hostIsDirectory(host, cwd))) {
      errors.push({ cwd, error: "Folder is unavailable" });
      continue;
    }
    try {
      observeCheckout(host, cwd);
      const listing = await trackedWorktrees(cwd, deps);
      const canonical = listing.worktrees.find((tree) => tree.main)?.path ?? listing.root;
      if (canonical && !repos.some((repo) => samePath(repo.root ?? "", canonical, deps.platform)))
        repos.push({ ...listing, root: canonical });
    } catch {
      errors.push({ cwd, error: "Could not inspect repository" });
    }
  }
  return { repos, errors };
}
