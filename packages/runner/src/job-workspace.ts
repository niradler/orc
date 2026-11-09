import { type ExecHost, hostExec } from "@orc/core/exec-host";
import type { JobSettings } from "@orc/core/job-settings";

export type JobWorkspace = {
  cwd: string;
  base: string;
  managed: boolean;
  cleanup: (success: boolean) => Promise<string>;
};

export async function prepareJobWorkspace(
  host: ExecHost,
  repository: string,
  runId: string,
  settings: JobSettings["workspace"],
): Promise<JobWorkspace> {
  const git = async (cwd: string, args: string[]): Promise<string> => {
    const result = await hostExec(host, ["git", ...args], { cwd, timeoutMs: 30000 });
    if (result.code !== 0)
      throw new Error(
        "Git workspace operation failed. Check the repository, base ref and host access.",
      );
    return result.stdout.trim();
  };
  if (!settings || settings.mode === "directory")
    return { cwd: repository, base: "", managed: false, cleanup: async () => "" };
  const root = await git(repository, ["rev-parse", "--show-toplevel"]);
  const base = await git(root, ["rev-parse", "--verify", `${settings.base_ref}^{commit}`]);
  const cwd = `${root.replaceAll("\\", "/")}/.orc/worktrees/job-${runId}`;
  await git(root, ["worktree", "add", "--detach", cwd, base]);
  return {
    cwd,
    base,
    managed: true,
    cleanup: async (success) => {
      if (!success || !settings.cleanup_on_success) return `Worktree retained: ${cwd}`;
      const dirty = await git(cwd, ["status", "--porcelain", "--untracked-files=all", "--ignored"]);
      const commits = await git(cwd, ["rev-list", "--count", `HEAD`, `^${base}`]);
      if (dirty || commits !== "0")
        return `Worktree retained (contains files or commits absent from the base): ${cwd}`;
      await git(root, ["worktree", "remove", cwd]);
      return `Clean worktree removed: ${cwd}`;
    },
  };
}
