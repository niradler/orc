import type { ExecHost } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";
import {
  ensureWorkspaceEnvironment,
  isWorktreePath,
  parseWorkspaceEnvironment,
  resolveWorkspaceEnvironment,
  type WorkspaceRecord,
  workspacePortEnv,
  worktreeRoot,
} from "@orc/core/workspace-environment";
import { getSqlite } from "@orc/db/client";
import { workspaceEnvironmentStore } from "@orc/db/workspaces";

const logger = createLogger("runner:workspace");

type ProjectRow = {
  id: string;
  name: string;
  scope: string | null;
  workspace: string | null;
};

export interface RunnerWorkspaceLaunch {
  env: Record<string, string>;
  setup: WorkspaceRecord | null;
}

const EMPTY: RunnerWorkspaceLaunch = { env: {}, setup: null };

/**
 * Project environment and port block for a flow node or job. A managed
 * worktree also runs the project's setup script once before the agent starts.
 */
export async function workspaceEnvFor(
  host: ExecHost,
  cwd: string | null | undefined,
  projectId: string | null | undefined,
): Promise<RunnerWorkspaceLaunch> {
  if (!cwd || !projectId) return EMPTY;
  const project = getSqlite()
    .query<ProjectRow, [string]>("SELECT id, name, scope, workspace FROM projects WHERE id = ?")
    .get(projectId);
  if (!project) return EMPTY;

  const config = parseWorkspaceEnvironment(project.workspace);
  const resolved = resolveWorkspaceEnvironment(config);
  const runSetup = isWorktreePath(cwd);
  let setup: WorkspaceRecord;
  try {
    setup = await ensureWorkspaceEnvironment({
      store: workspaceEnvironmentStore(getSqlite()),
      host,
      projectId: project.id,
      path: cwd,
      repoRoot: worktreeRoot(cwd) ?? project.scope,
      platform: host.kind === "ssh" ? "linux" : process.platform,
      workspace: runSetup ? config : { ...config, setup_script: null },
      env: resolved.env,
      redact: resolved.redact,
      log: (message) => logger.info(message),
    });
  } catch (error) {
    logger.error(`Workspace environment failed for ${cwd}: ${String(error)}`);
    return EMPTY;
  }

  const base = setup.port_base ?? config.port_base ?? 3100;
  const count = setup.port_count ?? config.port_count;
  return {
    env: {
      ...workspacePortEnv(base, count),
      ORC_PROJECT_ID: project.id,
      ORC_WORKSPACE: cwd,
      ...(runSetup ? { ORC_WORKTREE: cwd } : {}),
      ...resolved.env,
    },
    setup,
  };
}
