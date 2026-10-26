import { ConflictError, ValidationError } from "@orc/core/errors";
import { type ExecHost, hostRuntime } from "@orc/core/exec-host";
import type { SessionHandoffRequest } from "@orc/core/session-handoff";
import {
  excludeOrcWorktrees,
  gitError,
  gitRunner,
  repoRoot,
  worktreePath,
} from "../terminals/session-dir.js";

export function repositoryIdentity(value: string): string {
  const url = value.trim().replace(/\\/g, "/");
  const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(url);
  if (scp && !/^[A-Za-z]:\//.test(url) && !url.includes("://"))
    return `${scp[1]?.toLowerCase()}/${scp[2]}`.replace(/\/?\.git\/?$/, "").replace(/\/$/, "");
  try {
    const parsed = new URL(url);
    if (parsed.username && parsed.protocol !== "ssh:")
      throw new ValidationError("Repository URLs must not contain credentials");
    if (parsed.password) throw new ValidationError("Repository URLs must not contain credentials");
    return `${parsed.host.toLowerCase()}${decodeURIComponent(parsed.pathname)}`
      .replace(/\/?\.git\/?$/, "")
      .replace(/\/$/, "");
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    return url.replace(/\/?\.git\/?$/, "").replace(/\/$/, "");
  }
}

export async function validateHandoffRepo(
  host: ExecHost,
  scope: string,
  request: SessionHandoffRequest,
): Promise<string> {
  const run = gitRunner(host);
  const branch = await run(["git", "check-ref-format", "--branch", request.branch]);
  if (
    branch.code !== 0 ||
    branch.stdout.trim() !== request.branch ||
    request.branch.startsWith("-")
  )
    throw new ValidationError("Invalid handoff branch");
  const root = await repoRoot(scope, run);
  if (!root)
    throw new ValidationError(
      "Project scope must point to an existing repository on the execution host",
    );
  const remote = await run(["git", "-C", root, "remote", "get-url", request.remote]);
  if (remote.code !== 0)
    throw new ValidationError("Reported remote is not configured in the destination repository");
  if (repositoryIdentity(remote.stdout.trim()) !== repositoryIdentity(request.repository))
    throw new ValidationError(
      "Reported repository does not match the project's destination remote",
    );
  return root;
}

export async function prepareHandoffWorktree(
  host: ExecHost,
  root: string,
  id: string,
  request: SessionHandoffRequest,
): Promise<string> {
  await validateHandoffRepo(host, root, request);
  const run = gitRunner(host);
  const cwd = worktreePath(root, id);
  await excludeOrcWorktrees(host, root);
  const runtime = hostRuntime(host);
  if (await runtime.isDirectory(cwd)) {
    await verifyHandoffWorktree(host, cwd, request.commit);
    const branch = await run(["git", "-C", cwd, "symbolic-ref", "--short", "HEAD"]);
    if (branch.stdout.trim() !== `orc/handoff/${id}`)
      throw new ConflictError("Existing handoff folder belongs to another branch");
    return cwd;
  }
  const fetched = await run([
    "git",
    "-C",
    root,
    "fetch",
    "--no-tags",
    request.remote,
    `refs/heads/${request.branch}:refs/orc/handoffs/${id}`,
    `+refs/heads/${request.branch}:refs/remotes/${request.remote}/${request.branch}`,
  ]);
  if (fetched.code !== 0) throw gitError(fetched, "Could not fetch the pushed branch");
  const tip = await run(["git", "-C", root, "rev-parse", `refs/orc/handoffs/${id}^{commit}`]);
  if (tip.code !== 0 || tip.stdout.trim() !== request.commit)
    throw new ConflictError(
      "Remote branch tip differs from the reported commit; push and initiate a new handoff",
    );
  const added = await run([
    "git",
    "-C",
    root,
    "worktree",
    "add",
    "-b",
    `orc/handoff/${id}`,
    cwd,
    request.commit,
  ]);
  if (added.code !== 0) throw gitError(added, "Could not prepare the handoff worktree");
  const tracked = await run([
    "git",
    "-C",
    cwd,
    "branch",
    `--set-upstream-to=${request.remote}/${request.branch}`,
    `orc/handoff/${id}`,
  ]);
  if (tracked.code !== 0) throw gitError(tracked, "Could not track the pushed branch");
  await verifyHandoffWorktree(host, cwd, request.commit);
  return cwd;
}

export async function verifyHandoffWorktree(
  host: ExecHost,
  cwd: string,
  commit: string,
): Promise<void> {
  const run = gitRunner(host);
  const head = await run(["git", "-C", cwd, "rev-parse", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== commit)
    throw new ConflictError("Handoff checkout no longer matches its recorded commit");
  const status = await run([
    "git",
    "--no-optional-locks",
    "-C",
    cwd,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.code !== 0) throw gitError(status, "Could not verify handoff checkout");
  if (status.stdout.trim())
    throw new ConflictError("Handoff checkout has local changes; preserve them before resuming");
}
