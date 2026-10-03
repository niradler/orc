import { basename, dirname, join } from "node:path";
import { ValidationError } from "@orc/core/errors";

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface SessionDirDeps {
  isDirectory: (path: string) => boolean;
  home: string;
  runGit: (argv: string[]) => Promise<GitResult>;
  makeDirectory: (path: string) => void;
  newId: () => string;
}

export interface SessionDirRequest {
  cwd?: string | null | undefined;
  worktree?: boolean | undefined;
}

export async function runGit(argv: string[]): Promise<GitResult> {
  const proc = Bun.spawn(argv, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export function gitError(result: GitResult, fallback: string): Error {
  const message = result.stderr.trim() || result.stdout.trim() || fallback;
  return new ValidationError(message.replace(/^fatal:\s*/i, ""));
}

export function isNotARepo(result: GitResult): boolean {
  return result.code !== 0 && /not a git repository/i.test(result.stderr);
}

// Returns the repo toplevel, or null when the folder is not inside a git repo.
export async function repoRoot(cwd: string, run: SessionDirDeps["runGit"]): Promise<string | null> {
  const result = await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (isNotARepo(result)) return null;
  const root = result.stdout.trim();
  if (result.code !== 0 || !root) throw gitError(result, "git rev-parse failed");
  return root;
}

export function worktreePath(root: string, id: string): string {
  return join(dirname(root), "worktrees", basename(root), id);
}

export async function prepareSessionDirectory(
  req: SessionDirRequest,
  deps: SessionDirDeps,
): Promise<string> {
  const cwd = req.cwd?.trim();
  if (!cwd) return deps.home;
  if (!deps.isDirectory(cwd)) throw new ValidationError(`cwd is not a directory: ${cwd}`);
  if (!req.worktree) return cwd;

  const root = await repoRoot(cwd, deps.runGit);
  if (!root) return cwd;

  const id = deps.newId();
  const path = worktreePath(root, id);
  deps.makeDirectory(dirname(path));
  const added = await deps.runGit(["git", "-C", root, "worktree", "add", "-b", `orc/${id}`, path]);
  if (added.code !== 0) throw gitError(added, "git worktree add failed");
  return path;
}
