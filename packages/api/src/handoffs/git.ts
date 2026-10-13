import { appendFile, lstat, mkdir } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { type ExecHost, hostExec, hostRuntime } from "@orc/core/exec-host";
import type { SessionHandoffRequest } from "@orc/core/session-handoff";
import { gitError, gitRunner, repoRoot, worktreePath } from "../terminals/session-dir.js";

async function excludeHandoffWorktrees(host: ExecHost, root: string): Promise<void> {
  const run = gitRunner(host);
  const paths = host.kind === "ssh" || root.startsWith("/") ? posix : win32;
  const tracked = await run(["git", "-C", root, "ls-files", "--", ".orc/worktrees"]);
  if (tracked.code !== 0 || tracked.stdout.trim())
    throw new ConflictError("The handoff worktree location contains tracked files");
  const exclusion = await run(["git", "-C", root, "rev-parse", "--git-path", "info/exclude"]);
  if (exclusion.code !== 0) throw gitError(exclusion, "Could not locate Git worktree exclusions");
  const path = paths.resolve(root, exclusion.stdout.trim());
  const content = "\n/.orc/worktrees/\n";
  if (host.kind === "local") {
    for (const candidate of [
      paths.join(root, ".orc"),
      paths.join(root, ".orc", "worktrees"),
      path,
    ]) {
      const stat = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (stat?.isSymbolicLink())
        throw new ConflictError("Handoff storage must not redirect through symbolic links");
    }
    await mkdir(paths.dirname(path), { recursive: true });
    const ignored = await run([
      "git",
      "-C",
      root,
      "check-ignore",
      "--no-index",
      ".orc/worktrees/probe",
    ]);
    if (ignored.code !== 0) await appendFile(path, content);
    return;
  }
  const result = await hostExec(
    host,
    [
      "python3",
      "-c",
      `import json, os, sys
d = json.load(sys.stdin)
for path in [os.path.join(d['root'], '.orc'), os.path.join(d['root'], '.orc', 'worktrees'), d['path']]:
    if os.path.islink(path): sys.exit(3)
os.makedirs(os.path.dirname(d['path']), exist_ok=True)
with open(d['path'], 'a', encoding='utf-8') as f: f.write('\\n/.orc/worktrees/\\n')
`,
    ],
    { input: JSON.stringify({ root, path }), timeoutMs: 30_000, login: false },
  );
  if (result.code !== 0)
    throw new ConflictError("Could not safely prepare the handoff worktree location");
}

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
  const cwd = worktreePath(root, id, "repo");
  await excludeHandoffWorktrees(host, root);
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
