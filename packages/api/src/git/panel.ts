import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "@orc/core/errors";
import { type ExecHost, hostExec } from "@orc/core/exec-host";
import { gitError, gitRunner, repoRoot } from "../terminals/session-dir.js";

export interface GitFile {
  path: string;
  index: string;
  working: string;
  original: string | null;
}
export function parseStatus(output: string): GitFile[] {
  const entries = output.split("\0");
  const files: GitFile[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const renamed = entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C";
    files.push({
      path: entry.slice(3),
      index: entry[0] ?? " ",
      working: entry[1] ?? " ",
      original: renamed ? (entries[++index] ?? null) : null,
    });
  }
  return files;
}

async function isRegularFile(host: ExecHost, path: string): Promise<boolean> {
  if (host.kind === "local") return (await lstat(path)).isFile();
  const result = await hostExec(
    host,
    ["/bin/sh", "-c", 'test -f "$1" && test ! -L "$1"', "sh", path],
    {
      login: false,
    },
  );
  return result.code === 0;
}

export async function gitStatus(
  host: ExecHost,
  cwd: string,
): Promise<{ root: string | null; branch: string | null; files: GitFile[]; branches: string[] }> {
  const runGit = gitRunner(host);
  const root = await repoRoot(cwd, runGit);
  if (!root) return { root: null, branch: null, files: [], branches: [] };
  const [status, branch, branches] = await Promise.all([
    runGit(["git", "--no-optional-locks", "-C", root, "status", "--porcelain=v1", "-z"]),
    runGit(["git", "-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(["git", "-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads/"]),
  ]);
  if (status.code !== 0) throw gitError(status, "Cannot read git status");
  if (branches.code !== 0) throw gitError(branches, "Cannot read branches");
  return {
    root,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    files: parseStatus(status.stdout),
    branches: branches.stdout.trim().split(/\r?\n/).filter(Boolean),
  };
}

export async function gitDiff(
  host: ExecHost,
  cwd: string,
  staged: boolean,
  path?: string,
): Promise<{ diff: string; truncated: boolean }> {
  const runGit = gitRunner(host);
  const root = await repoRoot(cwd, runGit);
  if (!root) throw new ValidationError("Not a git repository");
  const file = path ? (await gitStatus(host, root)).files.find((file) => file.path === path) : null;
  if (path && !file) throw new ValidationError("Path is not in this checkout's status");
  const untracked = !staged && file?.index === "?";
  if (untracked && path && !(await isRegularFile(host, join(root, path))))
    return {
      diff: "Untracked symbolic link or special file; stage it to view its Git diff.",
      truncated: false,
    };
  const result = await runGit([
    "git",
    "--literal-pathspecs",
    "-C",
    root,
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    ...(staged ? ["--cached"] : []),
    ...(untracked ? ["--no-index"] : []),
    "--",
    ...(untracked ? ["/dev/null"] : []),
    ...(file?.original ? [file.original] : []),
    ...(path ? [path] : []),
  ]);
  if (result.code !== 0 && !(untracked && result.code === 1))
    throw gitError(result, "Cannot read diff");
  return { diff: result.stdout.slice(0, 200_000), truncated: result.stdout.length > 200_000 };
}

export async function switchBranch(host: ExecHost, cwd: string, branch: string): Promise<void> {
  const status = await gitStatus(host, cwd);
  if (!status.root || !status.branches.includes(branch))
    throw new ValidationError("Select an existing local branch");
  if (status.branch === branch) return;
  if (status.files.length)
    throw new ValidationError("Commit or stash your changes before switching branches");
  const result = await gitRunner(host)(["git", "-C", status.root, "switch", "--", branch]);
  if (result.code !== 0) throw gitError(result, "Cannot switch branch");
}

export async function stageFiles(host: ExecHost, cwd: string, paths: string[]): Promise<void> {
  const status = await gitStatus(host, cwd);
  if (!status.root) throw new ValidationError("Not a git repository");
  const available = new Set(
    status.files.flatMap((file) => (file.original ? [file.path, file.original] : [file.path])),
  );
  if (
    paths.some(
      (path) => !available.has(path) || path.startsWith("/") || path.split(/[\\/]/).includes(".."),
    )
  )
    throw new ValidationError("Select paths from this checkout's current status");
  const result = await gitRunner(host)([
    "git",
    "--literal-pathspecs",
    "-C",
    status.root,
    "add",
    "--",
    ...paths,
  ]);
  if (result.code !== 0) throw gitError(result, "Cannot stage files");
}

export async function commitStaged(host: ExecHost, cwd: string, message: string): Promise<void> {
  const result = await gitRunner(host)(["git", "-C", cwd, "commit", "-m", message]);
  if (result.code !== 0) throw gitError(result, "Cannot commit staged changes");
}
