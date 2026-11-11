import { changes } from "@orc/core/changes";
import type { ExecHost } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";
import {
  ensureWorkspaceEnvironment,
  isWorktreePath,
  parseWorkspaceEnvironment,
  resolveWorkspaceEnvironment,
  type WorkspaceEnvironment,
  type WorkspaceRecord,
  workspacePortEnv,
  worktreeRoot,
} from "@orc/core/workspace-environment";
import { getSqlite } from "@orc/db/client";
import type { projects } from "@orc/db/schema";
import {
  clearWorkspacePreview,
  setWorkspacePreview,
  workspaceEnvironmentByPath,
  workspaceEnvironmentStore,
} from "@orc/db/workspaces";
import type { TerminalInfo } from "../terminals/manager.js";

const logger = createLogger("api:workspaces");

export type WorkspaceProject = typeof projects.$inferSelect;

function pathKey(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Longest project scope that contains `cwd`; worktrees live below their scope. */
export function resolveProjectForPath(path: string): WorkspaceProject | null {
  const target = pathKey(path);
  const rows = getSqlite()
    .query<Record<string, unknown>, []>("SELECT * FROM projects WHERE scope IS NOT NULL")
    .all();
  let match: Record<string, unknown> | null = null;
  let length = -1;
  for (const row of rows) {
    const scope = String(row.scope ?? "").trim();
    if (!scope) continue;
    const key = pathKey(scope);
    if ((target === key || target.startsWith(`${key}/`)) && key.length > length) {
      match = row;
      length = key.length;
    }
  }
  return match ? (match as unknown as WorkspaceProject) : null;
}

export function projectById(projectId: string): WorkspaceProject | null {
  const row = getSqlite()
    .query<Record<string, unknown>, [string]>("SELECT * FROM projects WHERE id = ?")
    .get(projectId);
  return row ? (row as unknown as WorkspaceProject) : null;
}

export function projectWorkspaceConfig(project: WorkspaceProject): WorkspaceEnvironment {
  return parseWorkspaceEnvironment(project.workspace);
}

export interface WorkspaceLaunch {
  projectId: string | null;
  worktreePath: string | null;
  env: Record<string, string>;
  previewUrl: string | null;
  setup: WorkspaceRecord | null;
}

const EMPTY_LAUNCH: WorkspaceLaunch = {
  projectId: null,
  worktreePath: null,
  env: {},
  previewUrl: null,
  setup: null,
};

/**
 * Ports, environment and one-time setup for a folder a terminal or agent will
 * use. Setup runs only for managed worktrees; a plain project checkout just
 * gets a stable port block.
 */
export async function workspaceLaunch(
  host: ExecHost,
  cwd: string | null,
  projectId?: string | null,
): Promise<WorkspaceLaunch> {
  if (!cwd) return EMPTY_LAUNCH;
  const project = projectId ? projectById(projectId) : resolveProjectForPath(cwd);
  if (!project) return EMPTY_LAUNCH;

  const config = projectWorkspaceConfig(project);
  const resolved = resolveWorkspaceEnvironment(config);
  const runSetup = isWorktreePath(cwd);
  const record = await ensureWorkspace({
    host,
    project,
    path: cwd,
    // Ports stay stable for the main checkout, but its setup is the developer's own.
    workspace: runSetup ? config : { ...config, setup_script: null },
    redact: resolved.redact,
    env: resolved.env,
  });

  const base = record.port_base ?? config.port_base ?? 3100;
  const count = record.port_count ?? config.port_count;
  return {
    projectId: project.id,
    worktreePath: isWorktreePath(cwd) ? cwd : null,
    env: {
      ...workspacePortEnv(base, count),
      ORC_PROJECT_ID: project.id,
      ORC_WORKSPACE: cwd,
      ...(isWorktreePath(cwd) ? { ORC_WORKTREE: cwd } : {}),
      ...resolved.env,
    },
    previewUrl: record.preview_url,
    setup: record,
  };
}

export async function ensureWorkspace(input: {
  host: ExecHost;
  project: WorkspaceProject;
  path: string;
  workspace?: WorkspaceEnvironment;
  env?: Record<string, string>;
  redact?: ((text: string) => string) | undefined;
}): Promise<WorkspaceRecord> {
  const workspace = input.workspace ?? projectWorkspaceConfig(input.project);
  return ensureWorkspaceEnvironment({
    store: workspaceEnvironmentStore(getSqlite()),
    host: input.host,
    projectId: input.project.id,
    path: input.path,
    repoRoot: worktreeRoot(input.path) ?? input.project.scope ?? null,
    platform: input.host.kind === "ssh" ? "linux" : process.platform,
    workspace,
    ...(input.env ? { env: input.env } : {}),
    ...(input.redact ? { redact: input.redact } : {}),
    log: (message) => logger.info(message),
  });
}

export function workspaceByPath(path: string): WorkspaceRecord | null {
  return workspaceEnvironmentByPath(getSqlite(), path);
}

export function recordPreview(info: TerminalInfo, url: string): void {
  const path = info.worktree_path ?? info.cwd;
  if (!path) return;
  setWorkspacePreview(getSqlite(), { path, url, terminalId: info.id });
  changes.publish("workspaces");
}

export function forgetPreview(info: TerminalInfo): void {
  const path = info.worktree_path ?? info.cwd;
  if (!path) return;
  clearWorkspacePreview(getSqlite(), { path, terminalId: info.id });
  changes.publish("workspaces");
}
