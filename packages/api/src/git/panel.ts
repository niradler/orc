import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "@orc/core/errors";
import { gitError, repoRoot, runGit } from "../terminals/session-dir.js";

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

export async function gitStatus(
  cwd: string,
): Promise<{ root: string | null; branch: string | null; files: GitFile[]; branches: string[] }> {
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
  cwd: string,
  staged: boolean,
  path?: string,
): Promise<{ diff: string; truncated: boolean }> {
  const root = await repoRoot(cwd, runGit);
  if (!root) throw new ValidationError("Not a git repository");
  const file = path ? (await gitStatus(root)).files.find((file) => file.path === path) : null;
  if (path && !file) throw new ValidationError("Path is not in this checkout's status");
  const untracked = !staged && file?.index === "?";
  if (untracked && path && !(await lstat(join(root, path))).isFile())
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

export async function switchBranch(cwd: string, branch: string): Promise<void> {
  const status = await gitStatus(cwd);
  if (!status.root || !status.branches.includes(branch))
    throw new ValidationError("Select an existing local branch");
  if (status.branch === branch) return;
  if (status.files.length)
    throw new ValidationError("Commit or stash your changes before switching branches");
  const result = await runGit(["git", "-C", status.root, "switch", "--", branch]);
  if (result.code !== 0) throw gitError(result, "Cannot switch branch");
}

export async function stageFiles(cwd: string, paths: string[]): Promise<void> {
  const status = await gitStatus(cwd);
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
  const result = await runGit([
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

export async function commitStaged(cwd: string, message: string): Promise<void> {
  const result = await runGit(["git", "-C", cwd, "commit", "-m", message]);
  if (result.code !== 0) throw gitError(result, "Cannot commit staged changes");
}
