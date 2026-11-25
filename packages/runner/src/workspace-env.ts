import type { ExecHost } from "@orc/core/exec-host";
import { createJobOutputRedactor } from "@orc/core/job-environment";
import { createLogger } from "@orc/core/logger";
import { getRegisteredSecrets, redactRegisteredSecrets } from "@orc/core/secret-redactor";
import {
  ensureWorkspaceEnvironment,
  parseWorkspaceEnvironment,
  resolveWorkspaceEnvironment,
  type WorkspaceRecord,
  workspaceConfigured,
  workspacePortEnv,
  worktreeDir,
  worktreeRoot,
} from "@orc/core/workspace-environment";
import { getSqlite } from "@orc/db/client";
import { resolveProjectSecretEnv } from "@orc/db/project-secrets";
import { workspaceEnvironmentStore } from "@orc/db/workspaces";

const logger = createLogger("runner:workspace");

let portProber: ((port: number) => boolean | Promise<boolean>) | undefined;

/**
 * Test seam, like the api workspaces service's: allocation tests must not depend
 * on which ports the host happens to hold (Windows can reserve wide ranges under
 * load), so they replace the live bind probe. Production keeps probing real
 * availability.
 */
export function setWorkspacePortProber(
  prober: ((port: number) => boolean | Promise<boolean>) | null,
): void {
  portProber = prober ?? undefined;
}

type ProjectRow = {
  id: string;
  name: string;
  scope: string | null;
  workspace: string | null;
};

export interface RunnerWorkspaceLaunch {
  env: Record<string, string>;
  secrets: string[];
  setup: WorkspaceRecord | null;
}

const EMPTY: RunnerWorkspaceLaunch = { env: {}, secrets: [], setup: null };

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
  const sqlite = getSqlite();
  const project = sqlite
    .query<ProjectRow, [string]>("SELECT id, name, scope, workspace FROM projects WHERE id = ?")
    .get(projectId);
  if (!project) return EMPTY;

  const config = parseWorkspaceEnvironment(project.workspace);
  const resolved = resolveWorkspaceEnvironment(config);
  const withProjectSecrets = resolveProjectSecretEnv(sqlite, project.id, resolved.env);
  const secrets = [...new Set([...resolved.secrets, ...withProjectSecrets.secrets])];
  const redact = (text: string): string => {
    const redactor = createJobOutputRedactor([...secrets, ...getRegisteredSecrets()]);
    return redactRegisteredSecrets(redactor.write(text) + redactor.finish(), secrets);
  };
  if (!workspaceConfigured(config)) return { env: withProjectSecrets.env, secrets, setup: null };
  const worktree = worktreeDir(cwd);
  const path = worktree ?? cwd;
  let setup: WorkspaceRecord;
  try {
    setup = await ensureWorkspaceEnvironment({
      store: workspaceEnvironmentStore(sqlite),
      host,
      projectId: project.id,
      path,
      repoRoot: worktreeRoot(path) ?? project.scope,
      platform: host.kind === "ssh" ? "linux" : process.platform,
      workspace: worktree ? config : { ...config, setup_script: null },
      env: withProjectSecrets.env,
      redact,
      log: (message) => logger.info(message),
      ...(portProber ? { isPortFree: portProber } : {}),
    });
  } catch (error) {
    logger.error(`Workspace environment failed for ${path}: ${String(error)}`);
    return { env: withProjectSecrets.env, secrets, setup: null };
  }

  const base = setup.port_base ?? config.port_base ?? 3100;
  const count = setup.port_count ?? config.port_count;
  return {
    env: {
      ...workspacePortEnv(base, count),
      ORC_PROJECT_ID: project.id,
      ORC_WORKSPACE: path,
      ...(worktree ? { ORC_WORKTREE: worktree } : {}),
      ...withProjectSecrets.env,
    },
    secrets,
    setup,
  };
}
