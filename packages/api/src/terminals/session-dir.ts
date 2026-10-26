import { appendFile, lstat, mkdir } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { type ExecHost, type ExecResult, hostExec, LOCAL_HOST } from "@orc/core/exec-host";

export type GitResult = ExecResult;

export type GitRunner = (argv: string[]) => Promise<GitResult>;

export interface SessionDirDeps {
  isDirectory: (path: string) => boolean | Promise<boolean>;
  home: string;
  runGit: GitRunner;
  makeDirectory: (path: string) => unknown;
  newId: () => string;
  validateDirectory?: (path: string) => unknown;
  /** Prepares `<root>/.orc/worktrees/` before git adds a worktree there. */
  excludeWorktrees: (root: string) => unknown;
}

export interface SessionDirRequest {
  cwd?: string | null | undefined;
  worktree?: boolean | undefined;
}

export function gitRunner(host: ExecHost): GitRunner {
  return (argv) =>
    hostExec(host, argv, {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 30_000,
    });
}

export const runGit: GitRunner = gitRunner(LOCAL_HOST);

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

/** Agent worktrees live inside their repository so they stay with it: `<root>/.orc/worktrees/<id>`. */
export function worktreePath(root: string, id: string): string {
  return (root.startsWith("/") ? posix : win32).join(root, ".orc", "worktrees", id);
}

// Remote hosts check for symlinks and append the exclusion in one step; the
// exclusion text travels in the JSON payload so nothing in it needs escaping.
export const REMOTE_EXCLUDE_SCRIPT = `import json, os, sys
d = json.load(sys.stdin)
for path in [os.path.join(d['root'], '.orc'), os.path.join(d['root'], '.orc', 'worktrees'), d['path']]:
    if os.path.islink(path): sys.exit(3)
os.makedirs(os.path.dirname(d['path']), exist_ok=True)
if d['content']:
    with open(d['path'], 'a', encoding='utf-8', newline='') as f: f.write(d['content'])
`;

/** Keeps `<root>/.orc/worktrees/` out of the main checkout's status without touching .gitignore. */
export async function excludeOrcWorktrees(host: ExecHost, root: string): Promise<void> {
  const run = gitRunner(host);
  const paths = host.kind === "ssh" || root.startsWith("/") ? posix : win32;
  const tracked = await run(["git", "-C", root, "ls-files", "--", ".orc/worktrees"]);
  if (tracked.code !== 0 || tracked.stdout.trim())
    throw new ConflictError("The .orc/worktrees folder contains tracked files");
  const exclusion = await run(["git", "-C", root, "rev-parse", "--git-path", "info/exclude"]);
  if (exclusion.code !== 0) throw gitError(exclusion, "Could not locate Git worktree exclusions");
  const path = paths.resolve(root, exclusion.stdout.trim());
  const ignored = await run([
    "git",
    "-C",
    root,
    "check-ignore",
    "--no-index",
    ".orc/worktrees/probe",
  ]);
  const content = ignored.code === 0 ? "" : "\n/.orc/worktrees/\n";
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
        throw new ConflictError(
          "The .orc/worktrees folder must not redirect through symbolic links",
        );
    }
    await mkdir(paths.dirname(path), { recursive: true });
    if (content) await appendFile(path, content);
    return;
  }
  const result = await hostExec(host, ["python3", "-c", REMOTE_EXCLUDE_SCRIPT], {
    input: JSON.stringify({ root, path, content }),
    timeoutMs: 30_000,
    login: false,
  });
  if (result.code !== 0)
    throw new ConflictError("Could not safely prepare the .orc/worktrees folder");
}

export async function prepareSessionDirectory(
  req: SessionDirRequest,
  deps: SessionDirDeps,
): Promise<string> {
  const cwd = req.cwd?.trim();
  if (!cwd) return deps.home;
  if (!(await deps.isDirectory(cwd))) throw new ValidationError(`cwd is not a directory: ${cwd}`);
  if (!req.worktree) return cwd;

  const root = await repoRoot(cwd, deps.runGit);
  if (!root) return cwd;

  const id = deps.newId();
  const path = worktreePath(root, id);
  await deps.validateDirectory?.(path);
  await deps.excludeWorktrees(root);
  await deps.makeDirectory(dirname(path));
  const added = await deps.runGit(["git", "-C", root, "worktree", "add", "-b", `orc/${id}`, path]);
  if (added.code !== 0) throw gitError(added, "git worktree add failed");
  return path;
}
